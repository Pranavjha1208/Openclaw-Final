# Fixit Chatbot API Documentation

Base URL: `http://<gateway-host>:18789/api/fixit`

All endpoints (except `dev/jwt` and `files/download`) require a JWT in the `Authorization` header:

```
Authorization: Bearer <jwt_token>
```

---

## Authentication

### JWT Payload Structure

Your backend must sign JWTs (HS256) with the shared `jwtSecret`. The payload must contain:

```json
{
  "org_id": "ORG_ABC123",
  "user_id": "USR_XYZ789",
  "role": "admin",
  "org_name": "Acme Corp",
  "user_name": "John Doe",
  "campaign_id": "CAMP_001",
  "exp": 1741234567
}
```

| Field         | Type   | Required | Description                                                             |
| ------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `org_id`      | string | **Yes**  | Organization identifier. All data queries are hard-scoped to this.      |
| `user_id`     | string | **Yes**  | User identifier. All data queries are hard-scoped to this.              |
| `role`        | string | No       | One of `"admin"`, `"user"`, `"super_user"`. Defaults to `"user"`.       |
| `org_name`    | string | No       | Display name for the org.                                               |
| `user_name`   | string | No       | Display name for the user.                                              |
| `campaign_id` | string | No       | Optional campaign scope. When present, all queries also filter by this. |
| `exp`         | number | **Yes**  | Expiry timestamp (Unix seconds).                                        |

### POST `/api/fixit/auth/verify`

Verify a JWT and get the decoded identity.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**

```json
{
  "valid": true,
  "orgId": "ORG_ABC123",
  "userId": "USR_XYZ789",
  "orgName": "Acme Corp",
  "userName": "John Doe",
  "role": "admin",
  "campaignId": "CAMP_001"
}
```

**Response (401):**

```json
{ "error": "Missing or invalid Authorization header" }
```

---

## Chat

### POST `/api/fixit/chat/send`

Send a message and receive a streamed AI response via **Server-Sent Events (SSE)**.

**Headers:**

```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**

```json
{
  "message": "How many leads are qualified?",
  "sessionId": "bfc5ffa5-1234-5678-abcd-000000000000",
  "campaignId": "CAMP_BASELINE"
}
```

| Field        | Type   | Required | Description                                                                                                                        |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `message`    | string | **Yes**  | The user's message text.                                                                                                           |
| `sessionId`  | string | No       | Existing session ID. If omitted, auto-creates or reuses an open session.                                                           |
| `campaignId` | string | No       | Optional campaign scope from the frontend. When present, all scoped MongoDB reads and writes are restricted to that `campaign_id`. |

**Response:** SSE stream (`Content-Type: text/event-stream`)

The stream emits these event types:

#### `delta` — Text chunk (streamed incrementally)

```
event: delta
data: {"type":"delta","text":"Here are your"}
```

#### `tool_call` — Agent is using a tool

```
event: tool_call
data: {"type":"tool_call","name":"mongo_aggregate","status":"running"}
```

```
event: tool_call
data: {"type":"tool_call","name":"mongo_aggregate","status":"completed"}
```

Status values: `"running"` | `"completed"` | `"failed"`

#### `done` — Response complete

```
event: done
data: {"type":"done","text":"Here are your qualified leads...","sessionId":"bfc5ffa5-...","runId":"a1b2c3d4-..."}
```

| Field       | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `text`      | The full final response text (concatenation of all deltas).                            |
| `sessionId` | The session ID (useful if you didn't provide one — save this for subsequent messages). |
| `runId`     | Unique run ID. Use this to abort the run.                                              |

#### `error` — Something went wrong

```
event: error
data: {"type":"error","error":"Failed to connect to model provider"}
```

**Frontend integration pattern (JavaScript):**

```javascript
async function sendMessage(token, message, sessionId, onDelta, onDone, onError) {
  const res = await fetch("/api/fixit/chat/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, sessionId }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "delta") onDelta(event.text);
          else if (event.type === "done") onDone(event);
          else if (event.type === "error") onError(event.error);
        } catch {}
      }
    }
  }
}
```

**React integration pattern:**

```javascript
// Hook usage
const [messages, setMessages] = useState([]);
const [streaming, setStreaming] = useState(false);

