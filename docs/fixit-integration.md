# Fixit Chatbot Integration — Full Detail

This document describes the Fixit Chatbot integration built into the OpenClaw gateway: REST + SSE APIs, JWT auth, strict org/user scoping, config, channel changes, and the dummy frontend. Use it to onboard the team and trace every file change.

---

## 1. What Was Built (High-Level)

A **Fixit Chatbot** integration so the **Fixit UI** can talk to OpenClaw’s agent (same pipeline as Telegram) over **REST + SSE**:

- **JWT authentication** — tokens carry `org_id`, `user_id`, and optional `role`, `org_name`, `user_name`.
- **Strict org/user scoping** — every request is bound to one org and user; the agent and data access are scoped so users cannot see other orgs’ data.
- **Dual-write to MongoDB** — chat messages are written to `f_user_sessions` and `f_user_messages` (same schema as the existing Fixit WhatsApp agent).
- **No WebSockets** — all communication is standard HTTP; the chat reply stream uses Server-Sent Events (SSE).

The same agent, tools (MongoDB, etc.), and plugins (e.g. Google Calendar) that power Telegram now also power the Fixit UI; only the transport is different (REST + SSE instead of Telegram).

---

## 2. Architecture (Request Flow)

```
Fixit Frontend (your UI)
    │
    │  HTTP + JWT (Bearer token with org_id, user_id)
    ▼
OpenClaw Gateway (e.g. port 18789)
    │  Routes under /api/fixit/*
    ├── JWT verification → identity (org_id, user_id)
    ├── CORS applied (allow frontend origin)
    ├── Sessions / history from MongoDB
    └── chat/send → dispatchInboundMessage (same as Telegram)
                        │
                        ├── Agent context: "only query org_id=X, user_id=Y"
                        ├── Tools: MongoDB, Google Calendar, etc. (unchanged)
                        └── SSE stream: delta / tool_call / done / error
    │
    ▼
MongoDB (CosmosDB): f_user_sessions, f_user_messages (+ your existing collections)
```

- **Gateway** handles only HTTP; Fixit routes are under a configurable base path (default `/api/fixit`).
- **Identity** comes only from the JWT; there is no separate login endpoint in this integration (your UI obtains JWTs from your own auth).
- **Strict scope** is enforced by injecting org_id/user_id into the agent’s system prompt and by designing session/history and future data APIs to filter by that identity.

---

## 3. APIs Created (Backend)

All endpoints live under **base path** `gateway.fixit.basePath` (default `/api/fixit`). Authenticated routes use the JWT to derive **org_id** and **user_id**; that identity is used for scoping and session ownership.

| Method | Path                           | Auth | Purpose                                                                                    |
| ------ | ------------------------------ | ---- | ------------------------------------------------------------------------------------------ |
| POST   | `/api/fixit/auth/verify`       | JWT  | Validate token; return `orgId`, `userId`, `role`, `orgName`, `userName`.                   |
| POST   | `/api/fixit/chat/send`         | JWT  | Send user message; stream AI reply as SSE (`delta`, `tool_call`, `done`, `error`).         |
| POST   | `/api/fixit/chat/abort`        | JWT  | Abort an in-flight chat run (by `runId`).                                                  |
| GET    | `/api/fixit/chat/sessions`     | JWT  | List sessions for the authenticated user.                                                  |
| GET    | `/api/fixit/chat/history`      | JWT  | Get messages for a session (`?sessionId=...&limit=...`).                                   |
| POST   | `/api/fixit/chat/sessions/new` | JWT  | Create a new session; returns `sessionId`.                                                 |
| DELETE | `/api/fixit/chat/sessions/:id` | JWT  | End/archive a session.                                                                     |
| POST   | `/api/fixit/dev/jwt`           | None | **(Testing only)** Issue a test JWT for given `orgId`/`userId` when `allowDevJwt` is true. |
| GET    | `/api/fixit/data/*`            | JWT  | Placeholder for future dashboard data APIs (e.g. leads by org); currently returns 501.     |

- **Auth:** All except `dev/jwt` require `Authorization: Bearer <token>`. Token is HS256; secret from config or `FIXIT_JWT_SECRET`.
- **CORS:** Handled for `/api/fixit/*`. If `cors.allowOrigins` is empty, any origin is allowed (dev); otherwise only listed origins.
- **SSE:** Only `POST /api/fixit/chat/send` returns a stream; others return JSON.

---

## 4. Config (Gateway Fixit + Validation)

