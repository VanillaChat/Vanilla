use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Both come from the release build; without them the app never looks for updates.
const UPDATE_URL: Option<&str> = option_env!("VANILLA_UPDATE_URL");
const UPDATE_PUBKEY: Option<&str> = option_env!("VANILLA_UPDATE_PUBKEY");

pub fn enabled() -> bool {
    !cfg!(debug_assertions) && UPDATE_URL.is_some() && UPDATE_PUBKEY.is_some()
}

/// Release builds always open the startup window first, like a launcher: it checks, and
/// when there is nothing to install it just opens the app. Debug builds skip it unless
/// `VANILLA_FORCE_SPLASH=1`, so it can be looked at while developing.
pub fn splash_wanted() -> bool {
    !cfg!(debug_assertions) || std::env::var("VANILLA_FORCE_SPLASH").is_ok_and(|v| v == "1")
}

#[derive(Clone, Serialize, Default)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    #[default]
    Idle,
    Checking,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        version: String,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
struct Inner {
    status: Status,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Inner>);

impl UpdateState {
    fn set(&self, status: Status) {
        self.0.lock().unwrap().status = status;
    }
}

/// True while an update is downloading or waiting to be installed.
pub fn is_busy(app: &AppHandle) -> bool {
    matches!(
        app.state::<UpdateState>().0.lock().unwrap().status,
        Status::Downloading { .. } | Status::Ready { .. }
    )
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn update_status(state: State<UpdateState>) -> Status {
    state.0.lock().unwrap().status.clone()
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Status, String> {
    if !enabled() {
        return Ok(Status::UpToDate);
    }
    {
        let mut inner = state.0.lock().unwrap();
        if matches!(
            inner.status,
            Status::Checking | Status::Downloading { .. } | Status::Ready { .. }
        ) {
            return Ok(inner.status.clone());
        }
        inner.status = Status::Checking;
    }
    match check(&app).await {
        Ok(Some(update)) => {
            let status = Status::Available {
                version: update.version.clone(),
                notes: update.body.clone(),
            };
            let mut inner = state.0.lock().unwrap();
            inner.update = Some(update);
            inner.status = status.clone();
            Ok(status)
        }
        Ok(None) => {
            state.set(Status::UpToDate);
            Ok(Status::UpToDate)
        }
        Err(message) => {
            state.set(Status::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let (Some(url), Some(key)) = (UPDATE_URL, UPDATE_PUBKEY) else {
        return Ok(None);
    };
    let url: tauri::Url = url.parse().map_err(|e| format!("{e}"))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .pubkey(key)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Returns at once; the page polls `update_status` for progress.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<UpdateState>) -> Result<(), String> {
    let update = {
        let mut inner = state.0.lock().unwrap();
        if !matches!(inner.status, Status::Available { .. }) {
            return Ok(());
        }
        let update = inner.update.clone().ok_or("no update")?;
        inner.status = Status::Downloading {
            version: update.version.clone(),
            downloaded: 0,
            total: None,
        };
        update
    };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<UpdateState>();
        let version = update.version.clone();
        let mut downloaded = 0u64;
        let result = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    state.set(Status::Downloading {
                        version: version.clone(),
                        downloaded,
                        total,
                    });
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                let mut inner = state.0.lock().unwrap();
                inner.bytes = Some(bytes);
                inner.status = Status::Ready { version };
            }
            Err(e) => state.set(Status::Error {
                message: e.to_string(),
            }),
        }
    });
    Ok(())
}

#[tauri::command]
pub fn update_apply(app: AppHandle, state: State<UpdateState>) -> Result<(), String> {
    let (update, bytes) = {
        let inner = state.0.lock().unwrap();
        (
            inner.update.clone().ok_or("no update")?,
            inner.bytes.clone().ok_or("update not downloaded")?,
        )
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}
