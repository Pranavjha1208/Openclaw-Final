/**
 * Fixit Chatbot Integration — JWT verification, signing, and identity extraction.
 * Supports: (1) HS256 tokens with org_id/user_id in payload; (2) Firebase ID tokens — extract user_id, resolve org_id from d_user.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign a Fixit JWT (HS256) with the given payload and secret. Used for dev/jwt endpoint only.
 */
export function signFixitJwt(
  payload: {
    org_id: string;
    user_id: string;
    campaign_id?: string;
    role?: string;
    org_name?: string;
    user_name?: string;
    exp?: number;
  },
  secret: string,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header), "utf8"));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const message = `${encodedHeader}.${encodedPayload}`;
  const sig = createHmac("sha256", secret).update(message).digest();
  return `${message}.${base64UrlEncode(sig)}`;
}
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import type { FixitIdentity, FixitUserRole } from "./types.js";

const ROLE_VALUES: readonly FixitUserRole[] = ["super_user", "user", "admin"];

function parseRole(value: unknown): FixitUserRole {
  if (typeof value === "string" && (ROLE_VALUES as readonly string[]).includes(value)) {
    return value as FixitUserRole;
  }
  return "user";
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payloadB64 = parts[1] ?? "";
    const padded = payloadB64
      .padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), "=")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verify HS256 JWT signature and expiry, then extract Fixit identity from payload.
 * Payload must contain org_id, user_id, exp; optional role, org_name, user_name, campaign_id.
 */
export function verifyFixitJwt(token: string, secret: string): FixitIdentity {
  if (!secret || secret.length === 0) {
    throw new Error("Fixit JWT secret is not configured");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const message = `${headerB64}.${payloadB64}`;
  const expectedSignature = createHmac("sha256", secret).update(message).digest("base64url");

  const actualSignature = signatureB64 ?? "";
  if (expectedSignature.length !== actualSignature.length) {
    throw new Error("Invalid JWT signature");
  }
  if (
    !timingSafeEqual(Buffer.from(expectedSignature, "utf8"), Buffer.from(actualSignature, "utf8"))
  ) {
    throw new Error("Invalid JWT signature");
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    throw new Error("Invalid JWT payload");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp > 0 && Math.floor(Date.now() / 1000) > exp) {
    throw new Error("JWT expired");
  }

  const orgId = typeof payload.org_id === "string" ? payload.org_id.trim() : "";
  const userId = typeof payload.user_id === "string" ? payload.user_id.trim() : "";
  if (!orgId || !userId) {
    throw new Error("JWT missing org_id or user_id");
  }

  return {
    orgId,
    userId,
    role: parseRole(payload.role),
    orgName: typeof payload.org_name === "string" ? payload.org_name.trim() : undefined,
    userName: typeof payload.user_name === "string" ? payload.user_name.trim() : undefined,
    campaignId: typeof payload.campaign_id === "string" ? payload.campaign_id.trim() : undefined,
  };
}

/**
 * Verify Firebase ID token (RS256) and return user identifier claims.
 * Issuer: https://securetoken.google.com/<projectId>, audience: projectId.
 * Returns user_id (or sub) and phone_number from payload for DB lookup.
 */
export async function verifyFirebaseFixitJwt(
  token: string,
  firebaseProjectId: string,
): Promise<{ userId: string; phoneNumber?: string }> {
  if (!firebaseProjectId || !firebaseProjectId.trim()) {
    throw new Error("Firebase project ID is not configured");
  }
  const JWKS = createRemoteJWKSet(
    new URL(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    ),
  );
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${firebaseProjectId}`,
    audience: firebaseProjectId,
  });
  const userId =
    (typeof payload.user_id === "string" && payload.user_id.trim()) ||
    (typeof payload.sub === "string" && payload.sub.trim()) ||
    "";
  if (!userId) {
    throw new Error("Firebase JWT missing user_id or sub");
  }
  const phoneNumber =
    typeof payload.phone_number === "string" ? payload.phone_number.trim() : undefined;
  return { userId, phoneNumber };
}

/**
 * Authenticate a request using Authorization: Bearer <token> (HS256 with org_id/user_id in payload).
 * Returns FixitIdentity or null and sends 401 if invalid.
 */
export async function authenticateFixitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  jwtSecret: string,
): Promise<FixitIdentity | null> {
  const token = getBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing Authorization header" });
    return null;
  }
  try {
    return verifyFixitJwt(token, jwtSecret);
  } catch {
    sendJson(res, 401, { error: "Invalid or expired token" });
    return null;
  }
}
