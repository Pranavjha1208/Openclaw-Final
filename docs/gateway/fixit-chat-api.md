---
title: "Fixit chat API"
description: "Session, history, streaming chat, and chat title APIs for the Fixit web chat."
---

# Fixit chat API

Use these endpoints to build a ChatGPT-style chat history UI for the Fixit web client.

Base URL:

```text
http://<gateway-host>:18789/api/fixit
```

All endpoints in this page require:

```http
Authorization: Bearer <jwt>
```

The backend derives identity from the JWT and scopes all chat data to that authenticated user and org.

## Data model

The API reads from:

- `f_user_sessions` for chat sessions
- `f_user_messages` for messages inside a session

Session ownership is enforced by:

- `user_id`
- `metadata.org_id`
- `channel_type = "ui"`

History is resolved from the exact `sessionId` you pass. The backend first finds the matching session row in `f_user_sessions`, then loads only the messages whose `session_id` points to that session document. It does not mix messages from other sessions.

## Session lifecycle

Use this flow for a ChatGPT-style UI:

1. Call `POST /api/fixit/chat/sessions/new` when the user clicks `New chat`.
2. Save the returned `sessionId` in the frontend state.
3. Send every message for that chat with that `sessionId`.
4. Render the sidebar from `GET /api/fixit/chat/sessions`.
5. When the user clicks a chat in the sidebar, load it with `GET /api/fixit/chat/history?sessionId=...`.

## POST `/api/fixit/chat/sessions/new`

Create a new empty chat session.

Response:

```json
{
  "sessionId": "5f8a5f9c-2c61-4d2d-b8e1-7f3f0d52f7fe",
  "title": "New chat"
}
```

Notes:

- The backend creates a new row in `f_user_sessions`.
- The initial title is always `New chat`.
- The frontend should treat the returned `sessionId` as the canonical id for that chat tab/thread.

## POST `/api/fixit/chat/send`

Send one user message and receive the assistant response as Server-Sent Events (SSE).

Request:

```json
{
  "message": "Show me qualified leads from this week",
  "sessionId": "5f8a5f9c-2c61-4d2d-b8e1-7f3f0d52f7fe",
  "campaignId": "CAMP_BASELINE"
}
```

Fields:

| Field        | Required | Description                                                                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `message`    | Yes      | User message text.                                                                                                          |
| `sessionId`  | No       | Existing session id. If omitted, the backend creates or reuses a session. For a chat UI, always send the active session id. |
| `campaignId` | No       | Optional selected campaign. When present, all agent reads and writes are restricted to that `campaign_id`.                  |

The response is an SSE stream with these event types.

### `delta`

Incremental assistant text.

```text
event: delta
data: {"type":"delta","text":"You have "}
```

### `tool_call`

Tool execution progress.

```text
event: tool_call
data: {"type":"tool_call","name":"mongo_aggregate","status":"running"}
```

### `done`

Final event for the response.

```text
event: done
data: {"type":"done","text":"You have 12 qualified leads.","sessionId":"5f8a5f9c-2c61-4d2d-b8e1-7f3f0d52f7fe","runId":"1f3a9a6d-4e6d-4c8f-8a7f-f6f3a2c4156d","chatTitle":"Qualified leads from this week"}
```

Fields:

| Field       | Description                                   |
| ----------- | --------------------------------------------- |
| `text`      | Final full assistant response.                |
| `sessionId` | Session id to keep using for this chat.       |
| `runId`     | Run id for abort requests.                    |
| `chatTitle` | Backend-generated chat title for the session. |

### `error`

```text
event: error
data: {"type":"error","error":"Failed to connect to model provider"}
```

## GET `/api/fixit/chat/sessions`

List chat sessions for the authenticated Fixit user.

Response:

```json
{
  "sessions": [
    {
      "sessionId": "5f8a5f9c-2c61-4d2d-b8e1-7f3f0d52f7fe",
      "title": "Qualified leads from this week",
      "startTime": "2026-03-13T11:00:00.000Z",
      "endTime": null,
      "updatedAt": "2026-03-13T11:02:10.000Z",
      "channelType": "ui",
      "messageCount": 6,
      "lastMessagePreview": "You have 12 qualified leads.",
      "metadata": {
        "org_id": "ORG_ABC123",
        "source": "web_ui",
        "title": "Qualified leads from this week"
      }
    }
  ]
}
```

