//! Dev supervisor: backend, frontend, a `byteorm push` runner and vanilla-tui in tabs, each in its own PTY.
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, bail};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

#[path = "../../../apps/backend/src/metrics_types.rs"]
mod metrics_types;
#[allow(dead_code)]
#[path = "../../../apps/backend/src/monitor.rs"]
mod monitor;

use monitor::{InputMode, View};

const PORTS: [u16; 2] = [3000, 5173];
const BACKEND: usize = 0;
const DB: usize = 2;
const SCROLLBACK: usize = 10_000;

struct Spec {
    name: &'static str,
    cwd: PathBuf,
    program: &'static str,
    args: &'static [&'static str],
    watch_dirs: &'static [&'static str],
    watch_files: &'static [&'static str],
    /// A one-shot (such as a migration) that runs only when asked: never at startup or
    /// on "restart all".
    on_demand: bool,
}

impl Spec {
    fn matches(&self, path: &Path) -> bool {
        if self
            .watch_dirs
            .iter()
            .any(|d| path.starts_with(self.cwd.join(d)))
        {
            return true;
        }
        path.parent() == Some(self.cwd.as_path())
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| self.watch_files.contains(&n))
    }
}

struct Proc {
    spec: Spec,
    parser: Arc<Mutex<vt100::Parser>>,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    exit: Option<u32>,
    stopped: bool,
    hot: bool,
    scroll: usize,
    restart_at: Option<Instant>,
    starts: u32,
}

impl Proc {
    fn new(spec: Spec, rows: u16, cols: u16) -> Self {
        Self {
            spec,
            parser: Arc::new(Mutex::new(vt100::Parser::new(rows, cols, SCROLLBACK))),
            master: None,
            child: None,
            exit: None,
            stopped: false,
            hot: false,
            scroll: 0,
            restart_at: None,
            starts: 0,
        }
    }

    fn note(&self, msg: &str) {
        let line = format!("\r\n\x1b[1;36m[dev] {msg}\x1b[0m\r\n");
        self.parser.lock().unwrap().process(line.as_bytes());
    }

    fn start(&mut self, rows: u16, cols: u16) -> anyhow::Result<()> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = CommandBuilder::new(self.spec.program);
        cmd.args(self.spec.args);
        cmd.cwd(&self.spec.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("FORCE_COLOR", "1");
        cmd.env("CARGO_TERM_COLOR", "always");
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        self.master = Some(pair.master);
        self.child = Some(child);
        self.exit = None;
        self.stopped = false;
        self.starts += 1;
        self.parser.lock().unwrap().set_size(rows, cols);

        let parser = self.parser.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => parser.lock().unwrap().process(&buf[..n]),
                }
            }
        });
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.process_id() {
                let pgid = pid as i32;
                unsafe { libc::kill(-pgid, libc::SIGTERM) };
                let deadline = Instant::now() + Duration::from_millis(1500);
                while Instant::now() < deadline {
                    let _ = child.try_wait();
                    if unsafe { libc::kill(-pgid, 0) } != 0 {
                        break;
                    }
                    thread::sleep(Duration::from_millis(30));
                }
                unsafe { libc::kill(-pgid, libc::SIGKILL) };
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.master = None;
    }

    fn restart(&mut self, rows: u16, cols: u16) {
        self.stop();
        self.note("restarting");
        self.restart_at = None;
        if let Err(e) = self.start(rows, cols) {
            self.note(&format!("failed to start: {e}"));
        }
    }

    fn toggle_stop(&mut self, rows: u16, cols: u16) {
        if self.child.is_some() {
            self.stop();
            self.stopped = true;
            self.note("stopped");
        } else {
            self.note("starting");
            if let Err(e) = self.start(rows, cols) {
                self.note(&format!("failed to start: {e}"));
            }
        }
    }

    fn poll(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if let Ok(Some(status)) = child.try_wait() {
            self.exit = Some(status.exit_code());
            self.child = None;
            self.master = None;
            self.note(&format!("exited with code {}", status.exit_code()));
        }
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        if let Some(m) = &self.master {
            let _ = m.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        self.parser.lock().unwrap().set_size(rows, cols);
    }

    fn state(&self) -> (&'static str, Color) {
        if self.child.is_some() {
            ("●", Color::Green)
        } else if self.stopped {
            ("○", Color::DarkGray)
        } else if self.exit == Some(0) {
            ("✔", Color::Green)
        } else if self.exit.is_some() {
            ("✖", Color::Red)
        } else {
            ("…", Color::Yellow)
        }
    }
}

struct App {
    procs: Vec<Proc>,
    monitor: monitor::App,
    refresh: mpsc::Sender<()>,
    sel: usize,
    size: (u16, u16),
    quit: bool,
    push_pending: bool,
}

