use std::sync::Mutex;

use discord_rich_presence::{DiscordIpc, DiscordIpcClient, activity};
use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod updater;

const DISCORD_APP_ID: &str = "1565358339909484624";

#[derive(Default)]
struct Presence(Mutex<Option<DiscordIpcClient>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    details: String,
    state: Option<String>,
    started_at: Option<i64>,
}

/// Errors (Discord not running) are returned to the page and retried on the next update.
#[tauri::command]
fn set_presence(presence: tauri::State<Presence>, activity: Activity) -> Result<(), String> {
    let mut slot = presence.0.lock().map_err(|e| e.to_string())?;
    if slot.is_none() {
        let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
        client.connect().map_err(|e| e.to_string())?;
        *slot = Some(client);
    }
    let client = slot.as_mut().ok_or("no client")?;

    let mut a = activity::Activity::new()
        .details(activity.details.as_str())
        .assets(
            activity::Assets::new()
                .large_image("vanilla")
                .large_text("Vanilla"),
        );
    if let Some(state) = activity.state.as_deref() {
        a = a.state(state);
    }
    if let Some(start) = activity.started_at {
        a = a.timestamps(activity::Timestamps::new().start(start));
    }
    if let Err(e) = client.set_activity(a) {
        // Discord was closed or restarted: reconnect on the next update.
        *slot = None;
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
fn clear_presence(presence: tauri::State<Presence>) -> Result<(), String> {
    let mut slot = presence.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut client) = slot.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    Ok(())
}

/// WebKitGTK refuses microphone and camera requests unless the host app answers them, so
/// voice chat would be "blocked" here. Only those requests are allowed; anything else keeps
/// WebKit's default (deny). Other platforms ask the user themselves.
#[cfg(target_os = "linux")]
fn allow_microphone(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webkit2gtk::glib::ObjectExt;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};

    window.with_webview(|webview| {
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();
                return true;
            }
            false
        });
    })
}

#[cfg(not(target_os = "linux"))]
fn allow_microphone(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

async fn sleep_secs(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs))
    })
    .await;
}

/// Windows start hidden so the empty white webview is never on screen; the page asks to be
/// shown once it has painted, and a timer shows it anyway if the page never does.
fn show_when_ready(app: &AppHandle, label: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sleep_secs(4).await;
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
        }
    });
}

#[tauri::command]
fn reveal(window: tauri::WebviewWindow) {
    let _ = window.show();
}

/// Brings the app back: from the tray, or when it is started a second time.
fn show_main(app: &AppHandle) {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("updater"));
    if let Some(window) = window {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Vanilla", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("Vanilla")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn hosted_url() -> &'static str {
    // The hosted client keeps cookies and API on one origin and updates without a new
    // release; a debug build uses the local dev server instead.
    if cfg!(debug_assertions) {
        "http://localhost:5173"
    } else {
        option_env!("VANILLA_URL").unwrap_or_default()
    }
}

fn open_main(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let mut window =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::External(hosted_url().parse()?))
            .title("Vanilla")
            .visible(false)
            .decorations(false);
    if let Some(icon) = app.default_window_icon() {
        window = window.icon(icon.clone())?;
    }
    let window = window
        .inner_size(1280.0, 800.0)
        .min_inner_size(940.0, 600.0)
        .build()?;
    allow_microphone(&window)?;
    show_when_ready(app, "main");
    Ok(())
}

/// Small window that checks for and downloads an update before the main window opens.
fn open_splash(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("{}/updater", hosted_url().trim_end_matches('/'));
    let mut window = WebviewWindowBuilder::new(app, "updater", WebviewUrl::External(url.parse()?))
        .title("Vanilla")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .center();
    if let Some(icon) = app.default_window_icon() {
        window = window.icon(icon.clone())?;
    }
    // Same min and max: tiling compositors (niri, sway) then keep the small size, and
    // treat the window as a dialog, instead of stretching it like a normal window.
    window
        .inner_size(360.0, 440.0)
        .min_inner_size(360.0, 440.0)
        .max_inner_size(360.0, 440.0)
        .build()?;
    show_when_ready(app, "updater");
    Ok(())
}

/// Called by the splash page when it is done: opens the app and closes the splash.
#[tauri::command]
fn start_app(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_none() {
        open_main(&app).map_err(|e| e.to_string())?;
    }
    if let Some(splash) = app.get_webview_window("updater") {
        let _ = splash.close();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first: a second start only brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Presence::default())
        .manage(updater::UpdateState::default())
        .on_window_event(|window, event| {
            // Closing the window keeps the app running in the tray; "Quit" there ends it.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            if updater::splash_wanted() {
                open_splash(app.handle())?;
                // The startup page comes from the hosted client; if it never loads or never
                // finishes, the app must still open.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sleep_secs(20).await;
                    if handle.get_webview_window("main").is_some() || updater::is_busy(&handle) {
                        return;
                    }
                    let _ = start_app(handle);
                });
            } else {
                open_main(app.handle())?;
            }
            // A missing tray (no appindicator, no tray host) must not stop the app from opening.
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("tray unavailable: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_presence,
            clear_presence,
            start_app,
            reveal,
            updater::app_version,
            updater::update_status,
            updater::update_check,
            updater::update_install,
            updater::update_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vanilla desktop");
}
