import type { Bot } from "grammy";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export const TELEGRAM_MAX_COMMANDS = 100;

/** Telegram API: command 1–32 chars, a-z 0-9 underscore, must start with a letter. */
const TELEGRAM_COMMAND_API_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Telegram API: description 1–256 chars. */
export const TELEGRAM_MAX_DESCRIPTION_LENGTH = 256;

export type TelegramMenuCommand = {
  command: string;
  description: string;
};

/**
 * Sanitize a command name for Telegram setMyCommands (no hyphens; must start with a letter).
 * Returns empty string if it cannot be made valid.
 */
export function sanitizeCommandNameForTelegram(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  const noHyphen = trimmed.replace(/-/g, "_");
  const validChars = noHyphen.replace(/[^a-z0-9_]/g, "");
  const startsWithLetter = /^[a-z]/.test(validChars);
  const base = startsWithLetter ? validChars : `c_${validChars}`;
  return base.slice(0, 32);
}

/**
 * Sanitize one menu command for Telegram API (name + description length).
 * Returns null if command name would be empty.
 */
export function sanitizeCommandForTelegramApi(
  item: TelegramMenuCommand,
): TelegramMenuCommand | null {
  const command = sanitizeCommandNameForTelegram(item.command);
  if (!command || !TELEGRAM_COMMAND_API_PATTERN.test(command)) {
    return null;
  }
  let description = item.description.trim();
  if (!description) {
    description = "—";
  }
  if (description.length > TELEGRAM_MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, TELEGRAM_MAX_DESCRIPTION_LENGTH - 1) + "…";
  }
  return { command, description };
}

type TelegramPluginCommandSpec = {
  name: string;
  description: string;
};

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push(
        `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    commands.push({ command: normalized, description });
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
}): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
} {
  const { allCommands } = params;
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const commandsToRegister = allCommands.slice(0, maxCommands);
  return { commandsToRegister, totalCommands, maxCommands, overflowCount };
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
}): void {
  const { bot, runtime, commandsToRegister } = params;
  const sync = async () => {
    // Sanitize for Telegram API (no hyphens; command starts with letter; description ≤256).
    const seen = new Set<string>();
    const sanitized: TelegramMenuCommand[] = [];
    for (const item of commandsToRegister) {
      const safe = sanitizeCommandForTelegramApi(item);
      if (!safe) {
        runtime.log?.(
          `telegram: skipping invalid menu command "${item.command}" (Telegram: a-z, 0-9, underscore; max 32 chars; must start with letter).`,
        );
        continue;
      }
      if (seen.has(safe.command)) {
        continue;
      }
      seen.add(safe.command);
      sanitized.push(safe);
    }

    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    if (typeof bot.api.deleteMyCommands === "function") {
      await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands(),
      }).catch(() => {});
    }

    if (sanitized.length === 0) {
      return;
    }

    await withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands(sanitized),
    });
  };

  void sync().catch(() => {});
}
