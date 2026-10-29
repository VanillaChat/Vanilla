# Invite link previews

Invite links shared from the app look like `https://<your host>/i/<code>`. That address is served
by the backend (`GET /i/{code}`) as plain HTML, because link crawlers do not run the client app.

The page carries:

- a Discord [component embed](https://docs.discord.com/developers/link-previews/component-embeds)
  (`<script id="discord:component-embed">`, under 3,000 bytes) with the server name, description,
  member count, thumbnail and a "Join server" button;
- Open Graph and Twitter tags as the fallback for other chat apps;
- a redirect for people, to `/invite/<code>` in the app.

The thumbnail is the server icon. A server without one gets its default picture, drawn as a PNG by
`GET /i/{code}/icon.png` (crawlers do not accept SVG).

The links the app already handed out, `/invite/<code>`, keep working but show no preview.

## Routing

Whatever serves the client in front of the backend must send `/i/*` to the backend, the same way
it already does for `/guilds`, `/invites` and the other API paths. The dev server does this with
the `^/i/` rule in `apps/frontend/vite.config.js`. The page builds its absolute URLs from `X-Forwarded-Host` / `Host` and `X-Forwarded-Proto`, so the
proxy has to pass them on (the dev rule sets `xfwd`). When it cannot, set `PUBLIC_URL` in the
backend `.env`.
