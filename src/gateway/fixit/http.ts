/**
 * Fixit Chatbot Integration — REST + SSE HTTP handler.
 * All Fixit endpoints under basePath: auth/verify, chat/send (SSE), chat/abort, sessions, history, data/*.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname } from "node:path";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import { onAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { runWithFixitScope } from "../../infra/fixit-request-scope.js";
import { resolveAssistantStreamDeltaText } from "../agent-event-assistant-text.js";
import { readJsonBody } from "../hooks.js";
import { sendJson, setSseHeaders } from "../http-common.js";
import { buildFixitAgentContext } from "./agent-context.js";
import { authenticateFixitRequest, signFixitJwt, verifyFixitJwt } from "./auth.js";
import type { FixitConfigResolved } from "./config.js";
import { applyFixitCorsHeaders, handleFixitOptions } from "./cors.js";
import {
  getOrCreateFixitSession,
  recordFixitMessage,
  closeFixitMongoClient,
  type GetOrCreateFixitSessionResult,
} from "./mongo-sync.js";
import { buildFixitSessionKeyForIdentity } from "./session.js";
import type {
  FixitChatSendBody,
  FixitSseEvent,
  FixitAuthVerifyResponse,
  FixitChatAbortBody,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export type FixitHttpOptions = {
  fixitConfig: FixitConfigResolved;
  loadConfig: () => OpenClawConfig;
};

const runIdToAbort = new Map<
  string,
  { controller: AbortController; userId: string; orgId: string }
>();

function getOrigin(req: IncomingMessage): string | undefined {
  const v = req.headers.origin;
  return typeof v === "string" ? v : undefined;
}

function writeFixitSseEvent(res: ServerResponse, event: FixitSseEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function handleFixitHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: FixitHttpOptions,
): Promise<boolean> {
  const { fixitConfig, loadConfig } = opts;
  const basePath = fixitConfig.basePath.replace(/\/+$/, "") || "/api/fixit";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    return false;
  }

  console.log(`[fixit] ${req.method} ${pathname} (origin: ${getOrigin(req) ?? "none"})`);

  const origin = getOrigin(req);
  const applyCors = () => applyFixitCorsHeaders(res, fixitConfig.corsAllowOrigins, origin);

  if (req.method === "OPTIONS") {
    console.log("[fixit] handling CORS preflight");
    applyCors();
    return handleFixitOptions(req, res, fixitConfig.corsAllowOrigins);
  }

  applyCors();

  const subPath = pathname.slice(basePath.length).replace(/^\/+/, "") || "";

  // POST /api/fixit/dev/jwt — issue test JWT (no auth; testing only when allowDevJwt is true)
  if (req.method === "POST" && subPath === "dev/jwt" && fixitConfig.allowDevJwt) {
    const bodyResult = await readJsonBody(req, 64 * 1024);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error ?? "Bad request" });
      return true;
    }
    const raw = bodyResult.value as Record<string, unknown>;
    const orgId = typeof raw?.orgId === "string" ? raw.orgId.trim() : "";
    const userId = typeof raw?.userId === "string" ? raw.userId.trim() : "";
    if (!orgId || !userId) {
      sendJson(res, 400, { error: "orgId and userId are required" });
      return true;
    }
    const payload = {
      org_id: orgId,
      user_id: userId,
      role: (typeof raw?.role === "string" ? raw.role : "user") as "admin" | "user" | "super_user",
      org_name: typeof raw?.orgName === "string" ? raw.orgName : "Org",
      user_name: typeof raw?.userName === "string" ? raw.userName : "User",
      exp: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const token = signFixitJwt(payload, fixitConfig.jwtSecret);
    console.log(`[fixit] dev/jwt issued for org=${orgId} user=${userId}`);
    sendJson(res, 200, { token });
    return true;
  }

  // GET /api/fixit/files/download?path=...&token=... — browser downloads (token via query param)
  if (req.method === "GET" && subPath === "files/download") {
    const queryToken = url.searchParams.get("token") ?? "";
    if (!queryToken) {
      sendJson(res, 401, { error: "token query parameter is required" });
      return true;
    }
    try {
      verifyFixitJwt(queryToken, fixitConfig.jwtSecret);
    } catch {
      sendJson(res, 401, { error: "Invalid or expired token" });
      return true;
    }
    const filePath = url.searchParams.get("path") ?? "";
    if (!filePath) {
      sendJson(res, 400, { error: "path query is required" });
      return true;
    }
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const workspaceRoot = `${homeDir}/.openclaw/workspace`;
    const resolved = filePath.startsWith("~") ? filePath.replace(/^~/, homeDir) : filePath;
    if (!resolved.startsWith(workspaceRoot)) {
      sendJson(res, 403, { error: "File must be under ~/.openclaw/workspace" });
      return true;
    }
    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: "Not a file" });
        return true;
      }
      const ext = extname(resolved).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".csv": "text/csv",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".json": "application/json",
        ".txt": "text/plain",
        ".pdf": "application/pdf",
      };
      const contentType = mimeMap[ext] ?? "application/octet-stream";
      const filename = basename(resolved);
      console.log(`[fixit] files/download: ${filename} (${stat.size} bytes)`);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": stat.size,
        "Access-Control-Allow-Origin": origin ?? "*",
      });
      createReadStream(resolved).pipe(res);
    } catch {
      sendJson(res, 404, { error: "File not found" });
    }
    return true;
  }

  const identity = await authenticateFixitRequest(req, res, fixitConfig.jwtSecret);
  if (!identity) {
    console.log("[fixit] auth failed — returned 401");
    return true;
  }
  console.log(`[fixit] auth OK: org=${identity.orgId} user=${identity.userId}`);

  const cfg = loadConfig();

  console.log(`[fixit] route: ${req.method} ${subPath || "(root)"}`);

  // POST /api/fixit/auth/verify
  if (req.method === "POST" && subPath === "auth/verify") {
    const body: FixitAuthVerifyResponse = {
      valid: true,
      orgId: identity.orgId,
      userId: identity.userId,
      orgName: identity.orgName,
      userName: identity.userName,
      role: identity.role,
    };
    sendJson(res, 200, body);
    return true;
  }

  // POST /api/fixit/chat/send — SSE stream
  if (req.method === "POST" && subPath === "chat/send") {
    const bodyResult = await readJsonBody(req, DEFAULT_MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.error === "payload too large" ? 413 : 400, {
        error: bodyResult.error ?? "Bad request",
      });
      return true;
    }
    const raw = bodyResult.value;
    const message =
      typeof (raw as FixitChatSendBody)?.message === "string"
        ? (raw as FixitChatSendBody).message.trim()
        : "";
    if (!message) {
      sendJson(res, 400, { error: "message is required" });
      return true;
    }
    const sessionId =
      typeof (raw as FixitChatSendBody).sessionId === "string"
        ? (raw as FixitChatSendBody).sessionId
        : undefined;
    const sessionKey = buildFixitSessionKeyForIdentity(identity, fixitConfig, sessionId);

    let sessionResult: GetOrCreateFixitSessionResult;
    try {
      sessionResult = await getOrCreateFixitSession(
        identity,
        sessionKey,
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
        sessionId,
      );
    } catch (err) {
      sendJson(res, 500, { error: "Failed to get or create session", details: String(err) });
      return true;
    }

    const { sessionObjectId, sessionUuid } = sessionResult;
    try {
      await recordFixitMessage(
        {
          userId: identity.userId,
          sessionObjectId,
          message,
          messageType: "text",
          messageOwner: "user",
        },
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
      );
    } catch (err) {
      sendJson(res, 500, { error: "Failed to record message", details: String(err) });
      return true;
    }

    const runId = randomUUID();
    console.log(
      `[fixit] chat/send: message="${message.slice(0, 60)}" session=${sessionUuid.slice(0, 8)} runId=${runId.slice(0, 8)}`,
    );
    const abortController = new AbortController();
    runIdToAbort.set(runId, {
      controller: abortController,
      userId: identity.userId,
      orgId: identity.orgId,
    });
    registerAgentRunContext(runId, { sessionKey });

    setSseHeaders(res);

    let fullText = "";
    let doneSent = false;
    const sendDone = () => {
      if (doneSent) {
        return;
      }
      doneSent = true;
      runIdToAbort.delete(runId);
      writeFixitSseEvent(res, {
        type: "done",
        text: fullText,
        sessionId: sessionUuid,
        runId,
      });
      res.end();
    };

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (typeof payload.text === "string" && payload.text.trim()) {
          fullText += payload.text;
        }
      },
    });

    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId !== runId) {
        return;
      }

      if (evt.stream === "assistant") {
        const text = resolveAssistantStreamDeltaText(evt);
        if (text) {
          writeFixitSseEvent(res, { type: "delta", text });
        }
        return;
      }
      if (evt.stream === "tool") {
        const name = typeof evt.data?.name === "string" ? evt.data.name : "tool";
        const status =
          evt.data?.phase === "end" || evt.data?.status === "completed"
            ? "completed"
            : evt.data?.phase === "error" || evt.data?.status === "failed"
              ? "failed"
              : "running";
        writeFixitSseEvent(res, { type: "tool_call", name, status });
        return;
      }
      if (evt.stream === "lifecycle") {
        const phase = evt.data?.phase;
        if (phase === "end" || phase === "error") {
          sendDone();
        }
      }
    });

    req.on("close", () => {
      unsubscribe();
      runIdToAbort.delete(runId);
    });

    void runWithFixitScope({ orgId: identity.orgId, userId: identity.userId }, async () => {
      try {
        await dispatchInboundMessage({
          ctx: {
            Body: message,
            SessionKey: sessionKey,
            Provider: "fixit",
            Surface: "fixit-web",
            OriginatingChannel: "fixit",
            From: `fixit:${identity.orgId}:${identity.userId}`,
            GroupSystemPrompt: buildFixitAgentContext(identity),
          },
          cfg,
          dispatcher,
          replyOptions: {
            runId,
            abortSignal: abortController.signal,
            disableBlockStreaming: true,
          },
        });
      } catch (err) {
        if (!doneSent) {
          doneSent = true;
          runIdToAbort.delete(runId);
          writeFixitSseEvent(res, { type: "error", error: String(err) });
          res.end();
        }
        return;
      } finally {
        unsubscribe();
      }

      try {
        if (fullText.trim()) {
          await recordFixitMessage(
            {
              userId: identity.userId,
              sessionObjectId,
              message: fullText.trim(),
              messageType: "text",
              messageOwner: "assistant",
            },
            fixitConfig.mongoUri,
            fixitConfig.mongoDatabase,
          );
        }
      } catch {
        // best-effort; response already streamed
      }

      sendDone();
    });
    return true;
  }

  // POST /api/fixit/chat/abort
  if (req.method === "POST" && subPath === "chat/abort") {
    const bodyResult = await readJsonBody(req, 64 * 1024);
    const body =
      bodyResult.ok && typeof bodyResult.value === "object"
        ? (bodyResult.value as FixitChatAbortBody)
        : {};
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    if (!runId) {
      sendJson(res, 400, { error: "runId is required" });
      return true;
    }
    const entry = runIdToAbort.get(runId);
    if (!entry || entry.userId !== identity.userId || entry.orgId !== identity.orgId) {
      sendJson(res, 200, { ok: true, aborted: false });
      return true;
    }
    entry.controller.abort();
    runIdToAbort.delete(runId);
    sendJson(res, 200, { ok: true, aborted: true });
    return true;
  }

  // GET /api/fixit/chat/sessions
  if (req.method === "GET" && subPath === "chat/sessions") {
    try {
      const { getFixitDb } = await import("./mongo-sync.js");
      const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
      const cursor = db
        .collection("f_user_sessions")
        .find({ user_id: identity.userId })
        .toSorted({ updated_at: -1 })
        .limit(50);
      const sessions = await cursor.toArray();
      type SessionDoc = {
        session_id?: string;
        start_time?: Date;
        end_time?: Date | null;
        updated_at?: Date;
        metadata?: Record<string, unknown>;
      };
      sendJson(res, 200, {
        sessions: (sessions as SessionDoc[]).map((s) => ({
          sessionId: s.session_id,
          startTime: (s.start_time as Date)?.toISOString?.() ?? new Date().toISOString(),
          endTime: (s.end_time as Date)?.toISOString?.() ?? null,
          updatedAt: (s.updated_at as Date)?.toISOString?.() ?? new Date().toISOString(),
          metadata: s.metadata ?? {},
        })),
      });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to list sessions", details: String(err) });
    }
    return true;
  }

  // GET /api/fixit/chat/history?sessionId=...
  if (req.method === "GET" && subPath === "chat/history") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId query is required" });
      return true;
    }
    const limit = Math.min(
      100,
      Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
    );
    try {
      const { getFixitDb } = await import("./mongo-sync.js");
      const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
      const sessionDoc = await db.collection("f_user_sessions").findOne({
        user_id: identity.userId,
        session_id: sessionId,
      });
      if (!sessionDoc) {
        sendJson(res, 200, { messages: [], sessionId });
        return true;
      }
      const cursor = db
        .collection("f_user_messages")
        .find({ user_id: identity.userId, session_id: sessionDoc._id })
        .toSorted({ created_at: 1 })
        .limit(limit);
      const messages = await cursor.toArray();
      type MessageDoc = {
        message?: string;
        message_owner?: string;
        message_type?: string;
        created_at?: Date;
      };
      sendJson(res, 200, {
        messages: (messages as MessageDoc[]).map((m) => ({
          message: m.message,
          messageOwner: m.message_owner,
          messageType: m.message_type ?? "text",
          createdAt: (m.created_at as Date)?.toISOString?.() ?? new Date().toISOString(),
        })),
        sessionId,
      });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to get history", details: String(err) });
    }
    return true;
  }

  // POST /api/fixit/chat/sessions/new
  if (req.method === "POST" && subPath === "chat/sessions/new") {
    const newSessionId = randomUUID();
    const sessionKey = buildFixitSessionKeyForIdentity(identity, fixitConfig, newSessionId);
    try {
      const result = await getOrCreateFixitSession(
        identity,
        sessionKey,
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
        newSessionId,
      );
      sendJson(res, 200, { sessionId: result.sessionUuid });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to create session", details: String(err) });
    }
    return true;
  }

  // DELETE /api/fixit/chat/sessions/:id
  if (req.method === "DELETE" && subPath.startsWith("chat/sessions/")) {
    const id = subPath.replace(/^chat\/sessions\//, "").trim();
    if (!id) {
      sendJson(res, 400, { error: "session id required" });
      return true;
    }
    try {
      const { getFixitDb } = await import("./mongo-sync.js");
      const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
      const r = await db
        .collection("f_user_sessions")
        .updateOne(
          { user_id: identity.userId, session_id: id },
          { $set: { end_time: new Date(), updated_at: new Date() } },
        );
      sendJson(res, 200, { ok: true, updated: r.modifiedCount > 0 });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to archive session", details: String(err) });
    }
    return true;
  }

  // Direct data endpoints (dashboard) — stub for now; can be implemented to query d_lead etc. by org_id
  if (req.method === "GET" && subPath.startsWith("data/")) {
    sendJson(res, 501, {
      error: "Direct data endpoints not yet implemented",
      path: subPath,
    });
    return true;
  }

  sendJson(res, 404, { error: "Not Found", path: subPath });
  return true;
}

export { closeFixitMongoClient };