OpenClaw validates config with a **Zod schema**. Any key not in that schema is "unrecognized" and can cause the whole config to be rejected (and Fixit to be disabled).

### 4.1 What We Did (No Bypass)

- **Defined `gateway.fixit`** and all its keys in the Zod schema so the config is accepted.
- **Added `allowDevJwt`** in both:
  - TypeScript: `src/config/types.gateway.ts` (`GatewayFixitConfig`)
  - Zod: `src/config/zod-schema.ts` (inside the `fixit` object)

So we did **not** bypass config; we **extended the schema** so `allowDevJwt` (and the rest of fixit) is valid. Without that you get:

- `gateway.fixit: Unrecognized key: "allowDevJwt"` → config invalid → Fixit disabled.

### 4.2 Fixit Config Block (Example)

In `~/.openclaw/openclaw.json` (or your main config file):

```json
"gateway": {
  "fixit": {
    "enabled": true,
    "jwtSecret": "<same-secret-your-auth-uses>",
    "basePath": "/api/fixit",
    "mongoUri": "<mongodb-connection-string>",
    "mongoDatabase": "fixit_whatsapp_agent_dev",
    "defaultAgentId": "main",
    "allowDevJwt": true,
    "cors": { "allowOrigins": [] }
  }
}
```

| Key                 | Purpose                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled`           | Must be `true` for any Fixit API to run.                                                                       |
| `jwtSecret`         | Used to verify (and, when `allowDevJwt` is true, to sign dev JWTs). Same secret as your auth service / script. |
| `basePath`          | URL prefix for Fixit routes (default `/api/fixit`).                                                            |
| `mongoUri`          | MongoDB connection string for dual-write and session/history.                                                  |
| `mongoDatabase`     | Database name (e.g. `fixit_whatsapp_agent_dev`).                                                               |
| `defaultAgentId`    | Agent id for Fixit sessions (default `main`).                                                                  |
| `allowDevJwt`       | If `true`, `POST /api/fixit/dev/jwt` can issue test JWTs; set `false` in production.                           |
| `cors.allowOrigins` | Allowed origins for CORS. Empty = allow any origin (dev); otherwise list your frontend origins.                |

---

## 5. Channels: Telegram Off, Fixit Only

To use **only the Fixit UI** as the channel (no Telegram):

### 5.1 Config Changes (`~/.openclaw/openclaw.json`)

1. **Disable the Telegram channel**
   - Set `channels.telegram.enabled` to `false` so the Telegram bot does not start.

2. **Stop loading the Telegram plugin**
   - Removed `"telegram"` from `plugins.allow`.
   - Removed `plugins.entries.telegram` so the Telegram plugin is not configured.

Result: No Telegram process or listeners; the same agent and tools (MongoDB, etc.) now serve only the Fixit UI.

---

## 6. Backend File Changes (Gateway / Fixit)

All new Fixit code lives under `src/gateway/fixit/`. The main HTTP router wires Fixit in `src/gateway/server-http.ts`.

| File                                     | Purpose                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/gateway/fixit/types.ts`**         | Types: `FixitIdentity`, `FixitChatSendBody`, SSE event types (`delta`, `tool_call`, `done`, `error`), `FixitAuthVerifyResponse`, session/message types.                                                                   |
| **`src/gateway/fixit/config.ts`**        | Reads `gateway.fixit` and env (`FIXIT_JWT_SECRET`); resolves `basePath`, `jwtSecret`, `mongoUri`, `mongoDatabase`, `cors`, `allowDevJwt`; returns `FixitConfigResolved` or `null` if disabled. Logs why Fixit is on/off.  |
| **`src/gateway/fixit/auth.ts`**          | Verifies HS256 JWT and extracts `FixitIdentity` (org_id, user_id, role, etc.). Exports `signFixitJwt()` for dev JWTs.                                                                                                     |
| **`src/gateway/fixit/session.ts`**       | Maps (org_id, user_id, optional session id) to OpenClaw session key and agent id.                                                                                                                                         |
| **`src/gateway/fixit/agent-context.ts`** | Builds the **strict scoping** system prompt: "Only use org_id=X, user_id=Y; always add org_id to every MongoDB filter; never other orgs." Injected into the agent for every Fixit request.                                |
| **`src/gateway/fixit/cors.ts`**          | Sets CORS headers for `/api/fixit/*`; if `allowOrigins` is empty, allows any origin (for dev).                                                                                                                            |
| **`src/gateway/fixit/mongo-sync.ts`**    | Connects to MongoDB; creates/gets session in `f_user_sessions`; appends messages to `f_user_messages` (dual-write with chat).                                                                                             |
| **`src/gateway/fixit/http.ts`**          | Single HTTP handler for all Fixit routes: dev/jwt (no auth), auth/verify, chat/send (SSE), chat/abort, sessions list/new/delete, history, and stub data/\*. Uses `dispatchInboundMessage` and agent events for streaming. |
| **`src/gateway/server-http.ts`**         | Resolves Fixit config; if request path is under `fixitConfig.basePath`, forwards to `handleFixitHttpRequest`. No Fixit logic beyond this wiring.                                                                          |

