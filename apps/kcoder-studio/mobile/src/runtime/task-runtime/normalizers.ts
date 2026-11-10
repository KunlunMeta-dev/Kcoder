import { normalizeWebSources } from "../../../../shared/webSources";
import { normalizeReviewEvidence } from "../../../../shared/reviewEvidence";
import { decodeTurnMessageStatus } from "../../../../shared/turnMessageStatus";
import { normalizeTurnFileCapture } from "../../../../shared/turnFileCapture";
import { decodeToolCallStatus } from "../../../../shared/toolCallStatus";
import { type JsonRecord, type RpcMessage } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { visibleUserContent } from "@/protocol/normalizers";
import { decodeProviderFailure } from "../../../../shared/providerFailure";
import {
  type AssistantTranscriptBlock,
  type ChatMessage,
  type FileChangesView,
  type InteractionSummaryView,
  type StagedAttachment,
  type TodoView,
  type ToolCallView,
} from "./types";

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function todosFromInput(value: unknown): TodoView[] | undefined {
  const rawTodos = record(value).TodoList;
  if (!Array.isArray(rawTodos)) return undefined;
  const todos = rawTodos.flatMap((value): TodoView[] => {
    const todo = record(value);
    const content = text(todo.content);
    const rawStatus = text(todo.status);
    if (!content) return [];
    const status: TodoView["status"] =
      rawStatus === "in_progress" ||
      rawStatus === "completed" ||
      rawStatus === "cancelled"
        ? rawStatus
        : "pending";
    return [{ content, status }];
  });
  return todos;
}

export function attachmentsFromContent(
  content: string,
): StagedAttachment[] | undefined {
  const match = content.match(
    /<kcoder_attachments[^>]*>\s*([\s\S]*?)\s*<\/kcoder_attachments>/i,
  );
  if (!match?.[1]) return undefined;
  const attachments = match[1].split(/\r?\n/).flatMap((line) => {
    try {
      const value = record(JSON.parse(line));
      const filename = text(value.filename);
      const mimeType = text(value.mimeType) ?? text(value.mime_type);
      const path = text(value.path);
      if (!filename || !mimeType || !path) return [];
      return [
        {
          filename,
          mimeType,
          path,
          fileSize: Number(value.fileSize ?? value.file_size ?? 0),
        },
      ];
    } catch {
      return [];
    }
  });
  return attachments.length > 0 ? attachments : undefined;
}

export function attachmentFromValue(
  value: unknown,
): StagedAttachment | undefined {
  const raw = record(value);
  const filename = text(raw.filename);
  const mimeType =
    text(raw.mimeType) ?? text(raw.mime_type) ?? "application/octet-stream";
  const path = text(raw.path);
  if (!filename || !path) return undefined;
  return {
    filename,
    mimeType,
    path,
    fileSize: Number(raw.fileSize ?? raw.file_size ?? 0),
  };
}

/** Older history projections reused a content ID across distinct commentary segments. */
function disambiguateHistoricalContentBlocks(blocks: AssistantTranscriptBlock[]): AssistantTranscriptBlock[] {
  const reserved = new Set(blocks.map(block => `${block.kind}:${block.id}`));
  const used = new Set<string>();
  const occurrences = new Map<string, number>();
  return blocks.map(block => {
    if (block.kind !== "text" && block.kind !== "thinking") return block;
    const key = `${block.kind}:${block.id}`;
    if (!used.has(key)) { used.add(key); return block; }
    let occurrence = occurrences.get(key) ?? 2;
    let id: string;
    do { id = `${block.id}:history-occurrence-${occurrence++}`; }
    while (reserved.has(`${block.kind}:${id}`) || used.has(`${block.kind}:${id}`));
    occurrences.set(key, occurrence);
    used.add(`${block.kind}:${id}`);
    // Preserve equal text at different positions; tool IDs remain protocol identities.
    return { ...block, id };
  });
}

