/**
 * Fixit Chatbot Integration — session key mapping.
 * Maps org_id + user_id to OpenClaw session keys.
 */

import type { FixitConfigResolved } from "./config.js";
import { resolveFixitAgentId } from "./config.js";
import type { FixitIdentity } from "./types.js";

/**
 * Build an OpenClaw session key for a Fixit user.
 * Format: agent:{agentId}:fixit:org:{orgId}:user:{userId} or with :session:{sessionId} suffix.
 */
export function buildFixitSessionKey(params: {
  agentId: string;
  orgId: string;
  userId: string;
  campaignId?: string;
  sessionId?: string;
}): string {
  const campaignPart = params.campaignId?.trim() ? `:campaign:${params.campaignId.trim()}` : "";
  const base = `agent:${params.agentId}:fixit:org:${params.orgId}:user:${params.userId}${campaignPart}`;
  return params.sessionId?.trim() ? `${base}:session:${params.sessionId.trim()}` : base;
}

/**
 * Resolve the agent id for a Fixit org (from config default or orgAgentMapping).
 */
export function resolveFixitAgent(fixitConfig: FixitConfigResolved, orgId: string): string {
  return resolveFixitAgentId(fixitConfig, orgId);
}

/**
 * Build session key for the given identity and optional session id.
 */
export function buildFixitSessionKeyForIdentity(
  identity: FixitIdentity,
  fixitConfig: FixitConfigResolved,
  sessionId?: string,
): string {
  const agentId = resolveFixitAgent(fixitConfig, identity.orgId);
  return buildFixitSessionKey({
    agentId,
    orgId: identity.orgId,
    userId: identity.userId,
    campaignId: identity.campaignId,
    sessionId,
  });
}
