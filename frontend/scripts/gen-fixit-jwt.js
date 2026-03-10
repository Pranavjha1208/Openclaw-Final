#!/usr/bin/env node
/**
 * Generate a Fixit JWT for local testing.
 * Usage: node scripts/gen-fixit-jwt.js <jwt-secret> [org_id] [user_id] [campaign_id]
 * Example: node scripts/gen-fixit-jwt.js my-secret org_abc usr_123 campaign_xyz
 * The token expires in 24 hours. Use the same secret as gateway.fixit.jwtSecret (or FIXIT_JWT_SECRET).
 */

import { createHmac } from "node:crypto";

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signHS256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header), "utf8"));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const sig = createHmac("sha256", secret).update(signatureInput).digest();
  return `${signatureInput}.${base64UrlEncode(sig)}`;
}

const secret = process.argv[2];
const orgId = process.argv[3] || "org_demo";
const userId = process.argv[4] || "usr_demo";
const campaignId = process.argv[5] || "";

if (!secret) {
  console.error("Usage: node gen-fixit-jwt.js <jwt-secret> [org_id] [user_id] [campaign_id]");
  process.exit(1);
}

const payload = {
  org_id: orgId,
  user_id: userId,
  ...(campaignId ? { campaign_id: campaignId } : {}),
  role: "admin",
  org_name: "Demo Org",
  user_name: "Demo User",
  exp: Math.floor(Date.now() / 1000) + 24 * 3600,
};

const token = signHS256(payload, secret);
console.log(token);
