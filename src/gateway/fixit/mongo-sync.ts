/**
 * Fixit Chatbot Integration — dual-write to Fixit MongoDB.
 * Writes chat messages to f_user_sessions and f_user_messages (schema-compatible with Python WhatsApp Agent).
 */

import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { MongoClient } from "mongodb";
import type { FixitChannelType, FixitIdentity } from "./types.js";

let cachedClient: MongoClient | null = null;

async function getClient(uri: string): Promise<MongoClient> {
  if (cachedClient) {
    return cachedClient;
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS: 30_000,
  });
  await client.connect();
  cachedClient = client;
  return client;
}

/** Return the Fixit DB for direct queries (sessions list, history, data endpoints). */
export async function getFixitDb(mongoUri: string, mongoDatabase: string) {
  const client = await getClient(mongoUri);
  return client.db(mongoDatabase);
}

export async function closeFixitMongoClient(): Promise<void> {
  if (cachedClient) {
    try {
      await cachedClient.close();
    } catch {
      // ignore on shutdown
    }
    cachedClient = null;
  }
}

export type GetOrCreateFixitSessionResult = {
  sessionObjectId: ObjectId;
  sessionUuid: string;
};

/**
 * Get or create an f_user_sessions document for this user (mirrors get_or_create_session from Python).
 * Schema aligns with fsc/db/models/f_user_sessions.py — includes channel_type per ChannelType enum.
 * @param frontendSessionId - Optional conversation id from the frontend; when provided, find or create by this id.
 * @param channelType - Channel type matching fsc.enums.ChannelType (e.g. "ui", "whatsapp").
 */
export async function getOrCreateFixitSession(
  identity: FixitIdentity,
  sessionKey: string,
  mongoUri: string,
  mongoDatabase: string,
  frontendSessionId?: string,
  channelType: FixitChannelType = "ui",
): Promise<GetOrCreateFixitSessionResult> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  const filter = frontendSessionId
    ? { user_id: identity.userId, session_id: frontendSessionId, channel_type: channelType }
    : { user_id: identity.userId, end_time: null, channel_type: channelType };

  const existing = await db.collection("f_user_sessions").findOne(filter);

  if (existing) {
    await db
      .collection("f_user_sessions")
      .updateOne(
        { _id: existing._id },
        { $set: { updated_at: new Date(), "metadata.openclaw_session_key": sessionKey } },
      );
    return {
      sessionObjectId: existing._id,
      sessionUuid: existing.session_id as string,
    };
  }

  const sessionId = frontendSessionId?.trim() || randomUUID();
  const result = await db.collection("f_user_sessions").insertOne({
    user_id: identity.userId,
    session_id: sessionId,
    start_time: new Date(),
    end_time: null,
    channel_type: channelType,
    metadata: { org_id: identity.orgId, source: "web_ui", openclaw_session_key: sessionKey },
    created_at: new Date(),
    updated_at: new Date(),
  });

  return {
    sessionObjectId: result.insertedId,
    sessionUuid: sessionId,
  };
}

// ---------------------------------------------------------------------------
// Workspace initialization (f_user_workspace)
// ---------------------------------------------------------------------------

export type WorkspaceDoc = {
  doc_id: string;
  doc_type: string;
  title: string;
  content_md: string;
};

export const CORE_DOC_TYPES = ["identity", "soul", "agents"] as const;

export type WorkspaceCheckResult = {
  /** "full" = all 3 core docs exist; "partial" = some exist; "empty" = none */
  status: "full" | "partial" | "empty";
  /** existing workspace docs for this org/user (may be empty) */
  docs: WorkspaceDoc[];
  /** which core doc_types are missing (empty when status=full) */
  missingTypes: string[];
};

/**
 * Check whether f_user_workspace has core docs for this org/user/campaign.
 * Returns granular status: full / partial / empty — so the agent can complete
 * only what's missing instead of re-onboarding from scratch.
 */
export async function checkOrInitWorkspace(
  identity: FixitIdentity,
  mongoUri: string,
  mongoDatabase: string,
): Promise<WorkspaceCheckResult> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  const scopeFilter: Record<string, unknown> = {
    org_id: identity.orgId,
    user_id: identity.userId,
    deleted_at: null,
  };
  if (identity.campaignId) {
    scopeFilter.campaign_id = identity.campaignId;
  }

  // Load ALL workspace docs (core + any custom ones like playbooks/reports)
  const cursor = db.collection("f_user_workspace").find(scopeFilter, {
    projection: { doc_id: 1, doc_type: 1, title: 1, content_md: 1, _id: 0 },
  });
  const rows = await cursor.toArray();

  const docs: WorkspaceDoc[] = rows
    .map((r) => ({
      doc_id: (r.doc_id as string) ?? "",
      doc_type: (r.doc_type as string) ?? "",
      title: (r.title as string) ?? "",
      content_md: (r.content_md as string) ?? "",
    }))
    .filter((d) => d.content_md.trim().length > 0);

  const foundTypes = new Set(docs.map((d) => d.doc_type));
  const missingTypes = CORE_DOC_TYPES.filter((t) => !foundTypes.has(t));

  const status: WorkspaceCheckResult["status"] =
    missingTypes.length === 0 ? "full" : docs.length === 0 ? "empty" : "partial";

  console.log(
    `[fixit] workspace: org=${identity.orgId} user=${identity.userId} status=${status} found=${docs.length} missing=[${missingTypes.join(",")}]`,
  );

  return { status, docs, missingTypes };
}

