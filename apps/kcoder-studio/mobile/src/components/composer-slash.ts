export type MobileSlashCommandName =
  "/compact" | "/model" | "/rename" | "/goal" | "/goal-pro" | "/ultgoal" | "/moa" | "/moa-plan";

export type MobileSlashCommand = {
  name: MobileSlashCommandName;
  description: string;
  acceptsArguments: boolean;
};

export type MobileGoalSlashAction =
  | { kind: "status" | "history" | "pause" | "resume" | "clear" }
  | { kind: "edit"; objective: string; tokenBudget?: number }
  | {
      kind: "create";
      objective: string;
      tokenBudget?: number;
      verificationKind: "artifact" | "answer";
    };

export const MOBILE_SLASH_COMMANDS: readonly MobileSlashCommand[] = [
  {
    name: "/compact",
    description: "Compact the current conversation context manually",
    acceptsArguments: false,
  },
  {
    name: "/model",
    description: "Switch model and reasoning effort",
    acceptsArguments: false,
  },
  {
    name: "/rename",
    description: "Rename the current task",
    acceptsArguments: true,
  },
  {
    name: "/goal",
    description: "Continue working toward a goal",
    acceptsArguments: true,
  },
  {
    name: "/goal-pro",
    description:
      "Require independent sub-agent verification before goal completion",
    acceptsArguments: true,
  },
  {
    name: "/moa",
    description: "Use multi-model advice for one turn; without arguments show configuration",
    acceptsArguments: true,
  },
  {
    name: "/moa-plan",
    description: "Run independent planners and synthesize their final plan",
    acceptsArguments: true,
  },
] as const;

export function filterMobileSlashCommands(
  input: string,
): readonly MobileSlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const query = input.toLowerCase();
  return MOBILE_SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(query),
  );
}

export function parseMobileSlashCommand(input: string): {
  command: MobileSlashCommand;
  args: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const separator = trimmed.search(/\s/);
  const name = (
    separator < 0 ? trimmed : trimmed.slice(0, separator)
  ).toLowerCase();
  const command = MOBILE_SLASH_COMMANDS.find(
    (candidate) => candidate.name === name,
  );
  if (!command) return null;
  return {
    command,
    args: separator < 0 ? "" : trimmed.slice(separator).trim(),
  };
}

export function isMobileSlashCommandInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return false;
  const separator = trimmed.search(/\s/);
  const name = separator < 0 ? trimmed : trimmed.slice(0, separator);
  return !name.slice(1).includes("/");
}

export function parseMobileGoalSlashAction(
  command: Extract<MobileSlashCommandName, "/goal" | "/goal-pro" | "/ultgoal">,
  args: string,
): MobileGoalSlashAction {
  const value = args.trim();
  if (!value || value === "status") return { kind: "status" };
  if (["history", "pause", "resume", "clear"].includes(value)) {
    return { kind: value as "history" | "pause" | "resume" | "clear" };
  }

  if (value === "edit" || value.startsWith("edit ")) {
    if (command === "/ultgoal")
      throw new Error("Usage: /ultgoal does not support edit");
    const parsed = parseBudgetAndObjective(value.slice(4).trim(), command);
    return { kind: "edit", ...parsed };
  }

  if (command === "/goal-pro") return parseGoalProCreation(value);
  return {
    kind: "create",
    ...parseBudgetAndObjective(value, command),
    verificationKind: "artifact",
  };
}

function parseGoalProCreation(
  value: string,
): Extract<MobileGoalSlashAction, { kind: "create" }> {
  const tokens = value.split(/\s+/);
  let index = 0;
  let tokenBudget: number | undefined;
  let verificationKind: "artifact" | "answer" = "artifact";
  let answerSeen = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "--answer") {
      if (answerSeen) throw new Error("--answer cannot be repeated");
      answerSeen = true;
      verificationKind = "answer";
      index += 1;
      continue;
    }
    if (token === "--budget") {
      if (tokenBudget !== undefined)
        throw new Error("--budget cannot be repeated");
      tokenBudget = parsePositiveBudget(tokens[index + 1], "/goal-pro");
      index += 2;
      continue;
    }
    if (token.startsWith("--"))
      throw new Error(`Unknown Goal Pro argument: ${token}`);
    break;
  }
  const objective = tokens.slice(index).join(" ").trim();
  if (!objective)
    throw new Error(
      "Usage: /goal-pro [--answer] [--budget <tokens>] <objective>",
    );
  return { kind: "create", objective, tokenBudget, verificationKind };
}

function parseBudgetAndObjective(
  value: string,
  command: "/goal" | "/goal-pro" | "/ultgoal",
): { objective: string; tokenBudget?: number } {
  if (value.startsWith("--budget=")) {
    throw new Error(`Usage: ${command} --budget <tokens> <objective>`);
  }
  const match = /^(?:--budget|budget)(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/.exec(
    value,
  );
  if (!match) {
    if (!value) return { objective: "" };
    return { objective: value };
  }
  const tokenBudget = parsePositiveBudget(match[1], command);
  const objective = (match[2] ?? "").trim();
  if (!objective)
    throw new Error(`Usage: ${command} --budget <tokens> <objective>`);
  return { objective, tokenBudget };
}

function parsePositiveBudget(raw: string | undefined, command: string): number {
  if (!raw || !/^\d+$/.test(raw))
    throw new Error(`Usage: ${command} --budget <tokens> <objective>`);
  const budget = Number(raw);
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new Error("token budget must be a positive integer");
  return budget;
}