impl App {
    fn tab_count(&self) -> usize {
        self.procs.len() + View::ALL.len()
    }

    fn select(&mut self, i: usize) {
        if i >= self.tab_count() {
            return;
        }
        self.sel = i;
        if let Some(view) = i.checked_sub(self.procs.len()).map(|v| View::ALL[v]) {
            if self.monitor.view != view {
                self.monitor.view = view;
                self.monitor.selected = 0;
            }
        }
    }

    fn follow_monitor_view(&mut self) {
        if self.sel >= self.procs.len() {
            if let Some(i) = View::ALL.iter().position(|v| *v == self.monitor.view) {
                self.sel = self.procs.len() + i;
            }
        }
    }

    fn request_refresh(&mut self) {
        self.monitor.status = "refreshing".to_string();
        let _ = self.refresh.send(());
    }

    /// Pushes the schema to the database. The client it regenerates only takes effect
    /// once the backend is rebuilt, so a successful push restarts the backend.
    fn migrate(&mut self) {
        if self.procs[DB].child.is_some() {
            return;
        }
        let (r, c) = self.size;
        self.select(DB);
        let db = &mut self.procs[DB];
        db.scroll = 0;
        db.restart(r, c);
        self.push_pending = self.procs[DB].child.is_some();
    }

    fn finish_push(&mut self) {
        if !self.push_pending || self.procs[DB].exit.is_none() {
            return;
        }
        self.push_pending = false;
        if self.procs[DB].exit == Some(0) {
            let (r, c) = self.size;
            self.procs[BACKEND].note("schema pushed");
            self.procs[BACKEND].restart(r, c);
        }
    }

