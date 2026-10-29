# Vanilla

Vanilla Monorepo

## Deploy

### 1. Server requirements

1. PostgreSQL and Redis (or Valkey).
2. A reverse proxy with HTTPS (nginx, Caddy). HTTPS is required: in production the session cookie is `__Host-Token`, which browsers only keep over HTTPS.
3. Rust, Bun, `wasm-bindgen-cli` and the `wasm32-unknown-unknown` target on the machine that builds.

### 2. Database

1. Create an empty PostgreSQL database.
2. In `apps/backend`, copy `template.env` to `.env` and fill in `DATABASE_URL`, `REDIS_URL` and `TOKEN_SECRET` (a long random string).
3. Run `byteorm push` in `apps/backend` to create the tables. Run it again after every release that changes `byteorm/vanilla.bo`.

### 3. Backend

1. Set in `apps/backend/.env`:
   - `NODE_ENV=production`
   - `CORS_ALLOWED_ORIGINS=https://beta.vanilla.ovh`
   - `PUBLIC_URL=https://beta.vanilla.ovh`
   - `REGISTRATION_CLOSED=1` (invite codes only, see step 6)
   - `LINK_PREVIEWS=0` (keep it off unless you accept that link sites see the server IP)
2. Build: `cargo build --release -p vanilla-backend`.
3. Run `target/release/vanilla-backend` from `apps/backend`, so that `.env` and the `cdn/` upload folder are found there. Keep `cdn/` on persistent storage and back it up.
4. The backend listens on port 3000 (`PORT` changes it). Run it as a service (systemd) so it restarts.

### 4. Frontend

1. Build: `bun install && bun run build` in `apps/frontend`. The result is the static folder `apps/frontend/dist`.
2. Serve `dist` from the proxy at `https://beta.vanilla.ovh`, with every unknown path falling back to `index.html`.

### 5. Reverse proxy

Send these paths to the backend (port 3000) and everything else to `dist`:

`/auth`, `/guilds`, `/channels`, `/users`, `/invites`, `/admin`, `/cdn`, `/unfurl`, `/dms`, `/friends`, `/search`, `/attachments`, `/i/`, `/voice`, `/gateway`.

`/gateway` and the voice media socket are WebSockets, so the proxy must pass `Upgrade` headers. Send `Host` and `X-Forwarded-Proto` through, so invite link previews get the right address.

### 6. First account

1. Create invite codes with the admin endpoints (`POST /admin/invite-codes`), or temporarily set `REGISTRATION_CLOSED=0` to register the first account.
2. Set it back to `1`.

### 7. Desktop app and updates

See [`apps/desktop/README.md`](apps/desktop/README.md). Short version:

1. Generate a signing key with `bunx tauri signer generate -w ~/.tauri/vanilla.key` in `apps/desktop`.
2. In the GitHub repository add the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the variables `UPDATER_PUBKEY` (the `.pub` file) and `VANILLA_URL` (`https://beta.vanilla.ovh`).
3. Deploy the frontend first. The desktop app opens `/updater` from it.
4. Push a tag `desktop-v0.1.0`, write the changelog in the draft release and publish it.