// ---------------------------------------------------------------------------
// Conversation history (f_user_messages)
// ---------------------------------------------------------------------------

export type HistoryMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

const MAX_SESSION_MESSAGES = 30;
const MAX_CROSS_SESSION_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 2000;

function truncateMsg(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) {
    return text;
  }
  return text.slice(0, MAX_MESSAGE_CHARS) + "… [truncated]";
}

/**
 * Load the most recent messages from the CURRENT session.
 * These become the conversation turns the agent sees as immediate context.
 */
export async function loadSessionHistory(
  sessionObjectId: ObjectId,
  userId: string,
  mongoUri: string,
  mongoDatabase: string,
): Promise<HistoryMessage[]> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  const cursor = db
    .collection("f_user_messages")
    .find(
      { user_id: userId, session_id: sessionObjectId },
      { projection: { message: 1, message_owner: 1, created_at: 1, _id: 0 } },
    )
    .toSorted({ created_at: -1 })
    .limit(MAX_SESSION_MESSAGES);
  const rows = await cursor.toArray();

  // Reverse so oldest first (chronological order for the agent)
  return rows.toReversed().map((r) => ({
    role: r.message_owner === "assistant" ? ("assistant" as const) : ("user" as const),
    text: truncateMsg((r.message as string) ?? ""),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : typeof r.created_at === "string"
          ? r.created_at
          : new Date().toISOString(),
  }));
}

/**
 * Load a small set of messages from the user's PREVIOUS sessions (not the current one).
 * Gives the agent cross-session memory — awareness of past conversations.
 */
export async function loadCrossSessionContext(
  currentSessionObjectId: ObjectId,
  userId: string,
  mongoUri: string,
  mongoDatabase: string,
): Promise<HistoryMessage[]> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  // Get the most recent messages from OTHER sessions
  const cursor = db
    .collection("f_user_messages")
    .find(
      {
        user_id: userId,
        session_id: { $ne: currentSessionObjectId },
        message_owner: { $in: ["user", "assistant"] },
      },
      { projection: { message: 1, message_owner: 1, created_at: 1, _id: 0 } },
    )
    .toSorted({ created_at: -1 })
    .limit(MAX_CROSS_SESSION_MESSAGES);
  const rows = await cursor.toArray();

  return rows.toReversed().map((r) => ({
    role: r.message_owner === "assistant" ? ("assistant" as const) : ("user" as const),
    text: truncateMsg((r.message as string) ?? ""),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : typeof r.created_at === "string"
          ? r.created_at
          : new Date().toISOString(),
  }));
}

/**
 * Run all pre-dispatch context loading in parallel for best latency.
 * Returns everything the agent context builder needs.
 */
export async function loadFullAgentContext(
  identity: FixitIdentity,
  sessionObjectId: ObjectId,
  mongoUri: string,
  mongoDatabase: string,
): Promise<{
  workspace: WorkspaceCheckResult;
  sessionHistory: HistoryMessage[];
  crossSessionHistory: HistoryMessage[];
}> {
  const [workspace, sessionHistory, crossSessionHistory] = await Promise.all([
    checkOrInitWorkspace(identity, mongoUri, mongoDatabase),
    loadSessionHistory(sessionObjectId, identity.userId, mongoUri, mongoDatabase),
    loadCrossSessionContext(sessionObjectId, identity.userId, mongoUri, mongoDatabase),
  ]);

  console.log(
    `[fixit] context loaded: workspace=${workspace.status} sessionMsgs=${sessionHistory.length} crossSessionMsgs=${crossSessionHistory.length}`,
  );

  return { workspace, sessionHistory, crossSessionHistory };
}

// ---------------------------------------------------------------------------
// Message recording
// ---------------------------------------------------------------------------

export type RecordFixitMessageParams = {
  userId: string;
  sessionObjectId: ObjectId;
  message: string;
  messageType: "text" | "image" | "video" | "document" | "audio";
  messageOwner: "user" | "assistant";
  channelType?: FixitChannelType;
};

/**
 * Insert one message into f_user_messages (mirrors log_conversation from Python).
 * Also updates the corresponding f_user_sessions document so updated_at reflects last activity.
 * Schema aligns with fsc/db/models/f_user_messages.py — includes channel_type per ChannelType enum.
 */
export async function recordFixitMessage(
  params: RecordFixitMessageParams,
  mongoUri: string,
  mongoDatabase: string,
): Promise<void> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);
  const now = new Date();

  await db.collection("f_user_messages").insertOne({
    user_id: params.userId,
    session_id: params.sessionObjectId,
    message_id: randomUUID(),
    message: params.message,
    message_type: params.messageType,
    message_owner: params.messageOwner,
    channel_type: params.channelType ?? "ui",
    created_at: now,
    updated_at: now,
  });

  // Keep f_user_sessions in sync: bump updated_at on every message so session list reflects last activity
  await db
    .collection("f_user_sessions")
    .updateOne({ _id: params.sessionObjectId }, { $set: { updated_at: now } });
}
