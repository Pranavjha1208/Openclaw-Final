/**
 * Fixit Chatbot Integration — TypeScript types.
 * Used by REST + SSE endpoints for the Fixit frontend.
 */

export type FixitUserRole = "super_user" | "user" | "admin";

/** Matches fsc.enums.ChannelType values. */
export type FixitChannelType = "whatsapp" | "ui";

export type FixitIdentity = {
  orgId: string;
  userId: string;
  role: FixitUserRole;
  orgName?: string;
  userName?: string;
  /** Optional per-dashboard campaign scoping; when set, queries are restricted to this campaign_id as well. */
  campaignId?: string;
};

export type FixitChatSendBody = {
  message: string;
  sessionId?: string;
  /** Optional campaign scope from the Fixit UI. When present, all chat data/tool access is restricted to that campaign. */
  campaignId?: string;
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
  chatTitle?: string;
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
  title: string;
  startTime: string;
  endTime?: string | null;
  updatedAt: string;
  channelType: FixitChannelType;
  messageCount?: number;
  lastMessagePreview?: string;
  metadata?: Record<string, unknown>;
};

export type FixitChatMessage = {
  message: string;
  messageOwner: "user" | "assistant";
  messageType: string;
  channelType: FixitChannelType;
  createdAt: string;
};

export type FixitAuthVerifyResponse = {
  valid: boolean;
  orgId: string;
  userId: string;
  orgName?: string;
  userName?: string;
  role: FixitUserRole;
  /** Optional campaign id echoed from JWT when present. */
  campaignId?: string;
};

export type FixitChatAbortBody = {
  runId?: string;
  sessionId?: string;
};
