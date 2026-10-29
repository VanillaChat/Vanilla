# Vanilla Desktop

Tauri app that opens the hosted Vanilla client and keeps itself up to date.

## Run in development

1. Start the stack with `scripts/dev.sh --desktop` (backend, Vite and the desktop window).
2. Debug builds open the app directly. To see the startup update window, set `VANILLA_FORCE_SPLASH=1` before starting.
3. To try the update screens in the app: Settings, Advanced, turn on Developer mode, then "Simulate an update".

## Set up updates once

1. Generate a signing key: `bunx tauri signer generate -w ~/.tauri/vanilla.key` (run in `apps/desktop`). Keep the private key and its password safe.
2. In the GitHub repository settings add the secrets `TAURI_SIGNING_PRIVATE_KEY` (contents of the key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Add the repository variable `UPDATER_PUBKEY` (contents of the `.pub` file).
4. Add the repository variable `VANILLA_URL`, the address of the hosted client, for example `https://chat.example.com`.
5. Deploy the frontend to that address first. The app opens `/updater` from it, and a build is useless until it is there.

## Release a version

1. Raise `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Push a tag: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. The Desktop workflow builds Linux (x86_64, arm64) and Windows and creates a draft release with `latest.json`.
4. Write the changelog in the release description. It is what users see under "What is new".
5. Publish the draft. Installed apps only see releases that are published.

## Build locally

1. Set `VANILLA_URL` to the hosted client address.
2. Optional, to test updating: set `VANILLA_UPDATE_URL` and `VANILLA_UPDATE_PUBKEY`. Without them the startup window still shows briefly and then opens the app.
3. Run `bun run build` in `apps/desktop`. Release builds need `VANILLA_URL` and fail without it.
