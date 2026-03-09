/**
 * Request-scoped Fixit identity (org_id / user_id) via AsyncLocalStorage.
 * Set at the Fixit HTTP boundary so plugin tools can enforce org scope even
 * when the scope is not threaded through the agent run params.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type FixitRequestScope = { orgId: string; userId: string };

const fixitScopeStorage = new AsyncLocalStorage<FixitRequestScope>();

/**
 * Run an async function with the given Fixit scope as the current request scope.
 * Call this in the Fixit HTTP handler before dispatching to the agent.
 */
export async function runWithFixitScope<T>(
  scope: FixitRequestScope,
  fn: () => Promise<T>,
): Promise<T> {
  return fixitScopeStorage.run(scope, fn);
}

/**
 * Get the current request's Fixit scope, if any.
 * Used when building plugin tool context so MongoDB (and other plugins) can
 * enforce org_id/user_id without relying on the full param chain.
 */
export function getFixitScope(): FixitRequestScope | undefined {
  return fixitScopeStorage.getStore();
}
