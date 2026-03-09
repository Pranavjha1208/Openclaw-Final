/**
 * Fixit Chatbot Integration — dual-write to Fixit MongoDB.
 * Writes chat messages to f_user_sessions and f_user_messages (schema-compatible with Python WhatsApp Agent).
 */

import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { MongoClient } from "mongodb";
import type { FixitIdentity } from "./types.js";

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
 * @param frontendSessionId - Optional conversation id from the frontend; when provided, find or create by this id.
 */
export async function getOrCreateFixitSession(
  identity: FixitIdentity,
  sessionKey: string,
  mongoUri: string,
  mongoDatabase: string,
  frontendSessionId?: string,
): Promise<GetOrCreateFixitSessionResult> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  const filter = frontendSessionId
    ? { user_id: identity.userId, session_id: frontendSessionId }
    : { user_id: identity.userId, end_time: null };

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
    metadata: { org_id: identity.orgId, source: "web_ui", openclaw_session_key: sessionKey },
    created_at: new Date(),
    updated_at: new Date(),
  });

  return {
    sessionObjectId: result.insertedId,
    sessionUuid: sessionId,
  };
}

export type RecordFixitMessageParams = {
  userId: string;
  sessionObjectId: ObjectId;
  message: string;
  messageType: "text" | "image" | "video" | "document" | "audio";
  messageOwner: "user" | "assistant";
};

/**
 * Insert one message into f_user_messages (mirrors log_conversation from Python).
 */
export async function recordFixitMessage(
  params: RecordFixitMessageParams,
  mongoUri: string,
  mongoDatabase: string,
): Promise<void> {
  const client = await getClient(mongoUri);
  const db = client.db(mongoDatabase);

  await db.collection("f_user_messages").insertOne({
    user_id: params.userId,
    session_id: params.sessionObjectId,
    message_id: randomUUID(),
    message: params.message,
    message_type: params.messageType,
    message_owner: params.messageOwner,
    created_at: new Date(),
    updated_at: new Date(),
  });
}
