import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  sanitizeCommandNameForTelegram,
  sanitizeCommandForTelegramApi,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("sanitizes command names for Telegram API (hyphens, leading letter)", () => {
    expect(sanitizeCommandNameForTelegram("export-session")).toBe("export_session");
    expect(sanitizeCommandNameForTelegram("help")).toBe("help");
    expect(sanitizeCommandNameForTelegram("dock_telegram")).toBe("dock_telegram");
    expect(sanitizeCommandNameForTelegram("42")).toBe("c_42");
    expect(sanitizeCommandNameForTelegram("")).toBe("");
  });

  it("sanitizes full menu command for Telegram API (description length)", () => {
    expect(
      sanitizeCommandForTelegramApi({ command: "export-session", description: "Export session" }),
    ).toEqual({
      command: "export_session",
      description: "Export session",
    });
    expect(sanitizeCommandForTelegramApi({ command: "x", description: "" })).toEqual({
      command: "x",
      description: "—",
    });
    const longDesc = "a".repeat(300);
    const result = sanitizeCommandForTelegramApi({ command: "help", description: longDesc });
    expect(result?.description.length).toBe(256);
    expect(result?.description.endsWith("…")).toBe(true);
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("sends sanitized commands to setMyCommands (fixes BOT_COMMAND_INVALID)", async () => {
    const setMyCommands = vi.fn(async () => undefined);

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands: vi.fn(async () => undefined),
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [
        { command: "export-session", description: "Export session to HTML" },
        { command: "help", description: "Show help" },
      ],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    const sent = setMyCommands.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ command: "export_session", description: "Export session to HTML" });
    expect(sent[1]).toEqual({ command: "help", description: "Show help" });
  });
});
