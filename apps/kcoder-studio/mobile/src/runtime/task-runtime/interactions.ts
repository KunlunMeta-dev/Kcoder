import { type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime } from "./core";
import { text } from "./normalizers";
import {
  type ApprovalInteraction,
  type PendingInteraction,
  type QuestionInteraction,
} from "./types";

export function respondApproval(
  this: TaskRuntime,
  decision: "accept" | "accept_for_session" | "decline" | "cancel",
): void {
  const interaction = this.snapshot.interaction;
  if (
    !this.client ||
    interaction?.kind !== "approval" ||
    interaction.responding
  )
    return;
  this.markInteractionResponding(interaction.requestId);
  try {
    this.client.respond(interaction.requestId, { decision });
  } catch (error) {
    this.markInteractionResponding(interaction.requestId, false);
    throw error;
  }
}

export function respondQuestions(
  this: TaskRuntime,
  answers: Record<string, string[]>,
): void {
  const interaction = this.snapshot.interaction;
  if (
    !this.client ||
    interaction?.kind !== "question" ||
    interaction.responding
  )
    return;
  this.markInteractionResponding(interaction.requestId);
  try {
    this.client.respond(interaction.requestId, {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          { answers: values },
        ]),
      ),
    });
  } catch (error) {
    this.markInteractionResponding(interaction.requestId, false);
    throw error;
  }
}

/** Source questions share the existing reply ledger; ignoring one cannot cancel its parent. */
export function respondAgentQuestions(
  this: TaskRuntime,
  agentId: string,
  requestId: number,
  answers: Record<string, string[]>,
  ignored?: boolean,
): void {
  if (ignored === undefined) ignored = false;
  const interaction = this.pendingInteractions.find(
    (item) => item.kind === "question" && item.requestId === requestId,
  );
  if (
    !this.client ||
    interaction?.kind !== "question" ||
    interaction.responding ||
    interaction.sourceAgent?.agentId !== agentId ||
    interaction.sourceAgent.parentSessionId !== this.snapshot.threadId
  ) {
    throw new Error("子代理问题已经失效，请刷新后重试");
  }
  this.markInteractionResponding(requestId);
  try {
    this.client.respond(requestId, {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          { answers: values },
        ]),
      ),
      ...(ignored ? { annotations: { ignored: true } } : {}),
    });
  } catch (error) {
    this.markInteractionResponding(requestId, false);
    throw error;
  }
}

export function cancelQuestions(this: TaskRuntime): void {
  const interaction = this.snapshot.interaction;
  if (
    !this.client ||
    interaction?.kind !== "question" ||
    interaction.responding
  )
    return;
  this.markInteractionResponding(interaction.requestId);
  try {
    this.client.respondError(
      interaction.requestId,
      -32800,
      "the user cancelled the question request",
    );
  } catch (error) {
    this.markInteractionResponding(interaction.requestId, false);
    throw error;
  }
}

export function enqueueInteraction(
  this: TaskRuntime,
  interaction: PendingInteraction,
): void {
  const existing = this.pendingInteractions.findIndex(
    (item) => item.requestId === interaction.requestId,
  );
  if (existing >= 0) this.pendingInteractions[existing] = interaction;
  else this.pendingInteractions.push(interaction);
  this.patch({
    interaction: this.pendingInteractions[0] ?? null,
    interactionCount: this.pendingInteractions.length,
  });
}

export function resolveInteraction(
  this: TaskRuntime,
  kind: PendingInteraction["kind"],
  params: JsonRecord,
): void {
  const requestId =
    typeof params.requestId === "number" ? params.requestId : undefined;
  const identity =
    kind === "approval" ? text(params.approvalId) : text(params.questionId);
  const index = this.pendingInteractions.findIndex((item) => {
    if (item.kind !== kind) return false;
    if (requestId !== undefined) return item.requestId === requestId;
    return kind === "approval"
      ? (item as ApprovalInteraction).approvalId === identity
      : (item as QuestionInteraction).questionId === identity;
  });
  // An unmatched stale notification must not clear an interaction still awaiting the user.
  if (index < 0) return;
  this.pendingInteractions.splice(index, 1);
  this.patch({
    interaction: this.pendingInteractions[0] ?? null,
    interactionCount: this.pendingInteractions.length,
  });
}

export function markInteractionResponding(
  this: TaskRuntime,
  requestId: number,
  responding?: boolean,
): void {
  if (responding === undefined) responding = true;
  const index = this.pendingInteractions.findIndex(
    (item) => item.requestId === requestId,
  );
  if (index < 0) return;
  this.pendingInteractions[index] = {
    ...this.pendingInteractions[index],
    responding,
  };
  this.patch({
    interaction: this.pendingInteractions[0] ?? null,
    interactionCount: this.pendingInteractions.length,
  });
}