---

## 7. Config Schema and Types (So Config Is Valid)

| File                              | Change                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/config/types.gateway.ts`** | In `GatewayFixitConfig`: added `allowDevJwt?: boolean` (and any other fixit fields used in config).                                                                             |
| **`src/config/zod-schema.ts`**    | In `gateway.fixit` object: added `allowDevJwt: z.boolean().optional()`. Keeps `.strict()` so no extra keys; now `allowDevJwt` is allowed and config no longer fails validation. |

This is what fixed "Unrecognized key: allowDevJwt" and allowed Fixit to stay enabled.

---

## 8. Frontend (Dummy UI for Testing)

A small **Vite** app in **`frontend/`** calls the gateway and demonstrates all Fixit APIs.

### 8.1 Features

- **API base URL** — e.g. `http://localhost:18789` or leave empty to use Vite proxy to the gateway.
- **Org ID / User ID** — Inputs used when generating a test JWT (and shown after Verify).
- **JWT textarea** — Paste token or fill it via "Generate JWT".
- **Generate JWT** — Calls `POST /api/fixit/dev/jwt` with `{ orgId, userId }` and puts the returned token in the textarea (only works when `allowDevJwt` is true).
- **Verify token** — `POST /api/fixit/auth/verify`; shows identity and "Strict scope: org_id=… user_id=…".
- **Copy command** — Shows the terminal command to generate a JWT with the current Org ID / User ID (e.g. `cd frontend && node scripts/gen-fixit-jwt.js <secret> <org_id> <user_id>`).
- **Sessions** — New conversation, refresh list, click to load history.
- **Chat** — Send message; streamed reply appears as SSE (deltas, tool calls, done, errors).

### 8.2 Frontend Files

| File                                    | Purpose                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **`frontend/index.html`**               | Layout: connection, Org ID/User ID, JWT, buttons (Generate JWT, Verify, Copy command), sessions, chat.                          |
| **`frontend/src/main.js`**              | All API calls (`apiUrl`, `apiFetch`), Generate JWT, Verify, sessions, send message (SSE), abort; console logging for debugging. |
| **`frontend/src/style.css`**            | Styles for two-column org/user, command box, buttons.                                                                           |
| **`frontend/scripts/gen-fixit-jwt.js`** | CLI: `node scripts/gen-fixit-jwt.js <jwt-secret> [org_id] [user_id]`; prints a JWT to stdout.                                   |
| **`frontend/vite.config.js`**           | Dev server; proxies `/api` to gateway (e.g. 18789).                                                                             |
| **`frontend/package.json`**             | Vite app deps and scripts.                                                                                                      |

**`pnpm-workspace.yaml`** was updated to include `frontend` so `pnpm install` installs its deps.

### 8.3 Running the Frontend

```bash
# From repo root (after pnpm install)
cd frontend && pnpm dev
```

