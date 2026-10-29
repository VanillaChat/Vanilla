use std::{
    io,
    time::{Duration, Instant},
};

use crossterm::{
    event::{self, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};

#[path = "../metrics_types.rs"]
mod metrics_types;
#[path = "../monitor.rs"]
mod monitor;

use monitor::{App, Snapshot, collect_snapshot, handle_key, read_env, render};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let snapshot = collect_snapshot().await.unwrap_or_else(|e| {
        let mut snapshot = Snapshot::default();
        snapshot.last_error = Some(e.to_string());
        snapshot.env = read_env();
        snapshot
    });

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = run_app(&mut terminal, App::new(snapshot)).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    mut app: App,
) -> anyhow::Result<()> {
    let mut last_refresh = Instant::now();

    loop {
        terminal.draw(|frame| render(frame, &app))?;

        if app.should_quit {
            return Ok(());
        }

        if last_refresh.elapsed() >= Duration::from_secs(5) {
            match collect_snapshot().await {
                Ok(snapshot) => {
                    app.snapshot = snapshot;
                    app.status = "auto-refreshed".to_string();
                }
                Err(e) => app.status = format!("refresh failed: {}", e),
            }
            last_refresh = Instant::now();
        }

        if event::poll(Duration::from_millis(120))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    handle_key(&mut app, key);
                    if app.status == "refresh requested" {
                        match collect_snapshot().await {
                            Ok(snapshot) => {
                                app.snapshot = snapshot;
                                app.status = "refreshed".to_string();
                            }
                            Err(e) => app.status = format!("refresh failed: {}", e),
                        }
                        last_refresh = Instant::now();
                    }
                }
            }
        }
    }
}