    fn restart_all(&mut self) {
        let (r, c) = self.size;
        for p in self.procs.iter_mut().filter(|p| !p.spec.on_demand) {
            p.stop();
        }
        for p in self.procs.iter_mut().filter(|p| !p.spec.on_demand) {
            p.note("restarting");
            p.restart_at = None;
            if let Err(e) = p.start(r, c) {
                p.note(&format!("failed to start: {e}"));
            }
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        for p in &mut self.procs {
            p.stop();
        }
    }
}

fn body_size(w: u16, h: u16) -> (u16, u16) {
    (h.saturating_sub(2).max(1), w.max(1))
}

fn free_ports(root: &Path) -> anyhow::Result<()> {
    for port in PORTS {
        let out = Command::new("ss")
            .args(["-ltnpH", &format!("sport = :{port}")])
            .output()
            .context("running ss")?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut pids: Vec<i32> = text
            .split("pid=")
            .skip(1)
            .filter_map(|s| s.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok())
            .collect();
        pids.sort_unstable();
        pids.dedup();
        for pid in pids {
            let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap_or_default();
            if !cwd.starts_with(root) {
                bail!(
                    "port {port} is held by pid {pid} ({}), not part of this project",
                    cwd.display()
                );
            }
            eprintln!("[dev] killing old process {pid} on port {port}");
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent) {
    if key.kind == KeyEventKind::Release {
        return;
    }
    let (rows, cols) = app.size;
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let n = app.tab_count();
    let on_proc = app.sel < app.procs.len();

    if !on_proc && !alt && app.monitor.mode != InputMode::Normal {
        if ctrl && key.code == KeyCode::Char('c') {
            app.quit = true;
        } else {
            monitor::handle_key(&mut app.monitor, key);
            app.follow_monitor_view();
            if app.monitor.status == "refresh requested" {
                app.request_refresh();
            }
        }
        return;
    }

    let page = (rows / 2).max(1) as usize;
    match key.code {
        KeyCode::Char('q') => app.quit = true,
        KeyCode::Char('c') if ctrl => app.quit = true,
        KeyCode::Char(c @ '1'..='9') => app.select(c as usize - '1' as usize),
        KeyCode::Left => app.select((app.sel + n - 1) % n),
        KeyCode::Right => app.select((app.sel + 1) % n),
        KeyCode::Tab => app.select((app.sel + 1) % n),
        KeyCode::BackTab => app.select((app.sel + n - 1) % n),
        KeyCode::Char('a') => app.restart_all(),
        KeyCode::Char('m') => app.migrate(),
        KeyCode::Char('r') if app.sel == DB => app.migrate(),
        KeyCode::Char('r') if on_proc => app.procs[app.sel].restart(rows, cols),
        KeyCode::Char('r') => app.request_refresh(),
        KeyCode::Char('s') if on_proc => app.procs[app.sel].toggle_stop(rows, cols),
        KeyCode::Char('h') if on_proc => {
            let p = &mut app.procs[app.sel];
            p.hot = !p.hot;
            p.restart_at = None;
        }
        KeyCode::PageUp if on_proc => {
            let p = &mut app.procs[app.sel];
            p.scroll = p.scroll.saturating_add(page);
        }
        KeyCode::PageDown if on_proc => {
            let p = &mut app.procs[app.sel];
            p.scroll = p.scroll.saturating_sub(page);
        }
        KeyCode::Up if on_proc => {
            let p = &mut app.procs[app.sel];
            p.scroll = p.scroll.saturating_add(1);
        }
        KeyCode::Down if on_proc => {
            let p = &mut app.procs[app.sel];
            p.scroll = p.scroll.saturating_sub(1);
        }
        KeyCode::End if on_proc => app.procs[app.sel].scroll = 0,
        KeyCode::Char('/') | KeyCode::Char(':') | KeyCode::Up | KeyCode::Down if !on_proc => {
            monitor::handle_key(&mut app.monitor, key);
        }
        _ => {}
    }
}

fn map_color(c: vt100::Color) -> Option<Color> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(Color::Indexed(i)),
        vt100::Color::Rgb(r, g, b) => Some(Color::Rgb(r, g, b)),
    }
}

fn render_screen(buf: &mut Buffer, area: Rect, screen: &vt100::Screen) {
    let (srows, scols) = screen.size();
    for r in 0..area.height.min(srows) {
        for c in 0..area.width.min(scols) {
            let Some(cell) = screen.cell(r, c) else {
                continue;
            };
            if cell.is_wide_continuation() {
                continue;
            }
            let mut style = Style::default();
            if let Some(fg) = map_color(cell.fgcolor()) {
                style = style.fg(fg);
            }
            if let Some(bg) = map_color(cell.bgcolor()) {
                style = style.bg(bg);
            }
            if cell.bold() {
                style = style.add_modifier(Modifier::BOLD);
            }
            if cell.italic() {
                style = style.add_modifier(Modifier::ITALIC);
            }
            if cell.underline() {
                style = style.add_modifier(Modifier::UNDERLINED);
            }
            if cell.inverse() {
                style = style.add_modifier(Modifier::REVERSED);
            }
            let text = cell.contents();
            let out = &mut buf[(area.x + c, area.y + r)];
            out.set_symbol(if text.is_empty() { " " } else { &text });
            out.set_style(style);
        }
    }
}

fn ui(f: &mut Frame, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(f.area());

    let mut tabs: Vec<Span> = Vec::new();
    let tab_style = |i: usize| {
        if i == app.sel {
            Style::new()
                .bg(Color::Rgb(60, 60, 90))
                .fg(Color::White)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(Color::Gray)
        }
    };
    for (i, p) in app.procs.iter().enumerate() {
        let (sym, color) = p.state();
        let base = tab_style(i);
        tabs.push(Span::styled(format!(" {} {} ", i + 1, p.spec.name), base));
        tabs.push(Span::styled(sym, base.fg(color)));
        if p.hot {
            tabs.push(Span::styled(" ⟳hot", base.fg(Color::Yellow)));
        }
        tabs.push(Span::styled(" ", base));
    }
    tabs.push(Span::styled(" │", Style::new().fg(Color::DarkGray)));
    for (j, view) in View::ALL.iter().enumerate() {
        let i = app.procs.len() + j;
        tabs.push(Span::styled(
            format!(" {} {} ", i + 1, view.title()),
            tab_style(i),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(tabs)), chunks[0]);

    let body = chunks[1];
    let footer = if app.sel < app.procs.len() {
        let p = &mut app.procs[app.sel];
        {
            let mut parser = p.parser.lock().unwrap();
            parser.set_scrollback(p.scroll);
            p.scroll = parser.screen().scrollback();
            render_screen(f.buffer_mut(), body, parser.screen());
        }
        let hot = if p.hot { "on" } else { "off" };
        let help = format!(
            " 1-9/←→ tab · r restart · a restart all · m byteorm push · h hot-reload [{hot}] · s stop/start · PgUp/PgDn/↑↓ scroll · q quit"
        );
        if p.scroll > 0 {
            (
                format!(" SCROLLBACK -{} (End = live) ·{help}", p.scroll),
                Color::DarkGray,
            )
        } else {
            (help, Color::DarkGray)
        }
    } else {
        monitor::render_view(f, body, &app.monitor);
        let (line, color) = app.monitor.input_line();
        let hint = if app.monitor.mode == InputMode::Normal {
            "  ·  / search · : command · r refresh · m byteorm push · ↑↓ select · q quit"
        } else {
            ""
        };
        (format!(" {line}{hint}"), color)
    };
    f.render_widget(
        Paragraph::new(footer.0).style(Style::new().fg(footer.1)),
        chunks[2],
    );
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    fs_events: mpsc::Receiver<PathBuf>,
    snapshots: mpsc::Receiver<Result<monitor::Snapshot, String>>,
) -> anyhow::Result<()> {
    while !app.quit {
        terminal.draw(|f| ui(f, app))?;

        if event::poll(Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(k) => handle_key(app, k),
                Event::Resize(w, h) => {
                    app.size = body_size(w, h);
                    let (r, c) = app.size;
                    for p in &mut app.procs {
                        p.resize(r, c);
                    }
                }
                _ => {}
            }
        }

        while let Ok(result) = snapshots.try_recv() {
            match result {
                Ok(snapshot) => {
                    app.monitor.snapshot = snapshot;
                    app.monitor.status = "refreshed".to_string();
                }
                Err(e) => app.monitor.status = format!("refresh failed: {e}"),
            }
        }

        while let Ok(path) = fs_events.try_recv() {
            for p in &mut app.procs {
                if p.hot && p.spec.matches(&path) {
                    p.restart_at = Some(Instant::now() + Duration::from_millis(500));
                }
            }
        }

        let (r, c) = app.size;
        let now = Instant::now();
        for p in &mut app.procs {
            p.poll();
            if p.restart_at.is_some_and(|t| t <= now) {
                p.note("source changed");
                p.restart(r, c);
            }
        }
        app.finish_push();
    }
    Ok(())
}

fn spawn_monitor_worker(tx: mpsc::Sender<Result<monitor::Snapshot, String>>) -> mpsc::Sender<()> {
    let (poke_tx, poke_rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        loop {
            let result = rt
                .block_on(monitor::collect_snapshot())
                .map_err(|e| e.to_string());
            if tx.send(result).is_err() {
                break;
            }
            if let Err(mpsc::RecvTimeoutError::Disconnected) =
                poke_rx.recv_timeout(Duration::from_secs(5))
            {
                break;
            }
        }
    });
    poke_tx
}

