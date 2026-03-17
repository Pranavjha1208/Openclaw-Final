#!/usr/bin/env node

import dns from "node:dns";
import module from "node:module";

// Windows + Node c-ares: prefer IPv4 for mongodb+srv / SRV lookups (avoids querySrv ECONNREFUSED).
dns.setDefaultResultOrder("ipv4first");

// MSYS2 / Git Bash on Windows often exposes 127.0.0.1 as the sole DNS server (a local stub
// that may not support SRV queries).  mongodb+srv:// needs SRV lookups via dns.resolveSrv(),
// which uses c-ares talking to whatever dns.getServers() returns.  When that stub refuses SRV
// queries we get "querySrv ECONNREFUSED".  Fall back to well-known public resolvers.
{
  const current = dns.getServers();
  const isLoopbackOnly = current.length > 0 && current.every((s) => /^127\.|^::1$/.test(s));
  if (isLoopbackOnly) {
    dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
  }
}

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
      return false;
    }
    throw err;
  }
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("openclaw: missing dist/entry.(m)js (build output).");
}
