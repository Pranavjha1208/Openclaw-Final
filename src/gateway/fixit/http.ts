/**
 * Fixit Chatbot Integration — REST + SSE HTTP handler.
 * All Fixit endpoints under basePath: auth/verify, chat/send (SSE), chat/abort, sessions, history, data/*.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, readdirSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import { onAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { runWithFixitScope } from "../../infra/fixit-request-scope.js";
import { readJsonBody } from "../hooks.js";
import { sendJson, setSseHeaders } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import { buildFixitAgentContext } from "./agent-context.js";
import {
  authenticateFixitRequest,
  signFixitJwt,
  verifyFixitJwt,
  verifyFirebaseFixitJwt,
} from "./auth.js";
import type { FixitConfigResolved } from "./config.js";
import { applyFixitCorsHeaders, handleFixitOptions } from "./cors.js";
import {
  getOrCreateFixitSession,
  recordFixitMessage,
  closeFixitMongoClient,
  loadFullAgentContext,
  checkOrInitWorkspace,
  getOrgIdForUser,
  type GetOrCreateFixitSessionResult,
} from "./mongo-sync.js";
import { buildFixitSessionKeyForIdentity, resolveFixitAgent } from "./session.js";
import type { FixitIdentity } from "./types.js";
import type {
  FixitChannelType,
  FixitChatSendBody,
  FixitSseEvent,
  FixitAuthVerifyResponse,
  FixitChatAbortBody,
} from "./types.js";

const FIXIT_UI_CHANNEL: FixitChannelType = "ui";

function normalizeChatTitle(input: string): string {
  const collapsed = input
    .replace(/[#*_`>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) {
    return "New chat";
  }
  const firstSentence = collapsed.split(/[.!?\n]/, 1)[0]?.trim() ?? collapsed;
  const words = firstSentence.split(/\s+/).filter(Boolean).slice(0, 7);
  const title = words.join(" ").trim();
  if (!title) {
    return "New chat";
  }
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}...` : title;
}

function buildMessagePreview(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return collapsed.length > 120 ? `${collapsed.slice(0, 117).trimEnd()}...` : collapsed;
}

function describeFixitScope(identity: FixitIdentity): string {
  return `org=${identity.orgId} user=${identity.userId}${identity.campaignId ? ` campaign=${identity.campaignId}` : ""}`;
}

function resolveEffectiveFixitIdentity(
  identity: FixitIdentity,
  bodyCampaignId?: string,
): FixitIdentity {
  const requestedCampaignId = bodyCampaignId?.trim() || undefined;
  if (identity.campaignId && requestedCampaignId && identity.campaignId !== requestedCampaignId) {
    throw new Error(
      `campaignId mismatch: token is scoped to ${identity.campaignId} but request asked for ${requestedCampaignId}`,
    );
  }
  return requestedCampaignId ? { ...identity, campaignId: requestedCampaignId } : identity;
}

async function ensureSessionTitle(params: {
  db: Awaited<ReturnType<typeof import("./mongo-sync.js").getFixitDb>>;
  sessionObjectId: unknown;
  sessionUuid: string;
  userId: string;
  orgId: string;
}): Promise<string> {
  const sessionDoc = (await params.db.collection("f_user_sessions").findOne(
    {
      _id: params.sessionObjectId,
      user_id: params.userId,
      "metadata.org_id": params.orgId,
      channel_type: FIXIT_UI_CHANNEL,
    },
    { projection: { metadata: 1, _id: 0 } },
  )) as { metadata?: Record<string, unknown> } | null;

  const existingTitle = sessionDoc?.metadata?.title;
  if (typeof existingTitle === "string" && existingTitle.trim()) {
    return existingTitle.trim();
  }

  const messageCount = await params.db.collection("f_user_messages").countDocuments({
    user_id: params.userId,
    session_id: params.sessionObjectId,
    message_owner: { $in: ["user", "assistant"] },
  });
  if (messageCount < 3) {
    return "New chat";
  }

  const firstUserMessage = (await params.db
    .collection("f_user_messages")
    .findOne(
      { user_id: params.userId, session_id: params.sessionObjectId, message_owner: "user" },
      { sort: { created_at: 1 }, projection: { message: 1, _id: 0 } },
    )) as { message?: string } | null;
  const title = normalizeChatTitle(firstUserMessage?.message ?? params.sessionUuid);

  await params.db.collection("f_user_sessions").updateOne(
    {
      _id: params.sessionObjectId,
      user_id: params.userId,
      "metadata.org_id": params.orgId,
      channel_type: FIXIT_UI_CHANNEL,
    },
    {
      $set: {
        "metadata.title": title,
        "metadata.title_generated_at": new Date(),
        updated_at: new Date(),
      },
    },
  );

  return title;
}

/**
 * Resolve Fixit identity for the request. When authMode is "firebase", verifies Firebase JWT and
 * resolves org_id from d_user; otherwise uses HS256 JWT with org_id/user_id in payload.
 * Sends 401/403 and returns null on failure.
 */