async function handleSend(text) {
  setMessages((prev) => [...prev, { role: "user", text }]);
  setStreaming(true);

  let fullText = "";
  await sendMessage(
    jwt,
    text,
    sessionId,
    (delta) => {
      fullText += delta;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          last.text = fullText;
        } else {
          updated.push({ role: "assistant", text: fullText });
        }
        return updated;
      });
    },
    (doneEvent) => {
      setStreaming(false);
      if (!sessionId) setSessionId(doneEvent.sessionId);
    },
    (error) => {
      setStreaming(false);
      console.error(error);
    },
  );
}
```

---

### POST `/api/fixit/chat/abort`

Abort a running AI response mid-stream.

**Request Body:**

```json
{ "runId": "a1b2c3d4-..." }
```

**Response (200):**

```json
{ "ok": true, "aborted": true }
```

The `runId` comes from the `done` event of a previous stream, or you can track it from the SSE stream. If the run is already finished or belongs to a different user, returns `{ "ok": true, "aborted": false }`.

---

## Sessions

### POST `/api/fixit/chat/sessions/new`

Create a new chat session.

**Response (200):**

```json
{ "sessionId": "bfc5ffa5-1234-5678-abcd-000000000000" }
```

### GET `/api/fixit/chat/sessions`

List all sessions for the authenticated user (most recent first, max 50).

**Response (200):**

```json
{
  "sessions": [
    {
      "sessionId": "bfc5ffa5-...",
      "startTime": "2026-03-10T12:00:00.000Z",
      "endTime": null,
      "updatedAt": "2026-03-10T12:05:00.000Z",
      "channelType": "ui",
      "metadata": {}
    }
  ]
}
```

| Field       | Description                               |
| ----------- | ----------------------------------------- |
| `sessionId` | UUID for the session.                     |
| `startTime` | When the session was created.             |
| `endTime`   | `null` if active, ISO string if archived. |
| `updatedAt` | Last message activity timestamp.          |

### GET `/api/fixit/chat/history?sessionId=...&limit=50`

Get message history for a session.

**Query params:**

| Param       | Required | Description                                 |
| ----------- | -------- | ------------------------------------------- |
| `sessionId` | **Yes**  | The session UUID.                           |
| `limit`     | No       | Max messages to return (1–100, default 50). |

**Response (200):**

```json
{
  "sessionId": "bfc5ffa5-...",
  "messages": [
    {
      "message": "How many leads are qualified?",
      "messageOwner": "user",
      "messageType": "text",
      "channelType": "ui",
      "createdAt": "2026-03-10T12:00:00.000Z"
    },
    {
      "message": "You have **42** qualified leads...",
      "messageOwner": "assistant",
      "messageType": "text",
      "channelType": "ui",
      "createdAt": "2026-03-10T12:00:05.000Z"
    }
  ]
}
```

### DELETE `/api/fixit/chat/sessions/:sessionId`

Archive (soft-delete) a session by setting `end_time`.

**Response (200):**

```json
{ "ok": true, "updated": true }
```

---

## File Downloads

### GET `/api/fixit/files/download?path=...&token=...`

Download exported files (CSV, XLSX, etc.) generated by the AI agent.

**Important:** This endpoint uses a **query parameter** for the token (not the Authorization header) because it's designed for browser `<a href>` downloads.

| Param   | Required | Description                                                         |
| ------- | -------- | ------------------------------------------------------------------- |
| `path`  | **Yes**  | The full file path returned by the agent (e.g., from a CSV export). |
| `token` | **Yes**  | The same JWT token.                                                 |

The agent returns download links in markdown format:

```
[Download leads_export.csv](/api/fixit/files/download?path=/path/to/file.csv)
```

Your frontend should append `&token=<jwt>` when rendering these links:

```javascript
function renderDownloadLink(href) {
  const url = new URL(href, window.location.origin);
  url.searchParams.set("token", jwt);
  return url.toString();
}
```

---

## Dev/Testing Only

### POST `/api/fixit/dev/jwt`

Generate a test JWT (only available when `allowDevJwt: true` in config). **Do not expose this in production.**

**No auth required.**

**Request Body:**

```json
{
  "orgId": "ORG_ABC123",
  "userId": "USR_XYZ789",
  "role": "admin",
  "orgName": "Acme Corp",
  "userName": "John Doe",
  "campaignId": "CAMP_001"
}
```

| Field        | Required | Description              |
| ------------ | -------- | ------------------------ |
| `orgId`      | **Yes**  | Organization ID.         |
| `userId`     | **Yes**  | User ID.                 |
| `role`       | No       | Defaults to `"user"`.    |
| `orgName`    | No       | Defaults to `"Org"`.     |
| `userName`   | No       | Defaults to `"User"`.    |
| `campaignId` | No       | Optional campaign scope. |

**Response (200):**

```json
{ "token": "eyJhbGciOiJIUzI1NiIs..." }
```

---

## Data Scoping & Security

All data access is automatically scoped:

- **`org_id`** and **`user_id`** from the JWT are enforced on every MongoDB query (backend-enforced, not just agent-level).
- When **`campaign_id`** is present in the JWT, it's also enforced as a hard filter.
- The AI agent cannot access data from other orgs/users/campaigns, even if explicitly asked.
- Delete operations on MongoDB are disabled.

## Workspace & Onboarding

- On **first connection** with a new org_id/user_id, the AI agent asks onboarding questions (company name, communication style, goals) and saves the answers to `f_user_workspace` in MongoDB.
- On **subsequent connections**, the agent loads the saved workspace docs and uses them as persona/context.
- **Conversation memory**: The agent remembers the current session's messages and recent messages from previous sessions.

## Response Formatting

The agent returns responses in **Markdown**. Your frontend should render:

- **Bold**, _italic_, headings, lists
- Markdown tables (for data with ≤10 rows)
- ` ```json ` code blocks
- Download links for CSV/XLSX exports (when >10 rows)

## Error Codes

| Status | Meaning                                         |
| ------ | ----------------------------------------------- |
| 200    | Success                                         |
| 400    | Bad request (missing fields, invalid body)      |
| 401    | Unauthorized (missing/invalid/expired JWT)      |
| 403    | Forbidden (file path outside allowed directory) |
| 404    | Not found (endpoint or file)                    |
| 413    | Payload too large (body >2MB)                   |
| 500    | Internal server error                           |

## CORS

The gateway sets CORS headers for origins listed in `gateway.fixit.cors.allowOrigins`. For production, add your frontend's domain there. In dev mode, `*` is used as fallback.
