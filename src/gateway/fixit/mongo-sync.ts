/**
 * Fixit Chatbot Integration — dual-write to Fixit MongoDB.
 * Writes chat messages to f_user_sessions and f_user_messages (schema-compatible with Python WhatsApp Agent).
 */

import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { MongoClient, ObjectId as MongoObjectId } from "mongodb";
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

/** User document from d_user; org may be string, embedded { org_id }, or ObjectId reference. */
type DUserDoc = {
  user_id?: string;
  org_id?: string;
  org?: { org_id?: string } | ObjectId;
  phone_number?: string;
  phone?: string;
};

/** d_org document: _id (ObjectId) and org_id (string). */
type DOrgDoc = { _id?: ObjectId; org_id?: string };

/**
 * Resolve org_id for a user by querying d_user (Fixit schema: D_User with org).
 * Tries user_id from JWT, then phone (with/without +), then phone_number field.
 * When org is an ObjectId reference, looks up d_org by _id to get org_id string.
 * Returns { orgId, userId } for use as FixitIdentity.
 */
export async function getOrgIdForUser(
  userIdFromJwt: string,
  mongoUri: string,
  mongoDatabase: string,
  phoneNumber?: string,
): Promise<{ orgId: string; userId: string } | null> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);
  const coll = db.collection<DUserDoc>("d_user");

  const orConditions: Record<string, unknown>[] = [{ user_id: userIdFromJwt }];
  if (phoneNumber) {
    const normalized = phoneNumber.replace(/^\++/, "").trim();
    if (normalized && normalized !== userIdFromJwt) {
      orConditions.push({ user_id: normalized });
      orConditions.push({ user_id: `+${normalized}` });
      orConditions.push({ phone_number: phoneNumber });
      orConditions.push({ phone_number: normalized });
      orConditions.push({ phone: phoneNumber });
      orConditions.push({ phone: normalized });
    }
  }

  console.log(
    `[fixit] getOrgIdForUser: querying d_user with userIdFromJwt=${userIdFromJwt} phoneNumber=${phoneNumber ?? "—"}`,
  );
  const doc = await coll.findOne({ $or: orConditions });
  if (!doc) {
    console.log("[fixit] getOrgIdForUser: no d_user document found");
    return null;
  }

  let orgId =
    (typeof doc.org_id === "string" && doc.org_id.trim()) ||
    (doc.org &&
      typeof doc.org === "object" &&
      !(doc.org instanceof MongoObjectId) &&
      "org_id" in doc.org &&
      typeof (doc.org as { org_id?: string }).org_id === "string" &&
      (doc.org as { org_id: string }).org_id.trim()) ||
    "";

  if (!orgId && doc.org) {
    let orgRef: MongoObjectId | null = null;
    if (doc.org instanceof MongoObjectId) {
      orgRef = doc.org;
    } else if (
      doc.org &&
      typeof doc.org === "object" &&
      "$oid" in doc.org &&
      typeof (doc.org as { $oid: string }).$oid === "string"
    ) {
      orgRef = new MongoObjectId((doc.org as { $oid: string }).$oid);
    }
    if (orgRef) {
      const orgDoc = await db.collection<DOrgDoc>("d_org").findOne({ _id: orgRef });
      if (orgDoc && typeof orgDoc.org_id === "string" && orgDoc.org_id.trim()) {
        orgId = orgDoc.org_id.trim();
        console.log(`[fixit] getOrgIdForUser: resolved org ref to orgId=${orgId}`);
      }
    }
  }

  const userId = (typeof doc.user_id === "string" && doc.user_id.trim()) || userIdFromJwt;
  console.log(
    `[fixit] getOrgIdForUser: found d_user orgId=${orgId} userId=${userId} (doc.user_id=${typeof doc.user_id === "string" ? doc.user_id : "—"})`,
  );
  if (!orgId) {
    console.log(
      "[fixit] getOrgIdForUser: doc has no org_id / org.org_id and d_org lookup failed or missing",
    );
    return null;
  }
  return { orgId, userId };
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

/** The single workspace doc type that stores all user profile info. */
export const WORKSPACE_PROFILE_DOC_ID = "profile";

export type WorkspaceCheckResult = {
  /** true when a profile doc exists with content */
  initialized: boolean;
  /** the profile doc if it exists (null otherwise) */
  profile: WorkspaceDoc | null;
  /** any additional workspace docs (reports, playbooks, etc.) */
  extras: WorkspaceDoc[];
};

/**
 * Check whether f_user_workspace has a profile doc for this org/user/campaign.
 * Returns initialized=true when the single "profile" doc exists with content.
 * Matches deleted_at null or missing. When identity has campaignId, tries campaign-scoped
 * first then falls back to campaign_id: null so the global profile is found after refresh.
 */
export async function checkOrInitWorkspace(
  identity: FixitIdentity,
  mongoUri: string,
  mongoDatabase: string,
): Promise<WorkspaceCheckResult> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);
  const coll = db.collection("f_user_workspace");
  const projection = { doc_id: 1, doc_type: 1, title: 1, content_md: 1, _id: 0 };

  // Match deleted_at null or missing (some writers may omit the field).
  const deletedOk = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };

  const baseFilter: Record<string, unknown> = {
    org_id: identity.orgId,
    user_id: identity.userId,
    ...deletedOk,
  };

  let rows: Array<Record<string, unknown>>;
  if (identity.campaignId) {
    const scopedFilter = { ...baseFilter, campaign_id: identity.campaignId };
    rows = await coll.find(scopedFilter, { projection }).toArray();
    // If no profile found (e.g. profile was saved with campaign_id: null), use global profile.
    if (rows.length === 0 || !rows.some((r) => (r.doc_id as string) === WORKSPACE_PROFILE_DOC_ID)) {
      const globalFilter = { ...baseFilter, campaign_id: null };
      const globalRows = await coll.find(globalFilter, { projection }).toArray();
      rows = globalRows.length > 0 ? globalRows : rows;
    }
  } else {
    rows = await coll.find(baseFilter, { projection }).toArray();
  }

  const docs: WorkspaceDoc[] = rows
    .map((r) => ({
      doc_id: (r.doc_id as string) ?? "",
      doc_type: (r.doc_type as string) ?? "",
      title: (r.title as string) ?? "",
      content_md: (r.content_md as string) ?? "",
    }))
    .filter((d) => d.content_md.trim().length > 0);

  const profile = docs.find((d) => d.doc_id === WORKSPACE_PROFILE_DOC_ID) ?? null;
  const extras = docs.filter((d) => d.doc_id !== WORKSPACE_PROFILE_DOC_ID);
  const initialized = profile !== null;

  console.log(
    `[fixit] workspace: org=${identity.orgId} user=${identity.userId} initialized=${initialized} extras=${extras.length}`,
  );

  return { initialized, profile, extras };
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
  return rows
    .slice()
    .toReversed()
    .map((r) => ({
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

  return rows
    .slice()
    .toReversed()
    .map((r) => ({
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
    `[fixit] context loaded: workspace=${workspace.initialized ? "loaded" : "new"} sessionMsgs=${sessionHistory.length} crossSessionMsgs=${crossSessionHistory.length}`,
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
