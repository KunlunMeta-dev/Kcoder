import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { InteractionInboxRow, QuestionInteraction } from "@/runtime/task-runtime/types";
import {
  interactionMatchesInboxRow,
  interactionTaskHref,
  matchesInteractionRouteLocator,
  parseInteractionRouteLocator,
  sourceAgentQuestionRouteRow,
  sourceAgentQuestionSelection,
} from "./locator";

const row: InteractionInboxRow = {
  profileId: "profile-a",
  profileAuthorizationScopeKey: "private-scope",
  serverId: "server-a",
  appServerId: "server-engine-S",
  serverConfigIdentity: "target-identity",
  threadId: "parent-thread",
  title: "Task title",
  cwd: "/private/workspace",
  kind: "question",
  requestId: 41,
  interactionId: "question-41",
  sourceAgent: { parentSessionId: "parent-thread", agentId: "agent-7" },
  turnId: "turn-4",
  appServerEpoch: "epoch-2",
  runtimeInstanceNonce: 10,
  profileActivationEpoch: 12,
  originClientGeneration: 8,
  status: "pending",
  liveActionable: true,
};

const question: QuestionInteraction = {
  kind: "question",
  requestId: 41,
  questionId: "question-41",
  questions: [],
  sourceAgent: { parentSessionId: "parent-thread", agentId: "agent-7" },
  owner: {
    profileId: "profile-a",
    profileAuthorizationScopeKey: "private-scope",
    serverId: "server-a",
    appServerId: "server-engine-S",
    serverConfigIdentity: "target-identity",
    threadId: "parent-thread",
    turnId: "turn-4",
    appServerEpoch: "epoch-2",
    runtimeInstanceNonce: 10,
    profileActivationEpoch: 12,
    originClientGeneration: 8,
    status: "pending",
  },
};

describe("interaction inbox route locator", () => {
  it("registers the profile-scoped Expo route at the expected bracket path", () => {
    const routeFile = fileURLToPath(new URL("../../app/h/[profileId]/inbox.tsx", import.meta.url).toString());
    expect(existsSync(routeFile)).toBe(true);
    const layout = readFileSync(fileURLToPath(new URL("../../app/h/[profileId]/_layout.tsx", import.meta.url).toString()), "utf8");
    expect(layout).toContain('<Stack.Screen name="inbox" />');
  });

  it("builds a non-secret exact locator and excludes owner, target and request contents", () => {
    const href = interactionTaskHref(row);
    expect(href.pathname).toBe("/h/[profileId]/task/[serverId]/[threadId]");
    expect(href.params).toEqual({
      profileId: "profile-a",
      serverId: "server-a",
      threadId: "parent-thread",
      kind: "question",
      requestId: "41",
      interactionId: "question-41",
      turnId: "turn-4",
      appServerEpoch: "epoch-2",
    });
    expect(JSON.stringify(href)).not.toContain("private-scope");
    expect(JSON.stringify(href)).not.toContain("target-identity");
    expect(JSON.stringify(href)).not.toContain("server-engine-S");
    expect(JSON.stringify(href)).not.toContain("private/workspace");
  });

  it("rejects malformed and multi-valued route fields", () => {
    expect(parseInteractionRouteLocator({
      kind: "question", requestId: ["41", "42"], interactionId: "question-41",
      turnId: "turn-4", appServerEpoch: "epoch-2",
    })).toBeNull();
    expect(parseInteractionRouteLocator({
      kind: "approval", requestId: "9007199254740992", interactionId: "approval",
      turnId: "", appServerEpoch: "",
    })).toBeNull();
  });

  it("revalidates the full request epoch and source agent identity", () => {
    const locator = parseInteractionRouteLocator({
      kind: "question", requestId: "41", interactionId: "question-41",
      turnId: "turn-4", appServerEpoch: "epoch-2",
    })!;
    expect(matchesInteractionRouteLocator(question, locator, "parent-thread")).toBe(true);
    expect(interactionMatchesInboxRow(question, row)).toBe(true);
    expect(matchesInteractionRouteLocator(question, { ...locator, appServerEpoch: "epoch-3" }, "parent-thread")).toBe(false);
    expect(interactionMatchesInboxRow({
      ...question,
      sourceAgent: { parentSessionId: "other-parent", agentId: "agent-7" },
    }, row)).toBe(false);
  });

  it("selects a subagent overlay only for the exact parent and receipt tuple", () => {
    expect(sourceAgentQuestionSelection(question, "parent-thread", [question])).toBe("agent-7");
    expect(sourceAgentQuestionSelection(question, "other-parent", [question])).toBeNull();
    expect(sourceAgentQuestionSelection(question, "parent-thread", [{
      ...question,
      owner: { ...question.owner, appServerEpoch: "new-epoch", turnId: "new-turn" },
    }])).toBeNull();
  });

  it("revalidates route-driven subagent selection against epoch and source identity", () => {
    const focus = {
      kind: "question" as const,
      requestId: row.requestId,
      interactionId: row.interactionId,
      turnId: row.turnId,
      appServerEpoch: row.appServerEpoch,
      agentId: row.sourceAgent!.agentId,
      parentSessionId: row.sourceAgent!.parentSessionId,
      status: "pending" as const,
      liveActionable: false,
    };
    expect(sourceAgentQuestionRouteRow(focus, [row], "parent-thread")).toEqual(row);
    expect(sourceAgentQuestionRouteRow({ ...focus, appServerEpoch: "new-epoch" }, [row], "parent-thread")).toBeNull();
    expect(sourceAgentQuestionRouteRow({ ...focus, agentId: "different-agent" }, [row], "parent-thread")).toBeNull();
    expect(sourceAgentQuestionRouteRow(focus, [row], "different-parent")).toBeNull();
  });
});
