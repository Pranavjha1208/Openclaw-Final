/**
 * Fixit Chatbot Integration — config resolution.
 * Reads from gateway.fixit and env (FIXIT_JWT_SECRET).
 */

import type { GatewayConfig } from "../../config/types.gateway.js";

const DEFAULT_BASE_PATH = "/api/fixit";
const DEFAULT_AGENT_ID = "main";

export type FixitConfigResolved = {
  enabled: boolean;
  /** "jwt" = HS256 with org_id/user_id in payload; "firebase" = Firebase ID token, resolve org from d_user. */
  authMode: "jwt" | "firebase";
  /** Required when authMode is "firebase". */
  firebaseProjectId: string;
  /** Required for dev/jwt and when authMode is "jwt". */
  jwtSecret: string;
  basePath: string;
  defaultAgentId: string;
  orgAgentMapping: Map<string, string>;
  corsAllowOrigins: string[];
  mongoUri: string;
  mongoDatabase: string;
  allowDevJwt: boolean;
};

export function resolveFixitConfig(cfg: { gateway?: GatewayConfig }): FixitConfigResolved | null {
  const fixit = cfg.gateway?.fixit;
  if (!fixit?.enabled) {
    console.log("[fixit] config: disabled (gateway.fixit.enabled is not true)");
    return null;
  }

  const authMode = fixit.authMode === "firebase" ? "firebase" : "jwt";
  const firebaseProjectId = fixit.firebaseProjectId?.trim() ?? "";
  if (authMode === "firebase" && !firebaseProjectId) {
    console.warn(
      "[fixit] config: disabled — authMode=firebase requires gateway.fixit.firebaseProjectId",
    );
    return null;
  }

  const jwtSecret =
    fixit.jwtSecret?.trim() ||
    (typeof process.env.FIXIT_JWT_SECRET === "string" && process.env.FIXIT_JWT_SECRET.trim()) ||
    "";
  if (authMode === "jwt" && !jwtSecret) {
    console.warn(
      "[fixit] config: disabled — no jwtSecret (set gateway.fixit.jwtSecret or FIXIT_JWT_SECRET)",
    );
    return null;
  }
  if (authMode === "firebase" && fixit.allowDevJwt && !jwtSecret) {
    console.warn("[fixit] config: allowDevJwt=true requires jwtSecret for dev/jwt endpoint");
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
    authMode,
    firebaseProjectId: authMode === "firebase" ? firebaseProjectId : "",
    jwtSecret: jwtSecret || "",
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