fn main() -> anyhow::Result<()> {
    let root = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir()?,
    }
    .canonicalize()?;
    let backend = root.join("apps/backend");
    let frontend = root.join("apps/frontend");
    if !backend.is_dir() || !frontend.is_dir() {
        bail!(
            "expected apps/backend/ and apps/frontend/ in {}",
            root.display()
        );
    }

    free_ports(&root)?;
    dotenvy::from_path(backend.join(".env")).ok();

    let (w, h) = crossterm::terminal::size()?;
    let (rows, cols) = body_size(w, h);

    let desktop = std::env::args().any(|a| a == "--desktop");
    let mut specs = vec![
        Spec {
            name: "Backend",
            cwd: backend.clone(),
            program: "cargo",
            args: &["run", "--bin", "vanilla-backend"],
            watch_dirs: &["src", "byteorm"],
            watch_files: &["Cargo.toml", "Cargo.lock", ".env"],
            on_demand: false,
        },
        Spec {
            name: "Frontend",
            cwd: frontend.clone(),
            program: "bunx",
            args: &["vite", "--port", "5173", "--strictPort"],
            watch_dirs: &[],
            watch_files: &["vite.config.js", "package.json", ".env", ".env.local"],
            on_demand: false,
        },
        Spec {
            name: "DB",
            cwd: backend.clone(),
            program: "byteorm",
            args: &["push"],
            watch_dirs: &[],
            watch_files: &[],
            on_demand: true,
        },
    ];

    if desktop {
        specs.push(Spec {
            name: "Desktop",
            cwd: root.join("apps/desktop"),
            program: "bun",
            args: &["run", "dev"],
            watch_dirs: &[],
            watch_files: &[],
            on_demand: false,
        });
    }

    let (snap_tx, snap_rx) = mpsc::channel();
    let refresh = spawn_monitor_worker(snap_tx);
    let mut initial = monitor::Snapshot::default();
    initial.env = monitor::read_env();

    let mut app = App {
        procs: specs
            .into_iter()
            .map(|s| Proc::new(s, rows, cols))
            .collect(),
        monitor: monitor::App::new(initial),
        refresh,
        sel: 0,
        size: (rows, cols),
        quit: false,
        push_pending: false,
    };
    for p in app.procs.iter_mut().filter(|p| p.spec.on_demand) {
        p.stopped = true;
        p.note("press m to run it");
    }

    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for path in ev.paths {
                let _ = tx.send(path);
            }
        }
    })?;
    {
        use notify::{RecursiveMode, Watcher};
        for p in &app.procs {
            for d in p.spec.watch_dirs {
                let _ = watcher.watch(&p.spec.cwd.join(d), RecursiveMode::Recursive);
            }
            if !p.spec.watch_files.is_empty() {
                let _ = watcher.watch(&p.spec.cwd, RecursiveMode::NonRecursive);
            }
        }
    }

    for p in app.procs.iter_mut().filter(|p| !p.spec.on_demand) {
        if let Err(e) = p.start(rows, cols) {
            p.note(&format!("failed to start: {e}"));
        }
    }

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let result = run(&mut terminal, &mut app, rx, snap_rx);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    drop(app);
    result
}
