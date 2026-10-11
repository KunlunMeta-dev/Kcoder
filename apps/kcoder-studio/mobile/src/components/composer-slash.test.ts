import { describe, expect, test } from "vitest";
import {
  filterMobileSlashCommands,
  isMobileSlashCommandInput,
  parseMobileGoalSlashAction,
  parseMobileSlashCommand,
} from "./composer-slash";

describe("Mobile composer slash commands", () => {
  test("filters the TUI-aligned executable command subset", () => {
    expect(filterMobileSlashCommands('/mo').map(command => command.name)).toEqual(['/model', '/moa', '/moa-plan']);
    expect(filterMobileSlashCommands('/ult')).toEqual([]);
    expect(
      filterMobileSlashCommands("/go").map((command) => command.name),
    ).toEqual(["/goal", "/goal-pro"]);
    expect(filterMobileSlashCommands("/goal ")).toEqual([]);
    expect(filterMobileSlashCommands("message /goal")).toEqual([]);
  });

  test("parses command arguments without accepting unknown TUI-only commands", () => {
    expect(parseMobileSlashCommand("/goal-pro  修复并验证  ")).toMatchObject({
      command: { name: "/goal-pro" },
      args: "修复并验证",
    });
    expect(parseMobileSlashCommand("/quit")).toBeNull();
    expect(isMobileSlashCommandInput("/")).toBe(true);
    expect(isMobileSlashCommandInput("/unknown argument")).toBe(true);
    expect(isMobileSlashCommandInput("/data/project")).toBe(false);
  });

  test("parses goal lifecycle commands instead of treating them as objectives", () => {
    expect(parseMobileGoalSlashAction("/goal", "status")).toEqual({
      kind: "status",
    });
    expect(parseMobileGoalSlashAction("/goal-pro", "pause")).toEqual({
      kind: "pause",
    });
    expect(
      parseMobileGoalSlashAction("/goal", "edit --budget 2048 新目标"),
    ).toEqual({
      kind: "edit",
      objective: "新目标",
      tokenBudget: 2048,
    });
  });

  test("parses Goal Pro verification and budget flags with TUI semantics", () => {
    expect(
      parseMobileGoalSlashAction(
        "/goal-pro",
        "--answer --budget 4096 -- 回答当前问题",
      ),
    ).toEqual({
      kind: "create",
      objective: "回答当前问题",
      tokenBudget: 4096,
      verificationKind: "answer",
    });
    expect(() =>
      parseMobileGoalSlashAction("/goal-pro", "--answer --answer repeated"),
    ).toThrow("--answer cannot be repeated");
    expect(() =>
      parseMobileGoalSlashAction("/ultgoal", "edit is not allowed"),
    ).toThrow("does not support edit");
    expect(() =>
      parseMobileGoalSlashAction(
        "/goal",
        "--budget=100 should not become an objective",
      ),
    ).toThrow("Usage");
  });
});