export function structuredBlocks(blocks: unknown[] | undefined, binding?: { threadId?: string; turnId?: string; attemptId?: string }): {
  orderedBlocks: AssistantTranscriptBlock[];
  thinking?: string;
  tools?: ToolCallView[];
  todos?: TodoView[];
  attachments?: StagedAttachment[];
  fileChanges?: FileChangesView;
  interactionSummaries?: InteractionSummaryView[];
} {
  const orderedBlocks: AssistantTranscriptBlock[] = [];
  const thinking: string[] = [];
  const tools: ToolCallView[] = [];
  const attachments: StagedAttachment[] = [];
  let todos: TodoView[] | undefined;
  let fileChanges: FileChangesView | undefined;
  const interactionSummaries: InteractionSummaryView[] = [];
  for (const [index, value] of (blocks ?? []).entries()) {
    const block = record(value);
    const blockId = text(block.id) ?? `history-block-${index}`;
    if (block.type === "text") {
      const content = text(block.content);
      if (content)
        orderedBlocks.push({ kind: "text", id: blockId, content });
      continue;
    }
    if (block.type === "thinking") {
      const content = text(block.content);
      if (content) {
        thinking.push(content);
        orderedBlocks.push({ kind: "thinking", id: blockId, content });
      }
      continue;
    }
    if (block.type === "tool") {
      const id =
        text(block.id) ?? text(block.tool_use_id) ?? `tool-${tools.length + 1}`;
      const name = text(block.tool_name) ?? text(block.name) ?? "Tool";
      const renderPayload = record(block.render_payload ?? block.renderPayload);
      const blockInteractionSummaries: InteractionSummaryView[] = [];
      if (renderPayload.kind === "request_user_input") {
        const summaryCountBeforeBlock = interactionSummaries.length;
        const responseAnswers = record(record(renderPayload.response).answers);
        for (const questionValue of Array.isArray(renderPayload.questions)
          ? renderPayload.questions
          : []) {
          const question = record(questionValue);
          const questionId = text(question.id);
          if (!questionId) continue;
          const answer = record(responseAnswers[questionId]);
          const answers = Array.isArray(answer.answers)
            ? answer.answers.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          if (answers.length === 0) continue;
          const summary = {
            id: questionId,
            header: text(question.header) ?? "交互记录",
            prompt: text(question.question) ?? text(question.prompt),
            answers,
          };
          interactionSummaries.push(summary);
          blockInteractionSummaries.push(summary);
        }
        if (interactionSummaries.length > summaryCountBeforeBlock) {
          orderedBlocks.push({
            kind: "tool",
            id,
            name,
            status: "completed",
            input: block.tool_input ?? block.input,
            output: block.tool_output ?? block.output,
        webSources: normalizeWebSources(block.webSources, { ...binding, toolCallId: id }),
            interactionSummaries: blockInteractionSummaries,
          });
          continue;
        }
      }
      if (name.toLowerCase() === "todowrite") {
        todos = todosFromInput(block.tool_input ?? block.input) ?? todos;
        continue;
      }
      const decoded = decodeToolCallStatus(
        typeof block.status === "string" ? block.status : undefined,
      );
      const status =
        decoded.status === "unknown"
          ? "unknown"
          : decoded.status === "error"
            ? "failed"
            : decoded.status === "done"
              ? "completed"
              : "running";
      tools.push({
        id,
        name,
        status,
        ...(decoded.status === "unknown" && { rawStatus: decoded.rawStatus }),
        input: block.tool_input ?? block.input,
        output: block.tool_output ?? block.output,
        webSources: normalizeWebSources(block.webSources, { ...binding, toolCallId: id }),
      });
      orderedBlocks.push({
        kind: "tool",
        id,
        name,
        status,
        input: block.tool_input ?? block.input,
        output: block.tool_output ?? block.output,
        webSources: normalizeWebSources(block.webSources, { ...binding, toolCallId: id }),
        ...(blockInteractionSummaries.length > 0
          ? { interactionSummaries: blockInteractionSummaries }
          : {}),
      });
      continue;
    }
    if (block.type === "attachment") {
      const attachment = attachmentFromValue(block.attachment ?? block);
      if (attachment) attachments.push(attachment);
      continue;
    }
    if (block.type === "file_changes") {
      fileChanges =
        fileChangesFromValue(block.fileChanges ?? block.file_changes) ??
        fileChanges;
    }
  }
  return {
    orderedBlocks: disambiguateHistoricalContentBlocks(orderedBlocks),
    thinking: thinking.length > 0 ? thinking.join("\n\n") : undefined,
    tools: tools.length > 0 ? tools : undefined,
    todos,
    attachments: attachments.length > 0 ? attachments : undefined,
    fileChanges,
    interactionSummaries:
      interactionSummaries.length > 0 ? interactionSummaries : undefined,
  };
}