async function resolveFixitIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  fixitConfig: FixitConfigResolved,
  logRequest?: (phase: string, details?: Record<string, unknown>) => void,
): Promise<FixitIdentity | null> {
  const token = getBearerToken(req);
  if (!token) {
    logRequest?.("auth", {
      outcome: "missing_authorization_header",
      authMode: fixitConfig.authMode,
    });
    console.log("[fixit] auth: missing Authorization header");
    sendJson(res, 401, { error: "Missing Authorization header" });
    return null;
  }

  if (fixitConfig.authMode === "firebase") {
    try {
      const { userId: userIdFromJwt, phoneNumber } = await verifyFirebaseFixitJwt(
        token,
        fixitConfig.firebaseProjectId,
      );
      logRequest?.("auth", {
        outcome: "firebase_verified",
        authMode: fixitConfig.authMode,
        token: token,
        firebaseProjectId: fixitConfig.firebaseProjectId,
        userIdFromJwt,
        phoneNumber,
      });
      console.log(`[fixit] auth: JWT userId=${userIdFromJwt} phoneNumber=${phoneNumber ?? "—"}`);
      const resolved = await getOrgIdForUser(
        userIdFromJwt,
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
        phoneNumber,
      );
      if (!resolved) {
        logRequest?.("auth", {
          outcome: "user_org_not_found",
          authMode: fixitConfig.authMode,
          token,
          userIdFromJwt,
          phoneNumber,
        });
        console.log(
          `[fixit] auth: user not in d_user (userIdFromJwt=${userIdFromJwt.slice(0, 12)}… phone=${phoneNumber ?? "—"})`,
        );
        sendJson(res, 403, { error: "User organization not found" });
        return null;
      }
      logRequest?.("auth", {
        outcome: "identity_resolved",
        authMode: fixitConfig.authMode,
        orgId: resolved.orgId,
        userId: resolved.userId,
      });
      console.log(`[fixit] auth: from d_user orgId=${resolved.orgId} userId=${resolved.userId}`);
      const identity: FixitIdentity = {
        orgId: resolved.orgId,
        userId: resolved.userId,
        role: "user",
      };
      return identity;
    } catch (err) {
      logRequest?.("auth", {
        outcome: "firebase_verify_failed",
        authMode: fixitConfig.authMode,
        token,
        error: String(err),
      });
      console.log("[fixit] auth: Firebase token invalid or expired:", String(err));
      sendJson(res, 401, { error: "Invalid or expired token", details: String(err) });
      return null;
    }
  }

  return authenticateFixitRequest(req, res, fixitConfig.jwtSecret);
}

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export type FixitHttpOptions = {
  fixitConfig: FixitConfigResolved;
  loadConfig: () => OpenClawConfig;
};

const runIdToAbort = new Map<
  string,
  { controller: AbortController; userId: string; orgId: string }
>();
const FIXIT_LOG_MAX_TEXT = 2000;
const FIXIT_LOG_MAX_ARRAY_ITEMS = 20;