Then open the URL shown (e.g. http://localhost:5174). Use "Generate JWT" (with gateway `allowDevJwt: true`) or the copyable terminal command to get a token, then Verify and chat.

---

## 9. Strict Org/User Scoping

Goal: **one org (and user) per JWT; no cross-org data.**

### 9.1 How It Works

- **Backend**
  - Every Fixit request (except `dev/jwt`) is authenticated; identity = `org_id` + `user_id` from the JWT.
  - **Agent:** `buildFixitAgentContext(identity)` injects a system prompt that:
    - States the only allowed `org_id` and `user_id`.
    - Requires **every** MongoDB filter to include `org_id` (and use that user where relevant).
    - Says the backend enforces this and must not query other orgs.
  - **Sessions and history:** Stored and read by `user_id` (and session id); session creation is tied to identity.
  - **Future data APIs:** When you implement `/api/fixit/data/*`, they should filter by `identity.orgId` (and `identity.userId` where appropriate) in the backend, and not trust client-supplied org/user.

- **Frontend**
  - Org ID and User ID inputs drive **which** org/user the test JWT is for; after "Verify", the UI shows "Strict scope: org_id=… user_id=…" so the team sees that all subsequent chat/sessions are bound to that identity.

So: **JWT = single org + user; backend and agent context enforce that nothing else is queried.**

### 9.2 Agent Context (Excerpt)

From `src/gateway/fixit/agent-context.ts`, the injected prompt includes:

- `org_id` and `user_id` for the current request.
- Rule: "You MUST include {\"org_id\":\"<id>\"} in EVERY mongo_find, mongo_count, mongo_aggregate, and mongo_update filter."
- "Never query, aggregate, or return data for any other org_id."

---

## 10. JWT: How to Get One

### 10.1 From the UI (when `allowDevJwt` is true)

1. Set **Org ID** and **User ID** in the dummy frontend.
2. Click **Generate JWT**. The backend returns a token and the UI puts it in the JWT field.
3. Click **Verify token** to confirm and see strict scope.

### 10.2 From the terminal

From the repo root, run (secret must match `gateway.fixit.jwtSecret` in config):

```bash
cd frontend && node scripts/gen-fixit-jwt.js <jwt-secret> <org_id> <user_id>
```

Example:

```bash
cd frontend && node scripts/gen-fixit-jwt.js YOUR_JWT_SECRET org_demo usr_demo
```

The UI also shows this command under the buttons and updates it when you change Org ID / User ID; use **Copy** to copy it.

---

## 11. CORS and Logging

- **CORS:** Handled in `src/gateway/fixit/cors.ts`. Applied before auth so 401 responses include CORS headers. When `cors.allowOrigins` is empty, the response reflects the request `Origin` (or `*`) so dev from another port works.
- **Logging:** The Fixit handler logs to console: config on/off, each request method/path, auth result, route matched, and for chat/send the message and session/run ids. Use these logs to debug connectivity and scope.

---

## 12. Markdown Rendering, Canvas-like UI, and File Downloads

### 12.1 Markdown/HTML Rendering

Assistant messages are rendered as rich markdown using the `marked` library:

- **Tables** are styled with hover effects and colored headers (canvas-like).
- **Code blocks** get syntax highlighting with monospace font and dark background.
- **JSON** data displayed in fenced code blocks renders with proper formatting.
- **Bold, italic, lists, headings, blockquotes, and links** all render correctly.

During streaming, text is shown as plain text for performance. Once the stream completes (`done` event), the full text is re-rendered as markdown.

### 12.2 File Download Links

When the agent exports data (e.g., via `mongo_export_csv`), it includes a markdown download link:

```
[Download leads_export.csv](/api/fixit/files/download?path=/Users/.../.openclaw/workspace/leads_export.csv)
```

The frontend detects these links and renders them as styled green download buttons. The JWT token is automatically appended to the URL for authentication.

**Backend endpoint:** `GET /api/fixit/files/download?path=...&token=...`

- Authenticates via `token` query parameter (since browser downloads cant send headers).
- Only serves files under `~/.openclaw/workspace` (security restriction).
- Supports CSV, XLSX, XLS, JSON, TXT, PDF with correct MIME types.

### 12.3 Mandatory Excel for >10 Leads

The agent context now includes a strict rule:

- When a user requests lead data and the result has **more than 10 rows**, the agent MUST use `mongo_export_csv` to generate a file and provide a download link.
- For 10 or fewer rows, the agent shows data inline as a markdown table.

This is enforced via the system prompt in `src/gateway/fixit/agent-context.ts`.

---

## 13. Quick Reference for the Team

| Topic          | Summary                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **APIs**       | REST + SSE under `/api/fixit`: auth verify, chat send (streaming), sessions, history, abort, dev JWT, and file downloads.        |
| **Config**     | `gateway.fixit` in OpenClaw config; we added `allowDevJwt` to the **Zod schema** so the config is valid and Fixit stays enabled. |
| **Channels**   | Telegram disabled and unplugged; only the Fixit UI uses the gateway, with the same agent and tools.                              |
| **Security**   | JWT carries org_id/user_id; agent context and backend enforce strict scoping. File downloads also require valid JWT.             |
| **Frontend**   | Demo app in `frontend/` with markdown rendering, download buttons, tool progress indicators, and session management.             |
| **Excel rule** | >10 leads = mandatory CSV export with download link. 10 or fewer = inline markdown table.                                        |

---

## 14. Doc Links

- Mintlify docs: [Configuration](/configuration), [Gateway](/gateway) (use root-relative paths as in the repo).
- External: https://docs.openclaw.ai/ (when linking from README or outside the docs tree).