Fields:

| Field                | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `sessionId`          | Stable session id for the chat.                        |
| `title`              | Human-readable chat title for the sidebar.             |
| `startTime`          | Session creation time.                                 |
| `endTime`            | `null` for active chats, timestamp for archived chats. |
| `updatedAt`          | Last session activity time.                            |
| `channelType`        | Always `ui` for Fixit web chat.                        |
| `messageCount`       | Number of messages stored for that chat.               |
| `lastMessagePreview` | Short preview string for the sidebar.                  |
| `metadata`           | Raw backend metadata.                                  |

Notes:

- Sessions are returned most recent first.
- This endpoint is what your frontend should use to render the chat sidebar.
- Do not display raw `sessionId` to users unless you need it for debugging.

## GET `/api/fixit/chat/history?sessionId=...&limit=50`

Load messages for one chat.

Query params:

| Param       | Required | Description                                                     |
| ----------- | -------- | --------------------------------------------------------------- |
| `sessionId` | Yes      | Exact session id from the session list or create call.          |
| `limit`     | No       | Number of messages to return. Min `1`, max `100`, default `50`. |

Response:

```json
{
  "sessionId": "5f8a5f9c-2c61-4d2d-b8e1-7f3f0d52f7fe",
  "title": "Qualified leads from this week",
  "messages": [
    {
      "message": "Show me qualified leads from this week",
      "messageOwner": "user",
      "messageType": "text",
      "channelType": "ui",
      "createdAt": "2026-03-13T11:00:02.000Z"
    },
    {
      "message": "You have 12 qualified leads.",
      "messageOwner": "assistant",
      "messageType": "text",
      "channelType": "ui",
      "createdAt": "2026-03-13T11:00:05.000Z"
    }
  ]
}
```

Notes:

- Messages are returned oldest first.
- The backend only returns messages for the requested session.
- If the session does not belong to the authenticated user and org, the response is an empty message list.

## POST `/api/fixit/chat/abort`

Abort an in-flight stream.

Request:

```json
{
  "runId": "1f3a9a6d-4e6d-4c8f-8a7f-f6f3a2c4156d"
}
```

Response:

```json
{
  "ok": true,
  "aborted": true
}
```

## DELETE `/api/fixit/chat/sessions/:sessionId`

Archive a session.

Response:

```json
{
  "ok": true,
  "updated": true
}
```

This is a soft archive. The backend marks `end_time` and keeps the chat data in MongoDB.

## Chat title behavior

Session ids are for backend routing only. The frontend should display `title`.

Title generation rules:

- New chats start as `New chat`.
- After enough conversation exists, the backend generates a short title from the first user message.
- The title is stored in `f_user_sessions.metadata.title`.
- Campaign-scoped chats store `metadata.campaign_id`, so one campaign's session does not silently reuse another campaign's context.
- The latest title is returned from both `GET /api/fixit/chat/sessions` and the `done` SSE event.

This lets the frontend update the sidebar title immediately after a response completes.

## Frontend contract

For a production frontend:

1. Call `POST /chat/sessions/new` when the user starts a new chat.
2. Store `sessionId` in the active tab/thread.
3. Call `POST /chat/send` with that `sessionId` for every turn.
4. Use the `done.chatTitle` value to update the chat title in the UI.
5. Refresh the sidebar from `GET /chat/sessions` when needed.
6. Load a selected thread from `GET /chat/history`.

## Security and scoping

These endpoints do not trust frontend-supplied user identity.

The backend enforces:

- `user_id` from the JWT
- `metadata.org_id` from the JWT
- `campaign_id` from `POST /api/fixit/chat/send` when provided
- `channel_type = "ui"`
- exact `sessionId` ownership before loading history

That prevents one user from reading another user's chat history by guessing a session id.
