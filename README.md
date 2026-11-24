# Discord MCP Server

An MCP (Model Context Protocol) server for **building and administering Discord servers** from an AI client — categories, text/voice channels, roles, channel permission overwrites, server settings, messages and AutoMod rules.

It runs over **stdio** and talks to Discord's REST API v10, so it plugs into Claude Desktop, OpenCode, Cursor, or any MCP host. No gateway connection is needed for the tools themselves: every call is one validated REST request, so the server starts instantly and holds no state.

```
MCP client  ──stdio──▶  index.js  ──HTTPS──▶  discord.com/api/v10
                       (22 tools, JSON Schema validation, retries)
```

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Tools (22)](#tools-22)
- [Argument conventions](#argument-conventions)
- [Testing](#testing)
- [Companion scripts](#companion-scripts)
- [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Project layout](#project-layout)
- [Limitations](#limitations)

---

## Features

- **22 tools** covering discovery, categories, channels, permission overwrites, roles, server settings, messaging and AutoMod.
- **Validation before the network.** Every argument is checked (type, range, snowflake format, permission names, colours, message length) by a generic validator driven by each tool's JSON Schema. Unknown tool names and undeclared arguments are rejected locally, so a bad call never reaches Discord.
- **Permission maths done right.** `set_channel_permissions` merges overwrites the way Discord means them: bits named in the call win, the opposite bit is cleared, and the same permission in both `allow` and `deny` is rejected up front.
- **Resilient HTTP.** Up to 3 attempts per request, honours `429` `retry-after` (header or body, capped at 30 s), retries 5xx, and aborts a hung request after 20 s.
- **Readable errors.** Discord's nested `errors` object is flattened to `field: reason` lines and paired with a hint for `401`/`403`/`404`/`429`.
- **Explicit deletes.** Every destructive tool returns `{ "deleted": true, … }` instead of an empty body.
- **No privileged intents.** No Members or Message Content intent, ever — everything is REST with a bot token.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Node.js 18.17+** | `engines` in `package.json`; developed and tested on Node 24.16 |
| A Discord bot token | [Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → Reset Token |
| The bot invited to your server | Administrator is simplest; otherwise grant the permissions listed below |
| Privileged intents | **Not required** |

---

## Setup

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. Keep it secret; treat it as a full-admin credential.
3. Leave the privileged intents (Presence, Server Members, Message Content) **off** — nothing here needs them.

### 2. Invite the bot

**OAuth2 → URL Generator**, scopes `bot` + `applications.commands`, and these bot permissions:

| Permission | Needed for |
|---|---|
| `View Channels` | every read |
| `Manage Channels` | categories, channels, overwrites |
| `Manage Roles` | roles and overwrites — the bot's highest role must sit **above** the roles it edits |
| `Manage Guild` | `edit_guild`, AutoMod |
| `Send Messages` | `send_message` |
| `Manage Messages` | audit helpers |

Open the generated URL and authorise it into your server.

### 3. Install

```bash
git clone https://github.com/<your-user>/discord-mcp.git
cd discord-mcp
npm install
```

### 4. Environment

`index.js` reads the token from the **environment** — it does not parse `.env` itself, so put it in your MCP client config (recommended) or export it in the shell that launches the server.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **yes** | Bot token. The server exits with a clear message if it is missing. |
| `GUILD_ID` | for helper scripts | Guild used by `audit.mjs`, and convenient for clients. Not required by the tools — every tool takes its own `guild_id`. |
| `ALERT_CHANNEL_ID` | for helper scripts | Channel `audit.mjs` posts its report to. |
| `DISCORD_HTTP_TIMEOUT_MS` | no | Per-request timeout in ms, default `20000`. |

`audit.mjs` and `presence.mjs` **do** load `.env` from the project root, so for them:

```bash
cp .env.example .env    # then fill in the values
```

> `.env` is gitignored. Never commit it and never paste the token into an issue.

### 5. Connect an MCP client

**Claude Desktop / generic** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["C:\\path\\to\\discord-mcp\\index.js"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token-here",
        "GUILD_ID": "123456789012345678"
      }
    }
  }
}
```

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "discord": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\discord-mcp\\index.js"],
      "environment": {
        "DISCORD_BOT_TOKEN": "your-bot-token-here",
        "GUILD_ID": "123456789012345678"
      }
    }
  }
}
```

Restart the client and the 22 tools appear in its tool list. Manual smoke test:

```bash
DISCORD_BOT_TOKEN=... node index.js     # logs "discord-mcp: server running on stdio" to stderr
```

Stdout is reserved for the MCP protocol — all logs go to stderr.

### 6. Get IDs

Enable **Developer Mode** (User Settings → Advanced) to right-click servers, channels and roles and **Copy ID**. `list_guilds`, `list_channels` and `list_roles` also return every ID directly, so a model can resolve them itself.

---

## Tools (22)

Every tool validates its arguments against this schema before sending anything. `guild_id`, `channel_id`, `role_id`, `user_id` and `rule_id` are **strings**.

### Discovery

| Tool | Arguments | Returns |
|---|---|---|
| `list_guilds` | — | Every server the bot is in, with IDs |
| `list_channels` | `guild_id` | Every channel: `id`, `name`, `type` (`text`, `voice`, `category`, `announcement`, `forum`, `media`, `stage`, thread types…), `parent_id`, `position` |
| `list_roles` | `guild_id` | Every role: `id`, `name`, `color` (as `#rrggbb`), `hoist`, `mentionable`, `position`, `managed` — sorted highest first |
| `list_permission_names` | — | All 46 accepted permission names |

### Categories

| Tool | Arguments | Notes |
|---|---|---|
| `create_category` | `guild_id`, `name` | Creates a `GUILD_CATEGORY` (type 4) |
| `edit_category` | `channel_id`, `name?`, `position?` | Needs at least one of `name`/`position`; position 0–1000 |
| `delete_category` | `channel_id` | Children are **not** deleted — they only lose their parent |

### Channels

| Tool | Arguments | Notes |
|---|---|---|
| `create_text_channel` | `guild_id`, `name`, `parent_id?`, `topic?`, `nsfw?`, `slowmode?` | Topic ≤ 1024 chars, slowmode 0–21600 s |
| `create_voice_channel` | `guild_id`, `name`, `parent_id?`, `bitrate?`, `user_limit?`, `nsfw?` | Bitrate 8000–384000, user limit 0–99 (0 = unlimited) |
| `edit_channel` | `channel_id` + any of `name`, `topic`, `nsfw`, `slowmode`, `bitrate`, `user_limit`, `parent_id`, `position` | Needs at least one field; text-only and voice-only fields are passed through to Discord |
| `delete_channel` | `channel_id` | Permanent. Works for text, voice and categories |

### Permissions

| Tool | Arguments | Notes |
|---|---|---|
| `set_channel_permissions` | `channel_id`, `target_type` (`role`\|`member`), `target_id`, `allow?`, `deny?`, `mode?` | `mode: "set"` replaces the overwrite; `mode: "update"` (default) merges. Returns the channel with its resulting `permission_overwrites` |
| `remove_channel_permissions` | `channel_id`, `target_id` | Deletes the overwrite entirely; returns the channel |

### Roles

| Tool | Arguments | Notes |
|---|---|---|
| `create_role` | `guild_id`, `name`, `color?`, `permissions?`, `hoist?`, `mentionable?` | Sends `permissions: "0"` when omitted, so a new role really has no permissions |
| `edit_role` | `role_id`, `guild_id?`, `name?`, `color?`, `permissions?`, `hoist?`, `mentionable?` | Needs at least one field. `permissions` **replaces** all permissions |
| `delete_role` | `role_id`, `guild_id?` | Omit `guild_id` and the guild is resolved from the bot's own guild list |
| `set_role_positions` | `guild_id`, `positions` (`[{ role_id, position }]`) | Position 0–1000, highest first; `@everyone` is fixed at 0 and rejected |

### Server

| Tool | Arguments | Notes |
|---|---|---|
| `edit_guild` | `guild_id`, `name?`, `description?` | Name 2–100 chars, description ≤ 300. Icon upload is not supported (needs a file upload) |

### Messaging

| Tool | Arguments | Notes |
|---|---|---|
| `send_message` | `channel_id`, `content` | Non-empty, ≤ 2000 chars. Returns the created message, including its ID |

### AutoMod

| Tool | Arguments | Notes |
|---|---|---|
| `create_automod_rule` | `guild_id`, `name`, `trigger_type` (`keyword`\|`mention_spam`), `keywords?`, `regex_patterns?`, `presets?`, `mention_limit?`, `action?`, `timeout_seconds?`, `alert_channel_id?`, `exempt_roles?`, `exempt_channels?` | See below |
| `list_automod_rules` | `guild_id` | Rules with human-readable trigger and action names |
| `delete_automod_rule` | `guild_id`, `rule_id` | Permanent |

`create_automod_rule` details:

- `trigger_type: "keyword"` needs at least one of `keywords` (≤ 60 chars each, ≤ 1000 per rule), `regex_patterns`, or `presets`.
- `presets` accepts `profanity`, `sexual_content`, `slurs` and **cannot** be combined with `keywords`/`regex_patterns` — Discord rejects that payload, so it is rejected locally.
- `trigger_type: "mention_spam"` uses `mention_limit` (1–100, default 5).
- `action` is `block` (default), `timeout` (uses `timeout_seconds`, 60–2419200, default 300) or `alert` (requires `alert_channel_id`). A `block`/`timeout` rule may also carry `alert_channel_id` to report alongside the action.
- Discord allows only **one** rule per preset trigger type and per mention-spam trigger, so a second one returns a clear `50035` error. That is a Discord limit, not a bug here.

---

## Argument conventions

- **IDs are strings.** Snowflakes are 64-bit; passing them as JSON numbers loses precision.
- **`guild_id` is optional** for `edit_role` and `delete_role`. When omitted, the server looks the role up across the bot's guilds via `/users/@me/guilds`, so `{ role_id, name }` works as documented.
- **Permissions** are friendly comma-separated names: `"ViewChannel, SendMessages, ManageRoles"`. Call `list_permission_names` for the full list. Unknown names are rejected before the request is sent.
- **No permission may be both allowed and denied** in one `set_channel_permissions` call — that is rejected with the offending names.
- **Colours** accept `"#5865F2"` or an integer `0`–`16777215`; anything else is rejected.
- **Numbers** (`position`, `slowmode`, `bitrate`, `user_limit`, `mention_limit`, `timeout_seconds`) are checked for type *and* range.
- **Deletes** return `{ "deleted": true, … }` with the deleted object's identity.

---

## Testing

```bash
npm test            # offline — no token, no network
npm run test:e2e    # live  — needs DISCORD_BOT_TOKEN + GUILD_ID
```

| Suite | What it does |
|---|---|
| `test-smoke.mjs` | Boots the server, performs the real MCP handshake over stdio, and asserts 11 things: `initialize` returns `serverInfo`, `tools/list` returns exactly **22** tools, core tools are present, every tool documents an object schema, `list_permission_names` works, and five invalid inputs (missing / non-numeric `guild_id`, unknown permission, bad colour, unknown tool, undeclared argument) are rejected locally. Exits non-zero on any failure. |
| `test-e2e.mjs` | Drives all 22 tools through a real MCP stdio client against the guild in `.env` — including validation errors, overwrite merging, role editing without `guild_id` and AutoMod payloads — then runs `audit.mjs` and `presence.mjs` for real. It creates objects named `mcp-selftest-*` and deletes them in a `finally` block (also on failure), then verifies the guild is back to its baseline count. Prints `N/M checks passed` and exits non-zero on failure. |

> Run `npm run test:e2e` against a **test server**. It creates and deletes channels, roles and AutoMod rules.

---

## Companion scripts

The MCP server is REST-only, so Discord shows the bot **offline**. These two scripts are optional.

### `presence.mjs` — keep the bot online

```bash
npm run presence
```

Holds a gateway WebSocket with a "Watching over the server" status, so the bot appears online. Login failures retry with exponential backoff (30 s → 15 min) instead of crashing, gateway disconnects/resumes are logged, an invalidated session exits non-zero so a supervisor can restart it, and `SIGINT`/`SIGTERM` shut down cleanly. Reads `.env`.

### `audit.mjs` — server audit

```bash
npm run audit
```

Scans the server for toxic/NSFW/scam content in recent messages, dangerous role permissions, and risky configuration (open invites, webhooks, NSFW channels, AutoMod coverage), then posts a chunked report to `ALERT_CHANNEL_ID` (never splitting a line). Every lookup degrades independently: an endpoint the bot cannot read becomes a `Not checked` note instead of aborting the run, and one unreadable channel does not stop the message scan. Exit codes: `0` clean, `1` could not run, `2` issues found. Reads `.env`.

---

## Error handling

| Discord response | What the caller sees |
|---|---|
| `401` | Error naming the endpoint plus *the bot token is invalid or was reset* |
| `403` | Error plus *the bot lacks a permission, or the target role is above the bot's highest role* |
| `404` | Error plus *the guild, channel or role does not exist, or the bot is not a member* |
| `429` | Waits `retry-after` (header or body, capped at 30 s) and retries; fails after 3 attempts |
| `5xx` (not 501) | Retried with backoff |
| `204` | Returned as `undefined`, never a JSON parse error |
| Network failure / 20 s timeout | Retried 3×, then `METHOD /path failed: …` |

Discord's nested `errors` object is flattened into `field: reason` lines (up to 8), prefixed with `code …` and Discord's message where present. Tool failures come back to the model as `isError: true` with the message, not as a crashed server.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `discord-mcp: DISCORD_BOT_TOKEN environment variable is required` | The token is not in the server's environment. It must be in the client config's `env` block or exported in the launching shell — `index.js` does not read `.env`. |
| `401` | Token wrong, revoked or from a regenerated application. Copy it again from **Bot → Reset Token**. |
| `403 Missing Access` / `Missing Permissions` | The bot lacks the permission, or its highest role is **below** the role/channel it is editing. |
| `404 Unknown Guild` | Wrong `guild_id`, or the bot was never invited to that server. |
| `50035` on AutoMod | Discord permits one rule per preset / mention-spam trigger type. Delete the existing rule or edit it instead. |
| Client shows the server but no tools | Something is writing to stdout. All logs belong on stderr. |
| `fetch failed` intermittently | Transient network/DNS. The client already retries 3×; rerun if it persists. |
| Presence script exits immediately | `invalidated` session — the token was reset. Update `.env`. |

---

## Security

- The bot token can do anything the bot can do. Prefer explicit permissions over `Administrator`.
- `.env` is gitignored; keep it that way and rotate the token on any suspected leak.
- Deletes (`delete_channel`, `delete_category`, `delete_role`, `delete_automod_rule`) and `set_role_positions` take effect immediately and are not reversible.
- Point MCP clients at a **test server** while experimenting — a model with these tools can restructure a real server.

---

## Project layout

```
discord-mcp/
├── index.js          # MCP server: 22 tool schemas, validator, handlers
├── lib/
│   └── discord.js    # REST v10 client: retries, timeout, error formatting
├── presence.mjs      # optional: gateway keep-alive so the bot shows online
├── audit.mjs         # optional: server audit + report
├── test-smoke.mjs    # offline suite, 11 assertions
├── test-e2e.mjs      # live suite, all 22 tools + both scripts
├── assets/           # image assets
├── .env.example      # template for the helper scripts
└── package.json      # start / presence / audit / test / test:e2e
```

Scripts: `npm start`, `npm run presence`, `npm run audit`, `npm test`, `npm run test:e2e`.

---

## Limitations

- **No message history, threads, webhooks, DMs, emoji/stickers or scheduled events** — the scope is server *administration* plus a single `send_message`.
- Icon/banner uploads are not supported (they need multipart file uploads).
- The MCP server is stateless REST; it does not listen to gateway events. Use `presence.mjs` for anything gateway-related.
- Discord rate limits still apply. Requests are retried, but bulk operations will be slow and long `retry-after` waits surface as errors rather than blocking for minutes.
- `set_role_positions` cannot move roles above the bot's own highest role, and cannot touch `@everyone`.

---

## License
 
No license file is included yet. Add one before publishing — MIT is the common choice for MCP servers. Until then, all rights are reserved by default.