export function normalizeMessage(message: ThreadMessage, threadId?: string): ChatMessage | null {
  const fileChangesCapture = normalizeTurnFileCapture(message.fileChangesCapture, { turnId: message.turnId, attemptId: message.attemptId });
  const reviewEvidence = normalizeReviewEvidence(message.reviewEvidence, { turnId: message.turnId, attemptId: message.attemptId });
  const decodedStatus = decodeTurnMessageStatus(message.status);
  const content =
    message.role === "user"
      ? visibleUserContent(message.content)
      : [
          ...(message.blocks ?? []).flatMap((value) => {
            const block = record(value);
            return block.type === "text" && typeof block.content === "string"
              ? [block.content]
              : [];
          }),
          message.content,
        ]
          .filter(Boolean)
          .join("\n\n");
  const blocks = structuredBlocks(message.blocks, { threadId, turnId: message.turnId, attemptId: message.attemptId });
  const orderedBlocks =
    message.role === "assistant"
      ? disambiguateHistoricalContentBlocks([
          ...blocks.orderedBlocks,
          ...(message.content
            ? [
                {
                  kind: "text" as const,
                  id: `${message.id}:content`,
                  content: message.content,
                },
              ]
            : []),
        ])
      : undefined;
  const attachments =
    blocks.attachments ??
    (message.role === "user"
      ? attachmentsFromContent(message.content)
      : undefined);
  if (
    !content &&
    !blocks.thinking &&
    !blocks.tools &&
    !blocks.todos &&
    !blocks.fileChanges &&
    !fileChangesCapture &&
    !reviewEvidence &&
    !blocks.interactionSummaries &&
    !attachments &&
    message.status !== "cancelled" &&
    message.status !== "failed" &&
    decodedStatus.status !== "unknown"
  )
    return null;
  return {
    ...message,
    ...(decodedStatus.status === "unknown" && {
      status: "unknown",
      rawStatus: decodedStatus.rawStatus,
    }),
    content,
    fileChangesCapture,
    reviewEvidence,
    ...blocks,
    ...(orderedBlocks ? { orderedBlocks } : {}),
    attachments,
    providerFailure: decodeProviderFailure(message.providerFailure),
  };
}

export function fileChangesFromValue(
  value: unknown,
): FileChangesView | undefined {
  const raw = record(value);
  const artifactId = text(raw.artifact_id) ?? text(raw.artifactId);
  const workspacePath = text(raw.workspace_path) ?? text(raw.workspacePath);
  if (!artifactId || !workspacePath) return undefined;
  return {
    artifactId,
    workspacePath,
    fileCount: Number(raw.file_count ?? raw.fileCount ?? 0),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    files: Array.isArray(raw.files)
      ? raw.files.flatMap((file) => {
          if (typeof file === "string" && file.trim()) return [file.trim()];
          const path = text(record(file).path);
          return path ? [path] : [];
        })
      : [],
    status: text(raw.status) ?? "active",
    revertible: raw.revertible === true,
  };
}

export function turnIdFrom(message: RpcMessage): string {
  const params = record(message.params);
  const turn = record(params.turn);
  // Match Gateway routing so compatibility events settle the original turn's interactions.
  return text(params.turnId) ?? text(params.turn_id) ??
    text(turn.turnId) ?? text(turn.id) ?? "current-turn";
}
