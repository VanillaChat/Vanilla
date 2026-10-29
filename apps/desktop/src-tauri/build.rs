use std::{env, fs};

/// The app's own commands. Declared here so each gets an `allow-*` permission; without that
/// the page loaded from the hosted client is refused ("not allowed by ACL").
const COMMANDS: &[&str] = &[
    "set_presence",
    "clear_presence",
    "start_app",
    "reveal",
    "app_version",
    "update_status",
    "update_check",
    "update_install",
    "update_apply",
];

const PERMISSIONS: &[&str] = &[
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
];

fn main() {
    println!("cargo:rerun-if-env-changed=VANILLA_URL");
    println!("cargo:rerun-if-env-changed=VANILLA_UPDATE_URL");
    println!("cargo:rerun-if-env-changed=VANILLA_UPDATE_PUBKEY");
    // Release builds load a hosted client; its origin is only known at build time, so the
    // capability that lets that page use the app's commands is generated here.
    let url = env::var("VANILLA_URL")
        .ok()
        .map(|u| u.trim_end_matches('/').to_owned());
    if env::var("PROFILE").is_ok_and(|p| p == "release") && url.is_none() {
        panic!(
            "set VANILLA_URL to the address of the hosted client, e.g. https://chat.example.com"
        );
    }
    let mut urls: Vec<String> = url.iter().map(|u| format!("{u}/*")).collect();
    // Debug builds load the local dev server; a release build must not trust it.
    if env::var("PROFILE").is_ok_and(|p| p != "release") {
        urls.push("http://localhost:5173/*".to_owned());
    }
    let mut permissions: Vec<String> = PERMISSIONS.iter().map(|p| (*p).to_owned()).collect();
    permissions.extend(
        COMMANDS
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-"))),
    );
    let capability = serde_json::json!({
        "identifier": "default",
        "description": "Presence commands and title bar controls for the page the window loads.",
        "windows": ["main", "updater"],
        "remote": { "urls": urls },
        "permissions": permissions,
    });
    // `tauri dev` rebuilds when this file changes, so only touch it when the content does.
    let path = "capabilities/default.json";
    let json = serde_json::to_string_pretty(&capability).unwrap();
    if fs::read_to_string(path).ok().as_deref() != Some(json.as_str()) {
        // The file is not committed, so a fresh checkout has no folder for it either.
        fs::create_dir_all("capabilities").unwrap();
        fs::write(path, json).unwrap();
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri build script");
}
