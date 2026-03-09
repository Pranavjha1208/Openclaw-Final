/**
 * Fixit Chatbot Integration — TypeScript types.
 * Used by REST + SSE endpoints for the Fixit frontend.
 */

export type FixitUserRole = "super_user" | "user" | "admin";

export type FixitIdentity = {
  orgId: string;
  userId: string;
  role: FixitUserRole;
  orgName?: string;
  userName?: string;
};

export type FixitChatSendBody = {
  message: string;
  sessionId?: string;
  idempotencyKey?: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
};

export type FixitSseEventDelta = {
  type: "delta";
  text: string;
};

export type FixitSseEventToolCall = {
  type: "tool_call";
  name: string;
  status: "running" | "completed" | "failed";
};

export type FixitSseEventDone = {
  type: "done";
  text: string;
  sessionId: string;
  runId: string;
};

export type FixitSseEventError = {
  type: "error";
  error: string;
};

export type FixitSseEvent =
  | FixitSseEventDelta
  | FixitSseEventToolCall
  | FixitSseEventDone
  | FixitSseEventError;

export type FixitSessionInfo = {
  sessionId: string;
  startTime: string;
  endTime?: string | null;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type FixitChatMessage = {
  message: string;
  messageOwner: "user" | "assistant";
  messageType: string;
  createdAt: string;
};

export type FixitAuthVerifyResponse = {
  valid: boolean;
  orgId: string;
  userId: string;
  orgName?: string;
  userName?: string;
  role: FixitUserRole;
};

export type FixitChatAbortBody = {
  runId?: string;
  sessionId?: string;
};