function truncateFixitLogText(value: string, max = FIXIT_LOG_MAX_TEXT): string {
  return value.length > max ? `${value.slice(0, max).trimEnd()}... [truncated]` : value;
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function summarizeJwtLikeString(value: string): Record<string, unknown> | null {
  const token = value.trim();
  const jwtMatch = token.match(/^(?:Bearer\s+)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
  if (!jwtMatch) {
    return null;
  }
  const rawToken = jwtMatch[1] ?? "";
  const payloadSegment = rawToken.split(".")[1] ?? "";
  const decodedPayload = decodeBase64Url(payloadSegment);
  let payload: Record<string, unknown> | null = null;
  if (decodedPayload) {
    try {
      payload = JSON.parse(decodedPayload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  const iat = typeof payload?.iat === "number" ? payload.iat : null;
  return {
    kind: /^Bearer\s+/i.test(token) ? "bearer_jwt" : "jwt",
    length: rawToken.length,
    headerPreview: `${rawToken.slice(0, 12)}...${rawToken.slice(-8)}`,
    iss: payload?.iss,
    aud: payload?.aud,
    sub: payload?.sub,
    user_id: payload?.user_id,
    phone_number: payload?.phone_number,
    iat,
    iatIso: iat ? new Date(iat * 1000).toISOString() : null,
    exp,
    expIso: exp ? new Date(exp * 1000).toISOString() : null,
    expired: typeof exp === "number" ? exp * 1000 <= Date.now() : null,
  };
}

function sanitizeFixitLogValue(value: unknown, depth = 0): unknown {
  if (value == null) {
    return value;
  }
  if (depth > 4) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    const jwtSummary = summarizeJwtLikeString(value);
    if (jwtSummary) {
      return { redacted: true, tokenSummary: jwtSummary };
    }
    return truncateFixitLogText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return value.name ? `[function ${value.name}]` : "[function anonymous]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, FIXIT_LOG_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeFixitLogValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|token|secret|password|api[_-]?key|sas|accountkey/i.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      if (key === "content") {
        output[key] = "[omitted]";
        continue;
      }
      output[key] = sanitizeFixitLogValue(entry, depth + 1);
    }
    return output;
  }
  return "[unsupported]";
}

function serializeFixitLogValue(value: unknown): string {
  try {
    return JSON.stringify(sanitizeFixitLogValue(value));
  } catch {
    return '"[unserializable]"';
  }
}

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

  const origin = getOrigin(req);
  const applyCors = () => applyFixitCorsHeaders(res, fixitConfig.corsAllowOrigins, origin);
  const subPath = pathname.slice(basePath.length).replace(/^\/+/, "") || "";
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const requestLabel = `${req.method ?? "GET"} ${pathname}`;
  let responsePreview = "";
  let capturedBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const captureResponseChunk = (chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk == null || capturedBytes >= FIXIT_LOG_MAX_TEXT) {
      return;
    }
    let text = "";
    if (typeof chunk === "string") {
      text = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString(encoding ?? "utf8");
    } else if (chunk instanceof Uint8Array) {
      text = Buffer.from(chunk).toString(encoding ?? "utf8");
    } else {
      text = serializeFixitLogValue(chunk);
    }
    if (!text) {
      return;
    }
    const remaining = FIXIT_LOG_MAX_TEXT - capturedBytes;
    responsePreview += text.slice(0, remaining);
    capturedBytes += Math.min(text.length, remaining);
  };

  res.write = ((
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ) => {
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
    const resolvedCallback = typeof encoding === "function" ? encoding : cb;
    captureResponseChunk(chunk, resolvedEncoding);
    return originalWrite(chunk as never, encoding as never, resolvedCallback as never);
  }) as typeof res.write;

  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
    const resolvedCallback = typeof encoding === "function" ? encoding : cb;
    captureResponseChunk(chunk, resolvedEncoding);
    return originalEnd(chunk as never, encoding as never, resolvedCallback as never);
  }) as typeof res.end;

  const logRequest = (phase: string, details?: Record<string, unknown>) => {
    const suffix = details ? ` ${serializeFixitLogValue(details)}` : "";
    console.log(`[fixit][${requestId}] ${phase}: ${requestLabel}${suffix}`);
  };

  const logRequestBody = (label: string, body: unknown) => {
    logRequest(label, { body });
  };

  const writeFixitSseEventLogged = (event: FixitSseEvent): void => {
    logRequest("sse", {
      event: event.type,
      payload:
        event.type === "delta"
          ? { text: event.text }
          : event.type === "tool_call"
            ? { name: event.name, status: event.status }
            : event.type === "done"
              ? {
                  sessionId: event.sessionId,
                  runId: event.runId,
                  chatTitle: event.chatTitle,
                  text: event.text,
                }
              : { error: event.error },
    });
    writeFixitSseEvent(res, event);
  };

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const contentType = String(res.getHeader("content-type") ?? "");
    const contentLength = String(res.getHeader("content-length") ?? "");
    const responseDetails =
      contentType.includes("application/json") ||
      contentType.includes("text/") ||
      contentType.includes("event-stream")
        ? truncateFixitLogText(responsePreview)
        : contentLength
          ? `[non-text body omitted; content-length=${contentLength}]`
          : "[non-text body omitted]";
    logRequest("end", {
      statusCode: res.statusCode,
      durationMs,
      contentType,
      response: responseDetails,
    });
  });

  logRequest("start", {
    origin: origin ?? "none",
    subPath,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      authorization: req.headers.authorization ? "[present]" : "[missing]",
      authorizationScheme:
        typeof req.headers.authorization === "string"
          ? (req.headers.authorization.split(/\s+/, 1)[0] ?? "").toLowerCase()
          : undefined,
    },
  });

  if (req.method === "OPTIONS") {
    console.log("[fixit] handling CORS preflight");
    applyCors();
    return handleFixitOptions(req, res, fixitConfig.corsAllowOrigins);
  }

  applyCors();

  // POST /api/fixit/dev/jwt — issue test JWT (no auth; testing only when allowDevJwt is true)
  if (req.method === "POST" && subPath === "dev/jwt" && fixitConfig.allowDevJwt) {
    const bodyResult = await readJsonBody(req, 64 * 1024);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error ?? "Bad request" });
      return true;
    }
    const raw = bodyResult.value as Record<string, unknown>;
    logRequestBody("request", raw);
    const orgId = typeof raw?.orgId === "string" ? raw.orgId.trim() : "";
    const userId = typeof raw?.userId === "string" ? raw.userId.trim() : "";
    const campaignId = typeof raw?.campaignId === "string" ? raw.campaignId.trim() : "";
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
      ...(campaignId ? { campaign_id: campaignId } : {}),
    };
    const token = signFixitJwt(payload, fixitConfig.jwtSecret);
    console.log(
      `[fixit] dev/jwt issued for org=${orgId} user=${userId}${
        campaignId ? ` campaign=${campaignId}` : ""
      }`,
    );
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
      if (fixitConfig.authMode === "firebase") {
        await verifyFirebaseFixitJwt(queryToken, fixitConfig.firebaseProjectId);
      } else {
        verifyFixitJwt(queryToken, fixitConfig.jwtSecret);
      }
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
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ??
      join(process.cwd(), ".openclaw-local") ??
      join(homeDir, ".openclaw");
    const workspaceRoot = resolve(join(stateDir, "workspace"));
    const fixitExportsRoot = resolve(join(stateDir, "fixit-exports"));
    const resolved = resolve(filePath.startsWith("~") ? filePath.replace(/^~/, homeDir) : filePath);
    const underWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + sep);
    const underExports =
      resolved === fixitExportsRoot || resolved.startsWith(fixitExportsRoot + sep);
    if (!underWorkspace && !underExports) {
      sendJson(res, 403, {
        error: "File must be under workspace or fixit-exports",
      });
      return true;
    }
    // Remove fixit-exports files older than 2 days (temp CSV downloads).
    try {
      if (readdirSync(fixitExportsRoot, { withFileTypes: true }).length > 0) {
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const ent of readdirSync(fixitExportsRoot, { withFileTypes: true })) {
          if (!ent.isFile()) {
            continue;
          }
          const p = join(fixitExportsRoot, ent.name);
          const st = statSync(p);
          if (now - st.mtimeMs > twoDaysMs) {
            unlinkSync(p);
          }
        }
      }
    } catch {
      // Ignore cleanup errors (e.g. dir missing).
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

  const identity = await resolveFixitIdentity(req, res, fixitConfig, logRequest);
  if (!identity) {
    console.log("[fixit] auth failed — returned 401/403");
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
      campaignId: identity.campaignId,
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
    logRequestBody("request", raw);
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
    const requestedCampaignId =
      typeof (raw as FixitChatSendBody).campaignId === "string"
        ? (raw as FixitChatSendBody).campaignId.trim()
        : "";
    let effectiveIdentity: FixitIdentity;
    try {
      effectiveIdentity = resolveEffectiveFixitIdentity(identity, requestedCampaignId);
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
      return true;
    }
    const sessionKey = buildFixitSessionKeyForIdentity(effectiveIdentity, fixitConfig, sessionId);

    let sessionResult: GetOrCreateFixitSessionResult;
    try {
      sessionResult = await getOrCreateFixitSession(
        effectiveIdentity,
        sessionKey,
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
        sessionId,
        FIXIT_UI_CHANNEL,
      );
    } catch (err) {
      const messageText = String(err);
      const status = messageText.includes("campaign scope mismatch") ? 409 : 500;
      sendJson(res, status, { error: "Failed to get or create session", details: messageText });
      return true;
    }

    const { sessionObjectId, sessionUuid } = sessionResult;
    try {
      await recordFixitMessage(
        {
          userId: effectiveIdentity.userId,
          sessionObjectId,
          message,
          messageType: "text",
          messageOwner: "user",
          channelType: FIXIT_UI_CHANNEL,
        },
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
      );
    } catch (err) {
      sendJson(res, 500, { error: "Failed to record message", details: String(err) });
      return true;
    }

    // Load all context in parallel: workspace + session history + cross-session.
    // If full load fails (e.g. session history query), still load workspace so we never drop the profile.
    let agentCtxData: Awaited<ReturnType<typeof loadFullAgentContext>> | undefined;
    try {
      agentCtxData = await loadFullAgentContext(
        effectiveIdentity,
        sessionObjectId,
        fixitConfig.mongoUri,
        fixitConfig.mongoDatabase,
      );
    } catch (err) {
      console.warn("[fixit] context loading failed, loading workspace only:", err);
      try {
        const workspace = await checkOrInitWorkspace(
          effectiveIdentity,
          fixitConfig.mongoUri,
          fixitConfig.mongoDatabase,
        );
        agentCtxData = {
          workspace,
          sessionHistory: [],
          crossSessionHistory: [],
        };
      } catch (workspaceErr) {
        console.warn("[fixit] workspace fallback failed:", workspaceErr);
      }
    }

    const runId = randomUUID();
    console.log(
      `[fixit] chat/send: message="${message.slice(0, 60)}" session=${sessionUuid.slice(0, 8)} runId=${runId.slice(0, 8)} workspace=${agentCtxData?.workspace.initialized ? "loaded" : "new"} history=${agentCtxData?.sessionHistory.length ?? 0}+${agentCtxData?.crossSessionHistory.length ?? 0}${
        effectiveIdentity.campaignId ? ` campaign=${effectiveIdentity.campaignId}` : ""
      }`,
    );
    const abortController = new AbortController();
    runIdToAbort.set(runId, {
      controller: abortController,
      userId: effectiveIdentity.userId,
      orgId: effectiveIdentity.orgId,
    });
    registerAgentRunContext(runId, { sessionKey });

    setSseHeaders(res);
    logRequest("sse-start", { sessionId: sessionUuid, runId });

    let fullText = "";
    let chatTitle = "New chat";
    let doneSent = false;
    const sendDone = () => {
      if (doneSent) {
        return;
      }
      doneSent = true;
      runIdToAbort.delete(runId);
      writeFixitSseEventLogged({
        type: "done",
        text: fullText,
        sessionId: sessionUuid,
        runId,
        chatTitle,
      });
      res.end();
    };

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        if (typeof payload.text === "string" && payload.text.trim()) {
          const nextText = payload.text;
          fullText += nextText;
          writeFixitSseEventLogged({ type: "delta", text: nextText });
          logRequest("reply-deliver", {
            kind: info.kind,
            text: nextText,
          });
        }
      },
    });

    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId !== runId) {
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
        writeFixitSseEventLogged({ type: "tool_call", name, status });
        return;
      }
      if (evt.stream === "lifecycle") {
        const phase = evt.data?.phase;
        logRequest("agent-lifecycle", { phase });
      }
    });

    req.on("close", () => {
      unsubscribe();
      runIdToAbort.delete(runId);
    });

    void runWithFixitScope(
      {
        orgId: effectiveIdentity.orgId,
        userId: effectiveIdentity.userId,
        ...(effectiveIdentity.campaignId ? { campaignId: effectiveIdentity.campaignId } : {}),
      },
      async () => {
        try {
          await dispatchInboundMessage({
            ctx: {
              Body: message,
              SessionKey: sessionKey,
              Provider: "fixit",
              Surface: "fixit-web",
              OriginatingChannel: "fixit",
              From: `fixit:${effectiveIdentity.orgId}:${effectiveIdentity.userId}`,
              GroupSystemPrompt: buildFixitAgentContext({
                identity: effectiveIdentity,
                workspace: agentCtxData?.workspace,
                sessionHistory: agentCtxData?.sessionHistory,
                crossSessionHistory: agentCtxData?.crossSessionHistory,
                agentId: resolveFixitAgent(fixitConfig, effectiveIdentity.orgId),
              }),
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
            writeFixitSseEventLogged({ type: "error", error: String(err) });
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
                userId: effectiveIdentity.userId,
                sessionObjectId,
                message: fullText.trim(),
                messageType: "text",
                messageOwner: "assistant",
                channelType: FIXIT_UI_CHANNEL,
              },
              fixitConfig.mongoUri,
              fixitConfig.mongoDatabase,
            );
          }
        } catch {
          // best-effort; response already streamed
        }

        try {
          const { getFixitDb } = await import("./mongo-sync.js");
          const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
          chatTitle = await ensureSessionTitle({
            db,
            sessionObjectId,
            sessionUuid,
            userId: effectiveIdentity.userId,
            orgId: effectiveIdentity.orgId,
          });
        } catch {
          // best-effort; session list can still fall back to metadata/session id
        }

        sendDone();
      },
    );
    return true;
  }

  // POST /api/fixit/chat/abort
  if (req.method === "POST" && subPath === "chat/abort") {
    const bodyResult = await readJsonBody(req, 64 * 1024);
    const body =
      bodyResult.ok && typeof bodyResult.value === "object"
        ? (bodyResult.value as FixitChatAbortBody)
        : {};
    logRequestBody("request", body);
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
      console.log(`[fixit] chat/sessions: listing for ${describeFixitScope(identity)}`);
      const { getFixitDb } = await import("./mongo-sync.js");
      const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
      const sessions = await db
        .collection("f_user_sessions")
        .find({
          user_id: identity.userId,
          channel_type: FIXIT_UI_CHANNEL,
          "metadata.org_id": identity.orgId,
        })
        .limit(50)
        .toArray();
      console.log(
        `[fixit] chat/sessions: fetched ${sessions.length} raw sessions for ${describeFixitScope(identity)}`,
      );
      type SessionDoc = {
        _id?: unknown;
        session_id?: string;
        start_time?: Date;
        end_time?: Date | null;
        updated_at?: Date;
        channel_type?: string;
        metadata?: Record<string, unknown>;
      };
      type MessagePreviewDoc = { message?: string };
      const enrichedSessions = await Promise.all(
        (sessions as SessionDoc[])
          .slice()
          .toSorted((a, b) => {
            const aTime =
              a.updated_at instanceof Date
                ? a.updated_at.getTime()
                : a.updated_at
                  ? new Date(String(a.updated_at)).getTime()
                  : 0;
            const bTime =
              b.updated_at instanceof Date
                ? b.updated_at.getTime()
                : b.updated_at
                  ? new Date(String(b.updated_at)).getTime()
                  : 0;
            return bTime - aTime;
          })
          .map(async (s) => {
            const messageCount = await db.collection("f_user_messages").countDocuments({
              user_id: identity.userId,
              session_id: s._id,
            });
            const lastMessage = (await db
              .collection("f_user_messages")
              .findOne(
                { user_id: identity.userId, session_id: s._id },
                { sort: { created_at: -1 }, projection: { message: 1, _id: 0 } },
              )) as MessagePreviewDoc | null;
            const savedTitle = s.metadata?.title;
            const title =
              typeof savedTitle === "string" && savedTitle.trim()
                ? savedTitle.trim()
                : normalizeChatTitle(lastMessage?.message ?? "New chat");
            return {
              sessionId: s.session_id,
              title,
              startTime: (s.start_time as Date)?.toISOString?.() ?? new Date().toISOString(),
              endTime: (s.end_time as Date)?.toISOString?.() ?? null,
              updatedAt: (s.updated_at as Date)?.toISOString?.() ?? new Date().toISOString(),
              channelType: s.channel_type ?? FIXIT_UI_CHANNEL,
              messageCount,
              lastMessagePreview: buildMessagePreview(lastMessage?.message ?? ""),
              metadata: s.metadata ?? {},
            };
          }),
      );
      sendJson(res, 200, {
        sessions: enrichedSessions,
      });
    } catch (err) {
      console.error(`[fixit] chat/sessions: failed for ${describeFixitScope(identity)}:`, err);
      sendJson(res, 500, { error: "Failed to list sessions", details: String(err) });
    }
    return true;
  }

  // GET /api/fixit/chat/history?sessionId=...
  if (req.method === "GET" && subPath === "chat/history") {
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId && /^Bearer\s+/i.test(sessionId)) {
      logRequest("warning", {
        reason: "sessionId_looks_like_authorization_header",
        sessionId,
      });
    }
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId query is required" });
      return true;
    }
    const limit = Math.min(
      100,
      Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
    );
    try {
      console.log(
        `[fixit] chat/history: loading session=${sessionId} limit=${limit} for ${describeFixitScope(identity)}`,
      );
      const { getFixitDb } = await import("./mongo-sync.js");
      const db = await getFixitDb(fixitConfig.mongoUri, fixitConfig.mongoDatabase);
      const sessionDoc = (await db.collection("f_user_sessions").findOne({
        user_id: identity.userId,
        session_id: sessionId,
        channel_type: FIXIT_UI_CHANNEL,
        "metadata.org_id": identity.orgId,
      })) as { _id: unknown; metadata?: Record<string, unknown> } | null;
      if (!sessionDoc) {
        console.warn(
          `[fixit] chat/history: session not found session=${sessionId} for ${describeFixitScope(identity)}`,
        );
        sendJson(res, 200, { messages: [], sessionId });
        return true;
      }
      const messages = await db
        .collection("f_user_messages")
        .find({ user_id: identity.userId, session_id: sessionDoc._id })
        .limit(limit)
        .toArray();
      console.log(
        `[fixit] chat/history: fetched ${messages.length} raw messages for session=${sessionId} ${describeFixitScope(identity)}`,
      );
      type MessageDoc = {
        message?: string;
        message_owner?: string;
        message_type?: string;
        channel_type?: string;
        created_at?: Date;
      };
      sendJson(res, 200, {
        messages: (messages as MessageDoc[])
          .slice()
          .toSorted((a, b) => {
            const aTime =
              a.created_at instanceof Date
                ? a.created_at.getTime()
                : a.created_at
                  ? new Date(String(a.created_at)).getTime()
                  : 0;
            const bTime =
              b.created_at instanceof Date
                ? b.created_at.getTime()
                : b.created_at
                  ? new Date(String(b.created_at)).getTime()
                  : 0;
            return aTime - bTime;
          })
          .map((m) => ({
            message: m.message,
            messageOwner: m.message_owner,
            messageType: m.message_type ?? "text",
            channelType: m.channel_type ?? FIXIT_UI_CHANNEL,
            createdAt: (m.created_at as Date)?.toISOString?.() ?? new Date().toISOString(),
          })),
        sessionId,
        title:
          typeof sessionDoc.metadata?.title === "string" && sessionDoc.metadata.title.trim()
            ? sessionDoc.metadata.title.trim()
            : "New chat",
      });
    } catch (err) {
      console.error(
        `[fixit] chat/history: failed session=${sessionId} for ${describeFixitScope(identity)}:`,
        err,
      );
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
        FIXIT_UI_CHANNEL,
      );
      sendJson(res, 200, { sessionId: result.sessionUuid, title: "New chat" });
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
      const r = await db.collection("f_user_sessions").updateOne(
        {
          user_id: identity.userId,
          session_id: id,
          channel_type: FIXIT_UI_CHANNEL,
          "metadata.org_id": identity.orgId,
        },
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
