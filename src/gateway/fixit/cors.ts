/**
 * Fixit Chatbot Integration — CORS and OPTIONS for /api/fixit/*.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type";

/**
 * When corsAllowOrigins is empty, we allow any origin (dev-friendly).
 * When it's specified, we only reflect origins from that list.
 */
export function applyFixitCorsHeaders(
  res: ServerResponse,
  allowOrigins: string[],
  origin: string | undefined,
): void {
  if (allowOrigins.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && allowOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (allowOrigins.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigins[0]);
  }
  res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function handleFixitOptions(
  req: IncomingMessage,
  res: ServerResponse,
  allowOrigins: string[],
): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  applyFixitCorsHeaders(res, allowOrigins, origin);
  res.statusCode = 204;
  res.end();
  return true;
}
