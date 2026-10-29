# Gateway

Real-time events arrive over a WebSocket at `/gateway`. The HTTP API is described in
[`openapi.json`](openapi.json) (also served at `/openapi.json`); this file covers what
OpenAPI cannot: the socket protocol and the events.

Every frame is JSON: `{ "op": number, "d": any, "t"?: string, "s"?: number }`.

## Lifecycle

1. Connect. The session cookie is read from the upgrade request.
2. Server sends **HELLO** (`op 10`): `{ "heartbeat_interval": 30000 }`.
3. Client sends **IDENTIFY** (`op 2`): `{ "clientSessionId": "<random id, max 128 chars>" }`.
   The id ties a browser tab to its voice session, so closing the tab leaves voice.
4. Server answers with the **READY** dispatch.
5. Client sends **HEARTBEAT** (`op 1`) every `heartbeat_interval` ms and gets **HEARTBEAT_ACK** (`op 11`).

| op | name | direction |
| -- | ---- | --------- |
| 0 | DISPATCH (`t` names the event) | server → client |
| 1 | HEARTBEAT | client → server |
| 2 | IDENTIFY | client → server |
| 3 | PRESENCE_UPDATE request: `{ "status": "ONLINE" \| "IDLE" \| "DND" \| "LOOKING_TO_PLAY", "durationMs"?: number }`; with `durationMs` (1 minute to 7 days) the status ends by itself and falls back to `ONLINE` | client → server |
| 10 | HELLO | server → client |
| 11 | HEARTBEAT_ACK | server → client |

## Dispatch events

Server events are delivered to a *room* (every member of a server) or straight to a user.

| event | recipients | `d` |
| ----- | ---------- | --- |
| `READY` | you | `account`, `settings` (incl. `dmPrivacy`), `appSettings`, `user`, `guilds`, `presences`, `voiceStates`, `users` |
| `MESSAGE_CREATE` / `MESSAGE_UPDATE` | server room, or DM members | a `Message`, with `attachments` when it has files |
| `MESSAGE_DELETE` | server room, or DM members | `{ id, channelId, guildId }` (`guildId` is `""` for DMs) |
| `TYPING_START` | server room, or DM members | `{ channelId, userId, user, timestamp, expiresAt }` |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` | server room | a `Channel` |
| `CHANNEL_DELETE` | server room | `{ id, guildId }` |
| `GUILD_UPDATE` | server room | a `Guild` without `channels`, `members`, `emojis` and `roles` |
| `GUILD_DELETE` | server room | `{ id }` |
| `GUILD_EMOJIS_UPDATE` | server room | `{ guildId, emojis }`: the full custom emoji list of the server |
| `GUILD_ROLES_UPDATE` | server room | `{ guildId, roles }`: the full role list of the server |
| `GUILD_MEMBER_UPDATE` | server room | `{ guildId, userId, roles }`: the role ids the member now holds |
| `GUILD_MEMBER_ADD` | server room | `{ userId, guildId, user, nickname }` |
| `GUILD_MEMBER_REMOVE` | server room | `{ guildId, user }` |
| `PINGS_READ` | the user's own sessions | `{ channelIds }`; the pings of those channels were read elsewhere, `null` means all |
| `USER_UPDATE` | each server of the user, and the user | `{ guildId, user }`; `user` carries `customStatus` and `badges` |
| `PRESENCE_UPDATE` | users sharing a server | `{ userId, status }`; the user's own sessions also get `until` (Unix ms) for a temporary status |
| `VOICE_STATE_UPDATE` | server room | `{ guildId, channelId, userId, voiceState }`; `voiceState` is `null` when the user left |
| `DM_CHANNEL_CREATE` / `DM_CHANNEL_UPDATE` | DM members | a DM channel (`DmChannel` in the OpenAPI spec) |
| `DM_CHANNEL_DELETE` | the user who left | `{ id }` |
| `RELATIONSHIP_ADD` | the two users | `{ user, kind, since }`, `kind` is `FRIEND`, `INCOMING`, `OUTGOING` or `BLOCKED` |
| `RELATIONSHIP_REMOVE` | the two users | `{ userId }` |
| `INVITE_CODE_DELETE` | admins | `{ executor, id }` |

## Voice media socket

`GET /voice/media?channelId=…&clientSessionId=…&socket=audio|video` upgrades to a second
WebSocket for media. Join first with `POST /channels/{id}/voice/join` using the same
`clientSessionId`. Frames are binary packets (see `crates/voice`) plus small JSON control
messages such as `ping`/`pong` and `pli`.
