/**
 * Fixit Chatbot Integration — config resolution.
 * Reads from gateway.fixit and env (FIXIT_JWT_SECRET).
 */

import type { GatewayConfig, GatewayFixitConfig } from "../../config/types.gateway.js";

const DEFAULT_BASE_PATH = "/api/fixit";
const DEFAULT_AGENT_ID = "main";

export type FixitConfigResolved = {
  enabled: boolean;
  jwtSecret: string;
  basePath: string;
  defaultAgentId: string;
  orgAgentMapping: Map<string, string>;
  corsAllowOrigins: string[];
  mongoUri: string;
  mongoDatabase: string;
  /** If true, POST .../dev/jwt can issue test JWTs (testing only). */
  allowDevJwt: boolean;
};

export function resolveFixitConfig(cfg: { gateway?: GatewayConfig }): FixitConfigResolved | null {
  const fixit = cfg.gateway?.fixit;
  if (!fixit?.enabled) {
    console.log("[fixit] config: disabled (gateway.fixit.enabled is not true)");
    return null;
  }

  const jwtSecret =
    fixit.jwtSecret?.trim() ||
    (typeof process.env.FIXIT_JWT_SECRET === "string" && process.env.FIXIT_JWT_SECRET.trim()) ||
    "";
  if (!jwtSecret) {
    console.warn(
      "[fixit] config: disabled — no jwtSecret (set gateway.fixit.jwtSecret or FIXIT_JWT_SECRET)",
    );
    return null;
  }

  const mongoUri = fixit.mongoUri?.trim() || "";
  if (!mongoUri) {
    console.warn("[fixit] config: disabled — no mongoUri (set gateway.fixit.mongoUri)");
    return null;
  }
  const mongoDatabase = fixit.mongoDatabase?.trim() || "fixit_whatsapp_agent_dev";

  const rawPath = fixit.basePath?.trim() || DEFAULT_BASE_PATH;
  const basePath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  const orgAgentMapping = new Map<string, string>();
  if (fixit.orgAgentMapping && typeof fixit.orgAgentMapping === "object") {
    for (const [orgId, agentId] of Object.entries(fixit.orgAgentMapping)) {
      const k = orgId?.trim();
      const v = agentId?.trim();
      if (k && v) {
        orgAgentMapping.set(k, v);
      }
    }
  }

  const corsAllowOrigins = fixit.cors?.allowOrigins ?? [];
  const allowed = Array.isArray(corsAllowOrigins)
    ? corsAllowOrigins.map((o) => String(o).trim()).filter(Boolean)
    : [];

  const allowDevJwt = fixit.allowDevJwt === true;

  const resolved: FixitConfigResolved = {
    enabled: true,
    jwtSecret,
    basePath: basePath.replace(/\/+$/, "") || "/",
    defaultAgentId: fixit.defaultAgentId?.trim() || DEFAULT_AGENT_ID,
    orgAgentMapping,
    corsAllowOrigins: allowed,
    mongoUri,
    mongoDatabase,
    allowDevJwt,
  };
  console.log(
    `[fixit] config: enabled (basePath=${resolved.basePath}, db=${mongoDatabase}, cors=${allowed.length > 0 ? allowed.join(",") : "*"})`,
  );
  return resolved;
}

export function resolveFixitAgentId(resolved: FixitConfigResolved, orgId: string): string {
  return resolved.orgAgentMapping.get(orgId) ?? resolved.defaultAgentId;
}
