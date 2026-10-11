import {
  decodeToolCallStatus,
  canAcceptToolCallUpdate,
  type ToolCallStatus,
} from "../../../../shared/toolCallStatus";
import { type JsonRecord } from "@/gateway/rpc";
import {
  TaskRuntime,
  type PendingAssistantDelta,
  type PendingThinkingDelta,
} from "./core";
import { text, todosFromInput } from "./normalizers";
import {
  type AgentSummary,
  type AssistantTranscriptBlock,
  type ChatMessage,
  type TaskActivityView,
  type TaskSnapshot,
  type ToolCallView,
} from "./types";

export function appendAssistantDelta(
  this: TaskRuntime,
  turnId: string,
  delta: string,
  itemId?: string,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  const pending = this.pendingAssistantDeltas.get(turnId) ?? [];
  pending.push(delta);
  this.pendingAssistantDeltas.set(turnId, pending);
  const ordered = this.pendingOrderedAssistantDeltas.get(turnId) ?? [];
  ordered.push({
    itemId,
    delta,
    sequence,
    arrivalOrdinal: transcriptOrder,
    attemptId: this.attemptByTurn.get(turnId),
  });
  this.pendingOrderedAssistantDeltas.set(turnId, ordered);
  this.scheduleDeltaFlush();
}

export function appendThinkingDelta(
  this: TaskRuntime,
  turnId: string,
  delta: string,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  const pending = this.pendingThinkingDeltas.get(turnId) ?? [];
  pending.push({
    delta,
    sequence,
    arrivalOrdinal: transcriptOrder,
    attemptId: this.attemptByTurn.get(turnId),
  });
  this.pendingThinkingDeltas.set(turnId, pending);
  this.scheduleDeltaFlush();
}

export function scheduleDeltaFlush(this: TaskRuntime): void {
  if (this.deltaFlushTimer || this.disposed) return;
  this.deltaFlushTimer = setTimeout(() => {
    this.deltaFlushTimer = null;
    this.flushPendingDeltas();
  }, 80);
}

export function flushPendingDeltas(this: TaskRuntime): void {
  if (this.deltaFlushTimer) clearTimeout(this.deltaFlushTimer);
  this.deltaFlushTimer = null;
  if (
    this.pendingAssistantDeltas.size === 0 &&
    this.pendingOrderedAssistantDeltas.size === 0 &&
    this.pendingThinkingDeltas.size === 0
  )
    return;
  const messages = [...this.snapshot.messages];
  const turnIds = new Set([
    ...this.pendingAssistantDeltas.keys(),
    ...this.pendingOrderedAssistantDeltas.keys(),
    ...this.pendingThinkingDeltas.keys(),
  ]);
  for (const turnId of turnIds) {
    const pendingText = orderedDeltas(
      this.pendingOrderedAssistantDeltas.get(turnId) ?? [],
    );
    const contentDelta = pendingText.map((entry) => entry.delta).join("");
    const index = this.ensureAssistantMessage(messages, turnId);
    const current = messages[index];
    const pendingThinking = this.pendingThinkingDeltas.get(turnId) ?? [];
    const thinkingDelta = orderedDeltas(pendingThinking)
      .map((entry) => entry.delta)
      .join("");
    const persistedReadAhead =
      pendingText.length === 1 &&
      pendingThinking.length === 0 &&
      isPlainHistoryTextMessage(
        current,
        contentDelta,
        pendingText[0]?.attemptId,
      );
    messages[index] = {
      ...current,
      content:
        contentDelta && !persistedReadAhead
          ? current.content + contentDelta
          : current.content,
      thinking: thinkingDelta
        ? `${current.thinking ?? ""}${thinkingDelta}`
        : current.thinking,
    };
    const pendingEvents: Array<
      | { kind: "text"; entry: PendingAssistantDelta }
      | { kind: "thinking"; entry: PendingThinkingDelta }
    > = [
      ...pendingText.map((entry) => ({ kind: "text" as const, entry })),
      ...pendingThinking.map((entry) => ({ kind: "thinking" as const, entry })),
    ];
    const hasFullSequence = pendingEvents.every(
      (event) => event.entry.sequence !== undefined,
    );
    const orderedPendingEvents = pendingEvents.map((event, index) => ({ event, index }))
      .sort((left, right) => {
        const leftSequence = left.event.entry.sequence;
        const rightSequence = right.event.entry.sequence;
        if (hasFullSequence && leftSequence !== undefined && rightSequence !== undefined)
          return leftSequence - rightSequence || left.index - right.index;
        return left.event.entry.arrivalOrdinal - right.event.entry.arrivalOrdinal;
      })
      .map(({ event }) => event);
    const textChunksByProducer = new Map<
      string,
      {
        attemptId?: string;
        producerId: string;
        chunks: Array<{
          content: string;
          sequence?: number;
          arrivalOrdinal?: number;
        }>;
      }
    >();
    for (const event of orderedPendingEvents) {
      const entry = event.entry;
      if (event.kind === "text") {
        const textEntry = event.entry;
        const attemptId = textEntry.attemptId ?? this.attemptByTurn.get(turnId);
        const producerId =
          textEntry.itemId ?? `${attemptId ?? turnId}-assistant-text`;
        const key = JSON.stringify([attemptId ?? "", producerId]);
        const group = textChunksByProducer.get(key) ?? {
          attemptId,
          producerId,
          chunks: [],
        };
        group.chunks.push({
          content: textEntry.delta,
          sequence: textEntry.sequence,
          arrivalOrdinal: textEntry.arrivalOrdinal,
        });
        textChunksByProducer.set(key, group);
      } else {
        const target = this.ensureAssistantMessage(
          messages,
          turnId,
          entry.attemptId ?? this.attemptByTurn.get(turnId),
        );
        const message = messages[target];
        const orderedBlocks = [...(message.orderedBlocks ?? [])];
        const splitsTextRun = textSegmentSpansOrder(
          orderedBlocks,
          event.entry,
        );
        appendThinkingBlock(orderedBlocks, turnId, event.entry);
        if (splitsTextRun) resegmentLiveTextBlocks(orderedBlocks);
        messages[target] = { ...message, orderedBlocks };
      }
    }
    for (const group of textChunksByProducer.values()) {
      if (
        textChunksByProducer.size === 1 &&
        group.chunks.length === 1 &&
        adoptPersistedAssistantDelta(
          messages,
          turnId,
          group.attemptId,
          group.producerId,
          group.chunks[0],
        )
      )
        continue;
      const target = this.ensureAssistantMessage(
        messages,
        turnId,
        group.attemptId,
      );
      const message = messages[target];
      const orderedBlocks = [...(message.orderedBlocks ?? [])];
      rebuildProducerTextSegments(
        orderedBlocks,
        group.producerId,
        group.chunks,
      );
      messages[target] = { ...message, orderedBlocks };
    }
  }
  this.pendingAssistantDeltas.clear();
  this.pendingOrderedAssistantDeltas.clear();
  this.pendingThinkingDeltas.clear();
  this.patch({ messages });
}

export function updateTool(
  this: TaskRuntime,
  turnId: string,
  item: JsonRecord,
  completed: boolean,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  const messages = [...this.snapshot.messages];
  const index = this.ensureAssistantMessage(messages, turnId);
  const current = messages[index];
  const tools = [...(current.tools ?? [])];
  const id = text(item.id) ?? `tool-${tools.length + 1}`;
  const toolIndex = tools.findIndex((tool) => tool.id === id);
  const existingTool = toolIndex >= 0 ? tools[toolIndex] : undefined;
  const decoded = decodeToolCallStatus(
    typeof item.status === "string"
      ? item.status
      : completed
        ? "done"
        : "running",
  );
  const previousStatus: ToolCallStatus["status"] | undefined =
    existingTool?.status === "completed"
      ? "done"
      : existingTool?.status === "failed"
        ? "error"
        : existingTool?.status === "running"
          ? "pending"
          : existingTool?.status;
  if (
    previousStatus &&
    !canAcceptToolCallUpdate(previousStatus, decoded.status)
  )
    return;
  const tool: ToolCallView = {
    id,
    name: text(item.name) ?? existingTool?.name ?? "Tool",
    status:
      decoded.status === "unknown"
        ? "unknown"
        : decoded.status === "error"
          ? "failed"
          : decoded.status === "done"
            ? "completed"
            : "running",
    ...(decoded.status === "unknown" && { rawStatus: decoded.rawStatus }),
    input: item.input ?? existingTool?.input,
    output: item.output ?? existingTool?.output,
  };
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);
  messages[index] = { ...current, tools };
  const orderedBlocks = [...(messages[index].orderedBlocks ?? [])];
  const existingOrderedTool = orderedBlocks.find(
    (block) => block.kind === "tool" && block.id === id,
  );
  const orderedTool: AssistantTranscriptBlock = {
    kind: "tool",
    ...tool,
    sequence: earlierSequence(
      existingOrderedTool?.sequence,
      sequence,
    ),
    arrivalOrdinal: existingOrderedTool?.arrivalOrdinal ?? transcriptOrder,
  };
  const needsResegment =
    (!existingOrderedTool ||
      orderedTool.sequence !== existingOrderedTool.sequence ||
      orderedTool.arrivalOrdinal !== existingOrderedTool.arrivalOrdinal) &&
    textSegmentSpansOrder(orderedBlocks, orderedTool);
  upsertOrderedBlock(orderedBlocks, orderedTool);
  if (needsResegment) resegmentLiveTextBlocks(orderedBlocks);
  messages[index] = { ...messages[index], orderedBlocks };
  this.patch({ messages });
}

export function updateAssistantItem(
  this: TaskRuntime,
  turnId: string,
  item: JsonRecord,
  sequence: number | undefined,
  completed: boolean,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  if (text(item.type) !== "agentMessage") return;
  const id = text(item.id);
  if (!id) return;
  const messages = [...this.snapshot.messages];
  const index = this.ensureAssistantMessage(messages, turnId);
  const orderedBlocks = [...(messages[index].orderedBlocks ?? [])];
  const hasStreamedSegments = orderedBlocks.some(
    (block) => block.kind === "text" && block.producerId === id,
  );
  // Started marks the lifetime of a message item, not the location of visible
  // text: thinking or tools can occur before its first text delta. A completed
  // cumulative payload is only useful as a fallback when no deltas arrived.
  const completedText =
    completed && !hasStreamedSegments
      ? (text(item.content) ?? text(item.text) ?? text(item.textContent))
      : undefined;
  if (!completedText) return;
  appendTextDelta(orderedBlocks, id, completedText, sequence, transcriptOrder);
  messages[index] = { ...messages[index], orderedBlocks };
  this.patch({ messages });
}

export function ensureAssistantMessage(
  this: TaskRuntime,
  messages: ChatMessage[],
  turnId: string,
  requestedAttemptId?: string,
): number {
  const attemptId = requestedAttemptId ?? this.attemptByTurn.get(turnId);
  let index = messages.length - 1;
  while (
    index >= 0 &&
    !(
      messages[index].role === "assistant" &&
      messages[index].turnId === turnId &&
      (!attemptId ||
        (messages[index].attemptId ?? messages[index].turnId) === attemptId)
    )
  )
    index -= 1;
  if (index < 0) {
    messages.push({
      id: `assistant-${attemptId || turnId}`,
      turnId,
      ...(attemptId ? { attemptId } : {}),
      role: "assistant",
      content: "",
      orderedBlocks: [],
      timestampMs: Date.now(),
    });
    index = messages.length - 1;
  }
  return index;
}

function orderedDeltas<
  T extends { sequence?: number; arrivalOrdinal: number },
>(values: readonly T[]): T[] {
  const hasFullSequence = values.every((value) => value.sequence !== undefined);
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const leftSequence = left.value.sequence;
      const rightSequence = right.value.sequence;
      if (hasFullSequence && leftSequence !== undefined && rightSequence !== undefined)
        return leftSequence - rightSequence || left.index - right.index;
      return left.value.arrivalOrdinal - right.value.arrivalOrdinal;
    })
    .map(({ value }) => value);
}

function upsertOrderedBlock(
  blocks: AssistantTranscriptBlock[],
  candidate: AssistantTranscriptBlock,
): void {
  const index = blocks.findIndex(
    (block) => block.kind === candidate.kind && block.id === candidate.id,
  );
  if (index < 0) {
    insertOrderedBlock(blocks, candidate);
    return;
  }
  const existing = blocks[index];
  let next: AssistantTranscriptBlock = candidate;
  if (existing.kind === "text" && candidate.kind === "text") {
    next = {
      ...existing,
      ...candidate,
      content: existing.content + candidate.content,
      sequence: earlierSequence(existing.sequence, candidate.sequence),
      endSequence: Math.max(
        existing.endSequence ?? existing.sequence ?? Number.NEGATIVE_INFINITY,
        candidate.endSequence ?? candidate.sequence ?? Number.NEGATIVE_INFINITY,
      ),
    };
  } else if (existing.kind === "tool" && candidate.kind === "tool") {
    next = {
      ...existing,
      ...candidate,
      input: candidate.input ?? existing.input,
      output: candidate.output ?? existing.output,
      interactionSummaries:
        candidate.interactionSummaries ?? existing.interactionSummaries,
      sequence: earlierSequence(existing.sequence, candidate.sequence),
    };
  } else if (existing.kind === "activity" && candidate.kind === "activity") {
    next = {
      ...existing,
      ...candidate,
      sequence: earlierSequence(existing.sequence, candidate.sequence),
    };
  } else if (existing.kind === "thinking" && candidate.kind === "thinking") {
    next = {
      ...existing,
      ...candidate,
      content: existing.content + candidate.content,
      sequence: earlierSequence(existing.sequence, candidate.sequence),
      endSequence: Math.max(
        existing.endSequence ?? existing.sequence ?? Number.NEGATIVE_INFINITY,
        candidate.endSequence ?? candidate.sequence ?? Number.NEGATIVE_INFINITY,
      ),
    };
  }
  blocks.splice(index, 1);
  insertOrderedBlock(blocks, next);
}

function insertOrderedBlock(
  blocks: AssistantTranscriptBlock[],
  candidate: AssistantTranscriptBlock,
): void {
  const index = blocks.findIndex(
    (block) => compareBlockOrder(block, candidate) > 0,
  );
  blocks.splice(index < 0 ? blocks.length : index, 0, candidate);
}

function compareBlockOrder(
  left: AssistantTranscriptBlock,
  right: AssistantTranscriptBlock,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined)
    return left.sequence - right.sequence;
  if (
    left.arrivalOrdinal !== undefined &&
    right.arrivalOrdinal !== undefined
  )
    return left.arrivalOrdinal - right.arrivalOrdinal;
  return 0;
}

function appendThinkingBlock(
  blocks: AssistantTranscriptBlock[],
  turnId: string,
  delta: PendingThinkingDelta,
): void {
  const sequence = delta.sequence;
  const useSequence =
    sequence !== undefined && blocks.every((block) => block.sequence !== undefined);
  if (sequence !== undefined || blocks.every((block) => block.sequence === undefined)) {
    let previousIndex = -1;
    let previousSequence = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < blocks.length; index += 1) {
      const candidate = blocks[index];
      const candidateEnd =
        candidate.kind === "thinking"
          ? (candidate.endSequence ?? candidate.sequence)
          : candidate.sequence;
      const candidateOrder =
        candidate.kind === "thinking"
          ? (candidate.endArrivalOrdinal ?? candidate.arrivalOrdinal)
          : candidate.arrivalOrdinal;
      const value = useSequence ? candidateEnd : candidateOrder;
      const current = useSequence ? sequence : delta.arrivalOrdinal;
      if (
        value !== undefined &&
        current !== undefined &&
        value < current &&
        value > previousSequence
      ) {
        previousIndex = index;
        previousSequence = value;
      }
    }
    const previous = previousIndex >= 0 ? blocks[previousIndex] : undefined;
    if (previous?.kind === "thinking") {
      blocks[previousIndex] = {
        ...previous,
        content: previous.content + delta.delta,
        endSequence: sequence ?? previous.endSequence,
        endArrivalOrdinal: delta.arrivalOrdinal,
      };
      return;
    }
  } else {
    const previous = blocks.at(-1);
    if (previous?.kind === "thinking" && previous.sequence === undefined) {
      blocks[blocks.length - 1] = {
        ...previous,
        content: previous.content + delta.delta,
      };
      return;
    }
  }
  const attemptId = delta.attemptId ?? turnId;
  const suffix = sequence ?? blocks.length;
  insertOrderedBlock(blocks, {
    kind: "thinking",
    id: `thinking-${attemptId}-${suffix}`,
    content: delta.delta,
    sequence,
    endSequence: sequence,
    arrivalOrdinal: delta.arrivalOrdinal,
    endArrivalOrdinal: delta.arrivalOrdinal,
  });
}

function appendTextDelta(
  blocks: AssistantTranscriptBlock[],
  producerId: string,
  delta: string,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  rebuildProducerTextSegments(blocks, producerId, [
    { content: delta, sequence, arrivalOrdinal },
  ]);
}

type OrderedTextChunk = {
  content: string;
  sequence?: number;
  arrivalOrdinal?: number;
};

function chunksForSegment(
  segment: Extract<AssistantTranscriptBlock, { kind: "text" }>,
): OrderedTextChunk[] {
  const chunks: OrderedTextChunk[] = [];
  let current = segment.chunkTail;
  while (current) {
    chunks.push({
      content: current.content,
      sequence: current.sequence,
      arrivalOrdinal: current.arrivalOrdinal,
    });
    current = current.previous;
  }
  if (chunks.length === 0)
    return [
      {
        content: segment.content,
        sequence: segment.sequence,
        arrivalOrdinal: segment.arrivalOrdinal,
      },
    ];
  return chunks.reverse();
}

function linkTextChunks(
  previous: Extract<AssistantTranscriptBlock, { kind: "text" }>["chunkTail"],
  chunks: OrderedTextChunk[],
): Extract<AssistantTranscriptBlock, { kind: "text" }>["chunkTail"] {
  let tail = previous;
  for (const chunk of chunks) tail = { ...chunk, previous: tail };
  return tail;
}

function adoptPersistedAssistantDelta(
  messages: ChatMessage[],
  turnId: string,
  attemptId: string | undefined,
  producerId: string,
  chunk: OrderedTextChunk,
): boolean {
  const liveIndex = messages.findIndex((message) => {
    if (message.role !== "assistant" || message.turnId !== turnId) return false;
    if (attemptId)
      return (message.attemptId ?? message.turnId) === attemptId;
    return !message.attemptId && isPlainHistoryTextMessage(message, chunk.content);
  });
  if (liveIndex < 0) return false;
  const live = messages[liveIndex];
  const directHistoryBlock = plainHistoryTextBlock(
    live,
    chunk.content,
    attemptId,
  );
  if (!directHistoryBlock) {
    if (
      live.content !== chunk.content ||
      live.thinking ||
      (live.tools?.length ?? 0) > 0 ||
      live.todos?.length ||
      (live.orderedBlocks ?? []).some((block) => block.kind !== "activity")
    )
      return false;
  }
  const candidates = messages.flatMap((message, index) => {
    if (
      index === liveIndex ||
      message.role !== "assistant" ||
      message.turnId !== turnId ||
      message.attemptId ||
      !plainHistoryTextBlock(message, chunk.content)
    )
      return [];
    return [
      {
        message,
        index,
        block: plainHistoryTextBlock(message, chunk.content)!,
      },
    ];
  });
  if (!directHistoryBlock && candidates.length !== 1) return false;

  const persistedMatch = directHistoryBlock
    ? { message: live, index: liveIndex, block: directHistoryBlock }
    : candidates[0];
  const { message: persisted, index: persistedIndex, block } = persistedMatch;
  const textBlock: AssistantTranscriptBlock = {
    ...block,
    producerId,
    sequence: chunk.sequence,
    endSequence: chunk.sequence,
    arrivalOrdinal: chunk.arrivalOrdinal,
    endArrivalOrdinal: chunk.arrivalOrdinal,
    chunkTail: linkTextChunks(undefined, [chunk]),
  };
  const orderedBlocks: AssistantTranscriptBlock[] = directHistoryBlock
    ? (live.orderedBlocks ?? []).map((candidate) =>
        candidate.kind === "text" && candidate.id === directHistoryBlock.id
          ? textBlock
          : candidate,
      )
    : mergeAdoptedTextAndLiveBlocks(
        persisted.orderedBlocks,
        live.orderedBlocks,
        block.id,
        textBlock,
      );
  orderedBlocks.sort(compareBlockOrder);
  messages[persistedIndex] = {
    ...persisted,
    attemptId: attemptId ?? persisted.attemptId,
    activities: mergeTaskActivities(persisted.activities, live.activities),
    orderedBlocks,
  };
  if (persistedIndex !== liveIndex) messages.splice(liveIndex, 1);
  return true;
}

function plainHistoryTextBlock(
  message: ChatMessage,
  content: string,
  expectedAttemptId?: string,
): Extract<AssistantTranscriptBlock, { kind: "text" }> | undefined {
  if (
    message.role !== "assistant" ||
    message.content !== content ||
    message.status === "failed" ||
    message.status === "cancelled" ||
    (message.attemptId && message.attemptId !== expectedAttemptId) ||
    message.thinking ||
    (message.tools?.length ?? 0) > 0 ||
    message.todos?.length
  )
    return undefined;
  const nonActivities = (message.orderedBlocks ?? []).filter(
    (block) => block.kind !== "activity",
  );
  const onlyText = nonActivities.length === 1 ? nonActivities[0] : undefined;
  return onlyText?.kind === "text" &&
    onlyText.content === content &&
    !onlyText.producerId
    ? onlyText
    : undefined;
}

function isPlainHistoryTextMessage(
  message: ChatMessage,
  content: string,
  expectedAttemptId?: string,
): boolean {
  return Boolean(plainHistoryTextBlock(message, content, expectedAttemptId));
}

function mergeAdoptedTextAndLiveBlocks(
  persistedBlocks: AssistantTranscriptBlock[] | undefined,
  liveBlocks: AssistantTranscriptBlock[] | undefined,
  persistedTextId: string,
  textBlock: AssistantTranscriptBlock,
): AssistantTranscriptBlock[] {
  const blocks = (persistedBlocks ?? []).map((candidate) =>
    candidate.kind === "text" && candidate.id === persistedTextId
      ? textBlock
      : candidate,
  );
  if (!blocks.some((candidate) => candidate === textBlock)) blocks.push(textBlock);
  for (const candidate of liveBlocks ?? []) {
    const index = blocks.findIndex(
      (block) => block.kind === candidate.kind && block.id === candidate.id,
    );
    if (index < 0) {
      blocks.push(candidate);
    } else if (
      blocks[index]?.kind === "activity" &&
      candidate.kind === "activity"
    ) {
      blocks[index] = {
        ...blocks[index],
        ...candidate,
        sequence: earlierSequence(blocks[index]?.sequence, candidate.sequence),
      } as AssistantTranscriptBlock;
    }
  }
  return blocks;
}

function mergeTaskActivities(
  persisted: TaskActivityView[] | undefined,
  live: TaskActivityView[] | undefined,
): TaskActivityView[] | undefined {
  if (!persisted?.length) return live;
  if (!live?.length) return persisted;
  const activities = new Map(persisted.map((activity) => [activity.id, activity]));
  for (const activity of live) {
    const existing = activities.get(activity.id);
    activities.set(activity.id, existing ? { ...existing, ...activity } : activity);
  }
  return [...activities.values()];
}

function rebuildProducerTextSegments(
  blocks: AssistantTranscriptBlock[],
  producerId: string,
  incomingChunks: OrderedTextChunk[],
): void {
  const existing = blocks.filter(
    (block): block is Extract<AssistantTranscriptBlock, { kind: "text" }> =>
      block.kind === "text" && block.producerId === producerId,
  );
  const incoming = [...incomingChunks];
  const useIncomingSequence =
    incoming.length > 0 &&
    incoming.every((chunk) => chunk.sequence !== undefined);
  incoming.sort((left, right) =>
    useIncomingSequence
      ? left.sequence! - right.sequence!
      : (left.arrivalOrdinal ?? 0) - (right.arrivalOrdinal ?? 0),
  );

  // The hot streaming path only replaces the latest immutable text block and
  // appends the small new suffix. Older chunks stay in a persistent chain, so
  // every 80 ms flush does not scan and join the full streamed response again.
  const previous = existing.at(-1);
  if (previous && incoming.length > 0) {
    const useSequence =
      useIncomingSequence && previous.endSequence !== undefined;
    const previousEnd = useSequence
      ? previous.endSequence
      : previous.endArrivalOrdinal;
    const firstOrder = useSequence
      ? incoming[0].sequence
      : incoming[0].arrivalOrdinal;
    const last = incoming.at(-1)!;
    const increasing =
      previousEnd !== undefined &&
      firstOrder !== undefined &&
      firstOrder > previousEnd;
    const previousIndex = blocks.indexOf(previous);
    const otherBlocks = blocks.filter(
      (block) => !(block.kind === "text" && block.producerId === producerId),
    );
    const crossesExistingBoundary = otherBlocks.some((block) => {
      if (
        isBlockBetweenChunks(
          block,
          {
            sequence: useSequence ? previousEnd : undefined,
            arrivalOrdinal: useSequence
              ? previous.endArrivalOrdinal
              : previousEnd,
          },
          incoming[0],
        )
      )
        return true;
      return (
        blocks.indexOf(block) > previousIndex &&
        block.sequence === undefined &&
        block.arrivalOrdinal === undefined
      );
    });
    const crossesIncomingBoundary = incoming.some(
      (chunk, index) =>
        index + 1 < incoming.length &&
        otherBlocks.some((block) =>
          isBlockBetweenChunks(block, chunk, incoming[index + 1]),
        ),
    );
    if (increasing && !crossesExistingBoundary && !crossesIncomingBoundary) {
      const index = blocks.indexOf(previous);
      const contentDelta = incoming.map((chunk) => chunk.content).join("");
      blocks[index] = {
        ...previous,
        content: previous.content + contentDelta,
        endSequence: last.sequence ?? previous.endSequence,
        endArrivalOrdinal: last.arrivalOrdinal ?? previous.endArrivalOrdinal,
        chunkTail: linkTextChunks(previous.chunkTail, incoming),
      };
      return;
    }
  }

  const allChunks = existing.flatMap(chunksForSegment);
  const sourceChunks = incoming.length > 0 ? [...allChunks, ...incoming] : allChunks;
  if (sourceChunks.length === 0) return;
  const useSequence = sourceChunks.every((chunk) => chunk.sequence !== undefined);
  const orderedChunks = [...sourceChunks].sort((left, right) =>
    useSequence
      ? left.sequence! - right.sequence!
      : (left.arrivalOrdinal ?? 0) - (right.arrivalOrdinal ?? 0),
  );
  const otherBlocks = blocks.filter(
    (block) => !(block.kind === "text" && block.producerId === producerId),
  );
  const groups: typeof orderedChunks[] = [];
  for (const chunk of orderedChunks) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    const crossesBlock =
      previous !== undefined &&
      otherBlocks.some((block) => isBlockBetweenChunks(block, previous, chunk));
    if (!previousGroup || crossesBlock) groups.push([chunk]);
    else previousGroup.push(chunk);
  }
  const segments: AssistantTranscriptBlock[] = groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    const anchor = first.sequence ?? first.arrivalOrdinal ?? 0;
    return {
      kind: "text",
      id: `${producerId}:segment:${anchor}`,
      producerId,
      content: group.map((chunk) => chunk.content).join(""),
      sequence: first.sequence,
      endSequence: last.sequence,
      arrivalOrdinal: first.arrivalOrdinal,
      endArrivalOrdinal: last.arrivalOrdinal,
      chunkTail: linkTextChunks(undefined, group),
    };
  });
  blocks.splice(0, blocks.length, ...otherBlocks, ...segments);
  blocks.sort(compareBlockOrder);
}

type TranscriptPosition = {
  sequence?: number;
  arrivalOrdinal?: number;
};

function isBlockBetweenChunks(
  block: TranscriptPosition,
  left: { sequence?: number; arrivalOrdinal?: number },
  right: { sequence?: number; arrivalOrdinal?: number },
): boolean {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    block.sequence !== undefined
  )
    return block.sequence > left.sequence && block.sequence < right.sequence;
  return (
    left.arrivalOrdinal !== undefined &&
    right.arrivalOrdinal !== undefined &&
    block.arrivalOrdinal !== undefined &&
    block.arrivalOrdinal > left.arrivalOrdinal &&
    block.arrivalOrdinal < right.arrivalOrdinal
  );
}

function textSegmentSpansOrder(
  blocks: AssistantTranscriptBlock[],
  candidate: {
    sequence?: number;
    arrivalOrdinal?: number;
  },
): boolean {
  return blocks.some(
    (block) =>
      block.kind === "text" &&
      isBlockBetweenChunks(
        candidate,
        {
          sequence: block.sequence,
          arrivalOrdinal: block.arrivalOrdinal,
        },
        {
          sequence: block.endSequence ?? block.sequence,
          arrivalOrdinal: block.endArrivalOrdinal ?? block.arrivalOrdinal,
        },
      ),
  );
}

function resegmentLiveTextBlocks(blocks: AssistantTranscriptBlock[]): void {
  const producers = new Set(
    blocks.flatMap((block) =>
      block.kind === "text" && block.producerId ? [block.producerId] : [],
    ),
  );
  for (const producerId of producers) {
    rebuildProducerTextSegments(blocks, producerId, []);
  }
}

export function updateTodos(
  this: TaskRuntime,
  turnId: string,
  item: JsonRecord,
): void {
  if (text(item.name)?.toLowerCase() !== "todowrite") return;
  const todos = todosFromInput(item.input);
  if (!todos) return;
  const messages = [...this.snapshot.messages];
  const index = this.ensureAssistantMessage(messages, turnId);
  messages[index] = { ...messages[index], todos };
  this.patch({ messages });
}

export function updateSubagentSteer(
  this: TaskRuntime,
  agentId: string,
  steerStatus: string,
  messageId?: string,
  clientMessageId?: string | null,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  const messages = [...this.snapshot.messages];
  let updated = false;
  for (let index = 0; index < messages.length; index += 1) {
    const activities = messages[index].activities;
    if (!activities?.some((activity) => activity.agentId === agentId)) continue;
    messages[index] = {
      ...messages[index],
      activities: activities.map((activity) =>
        activity.agentId === agentId
          ? {
              ...activity,
              steerStatus,
              steerMessageId: messageId ?? activity.steerMessageId,
              clientMessageId: clientMessageId ?? activity.clientMessageId,
            }
          : activity,
      ),
    };
    const activity = messages[index].activities?.find(
      (item) => item.agentId === agentId,
    );
    if (activity)
      messages[index] = syncOrderedActivity(
        messages[index],
        activity,
        sequence,
        transcriptOrder,
      );
    updated = true;
  }
  if (!updated) {
    const turnId = this.snapshot.activeTurnId ?? this.snapshot.threadId;
    const index = this.ensureAssistantMessage(messages, turnId);
    messages[index] = {
      ...messages[index],
      activities: [
        ...(messages[index].activities ?? []),
        {
          id: `background-${agentId}`,
          type: "activity",
          label: `子智能体 ${agentId}`,
          status: "running",
          agentId,
          steerStatus,
          steerMessageId: messageId,
          clientMessageId: clientMessageId ?? undefined,
        },
      ],
    };
    const activity = messages[index].activities?.at(-1);
    if (activity)
      messages[index] = syncOrderedActivity(
        messages[index],
        activity,
        sequence,
        transcriptOrder,
      );
  }
  this.patch({ messages });
}

export function applySubagentSnapshot(
  this: TaskRuntime,
  agents: AgentSummary[],
): void {
  const accepted = agents.filter((agent) =>
    this.notificationReplayGuard.canSeedBackgroundRun(
      agent.backgroundRun ?? {},
      agent.status,
    ),
  );
  const messages: ChatMessage[] = [...this.snapshot.messages].map((message) => ({
    ...message,
    activities: message.activities?.map((activity) => {
      const agent = accepted.find(
        (agent) => agent.agentId === activity.agentId,
      );
      if (
        !agent ||
        !["completed", "failed", "cancelled", "halted", "paused"].includes(
          agent.status,
        )
      )
        return activity;
      const status: TaskActivityView["status"] =
        agent.status === "paused"
          ? "paused"
          : agent.status === "completed"
            ? "completed"
            : agent.status === "failed"
              ? "failed"
              : "cancelled";
      return { ...activity, status };
    }),
  }));
  for (let index = 0; index < messages.length; index += 1) {
    for (const activity of messages[index].activities ?? [])
      messages[index] = syncOrderedActivity(messages[index], activity);
  }
  const visibleAgents = accepted.filter(
    (agent) =>
      ["pending", "running", "paused"].includes(agent.status) ||
      agent.queueDepth > 0,
  );
  if (visibleAgents.length === 0) {
    this.patch({ messages });
    for (const agent of accepted)
      this.notificationReplayGuard.seedBackgroundRun(
        agent.backgroundRun ?? {},
        agent.status,
      );
    return;
  }
  const index = this.ensureAssistantMessage(messages, this.snapshot.threadId);
  const activities = [...(messages[index].activities ?? [])];
  for (const agent of visibleAgents) {
    if (
      !this.notificationReplayGuard.canSeedBackgroundRun(
        agent.backgroundRun ?? {},
        agent.status,
      )
    )
      continue;
    const id = `background-${agent.agentId}`;
    const steerStatus =
      agent.queueDepth === 0
        ? undefined
        : agent.headStatus === "blocked"
          ? "queued_behind_blocked"
          : agent.status === "paused"
            ? "queued_paused"
            : ["failed", "completed", "cancelled", "halted"].includes(
                  agent.status,
                )
              ? "resuming"
              : "queued_live";
    const activity: TaskActivityView = {
      id,
      type: "activity",
      label: agent.agentName?.trim() || `子智能体 ${agent.agentId}`,
      status: agent.status === "paused" ? "paused" : "running",
      agentId: agent.agentId,
      steerStatus,
      steerMessageId: agent.headMessageId,
    };
    const existing = activities.findIndex((item) => item.id === id);
    if (existing >= 0) activities[existing] = activity;
    else activities.push(activity);
    messages[index] = syncOrderedActivity(messages[index], activity);
  }
  messages[index] = { ...messages[index], activities };
  this.patch({ messages });
  for (const agent of accepted)
    this.notificationReplayGuard.seedBackgroundRun(
      agent.backgroundRun ?? {},
      agent.status,
    );
}

export function updateActivity(
  this: TaskRuntime,
  turnId: string,
  event: JsonRecord,
  sequence?: number,
  arrivalOrdinal?: number,
): void {
  const transcriptOrder = arrivalOrdinal ?? this.transcriptArrivalOrdinal++;
  const eventType = text(event.type);
  if (!eventType) return;
  const messages = [...this.snapshot.messages];
  const attemptId = this.attemptByTurn.get(turnId);
  const currentIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      (!attemptId || (message.attemptId ?? message.turnId) === attemptId),
  );
  const activities =
    currentIndex >= 0 ? [...(messages[currentIndex].activities ?? [])] : [];
  let activity: TaskActivityView | undefined;
  if (eventType.startsWith("background_job_")) {
    const jobId = text(event.id) ?? "unknown";
    const id = `background-${jobId}`;
    const existing = activities.find((item) => item.id === id);
    const current = Number(event.current);
    const total = Number(event.total);
    const progress =
      Number.isFinite(current) && Number.isFinite(total) && total > 0
        ? `${current} / ${total}`
        : undefined;
    if (eventType === "background_job_started")
      activity = {
        id,
        type: "activity",
        label: text(event.description) ?? "后台任务已启动",
        status: "running",
        agentId: jobId,
      };
    else if (eventType === "background_job_progress")
      activity = {
        id,
        type: "activity",
        label: text(event.message) ?? existing?.label ?? "后台任务运行中",
        detail: text(event.detail) ?? progress,
        status: "running",
        agentId: jobId,
      };
    else if (eventType === "background_job_paused")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务已暂停",
        detail: text(event.reason),
        status: "paused",
        agentId: jobId,
      };
    else if (eventType === "background_job_completed")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务已完成",
        detail: text(event.text),
        status: event.is_error === true ? "failed" : "completed",
        agentId: jobId,
      };
    else if (eventType === "background_job_failed")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务失败",
        detail: text(event.error),
        status: "failed",
        agentId: jobId,
      };
    else if (
      eventType === "background_job_cancelled" ||
      eventType === "background_job_halted"
    )
      activity = {
        id,
        type: "cancelled",
        label: existing?.label ?? "后台任务已取消",
        detail: text(event.reason),
        status: "cancelled",
        agentId: jobId,
      };
  } else if (eventType === "system_notice") {
    const notice = text(event.text);
    if (notice && /compact/i.test(notice))
      activity = {
        id: `compaction-${sequence ?? transcriptOrder}`,
        type: "compaction",
        label: "上下文已压缩",
        detail: notice,
        status: "completed",
      };
    else if (notice)
      activity = {
        id: `notice-${sequence ?? transcriptOrder}`,
        type: "notice",
        label: notice,
        status: "completed",
      };
  } else if (eventType === "compaction_failed") {
    activity = {
      id: `compaction-${sequence ?? transcriptOrder}`,
      type: "compaction",
      label: "上下文压缩失败",
      detail: text(event.error),
      status: "failed",
    };
  } else if (eventType === "stream_aborted") {
    const reason = text(event.reason) ?? "任务流已中止";
    const cancelled = /cancel/i.test(reason);
    activity = {
      id: `aborted-${sequence ?? transcriptOrder}`,
      type: cancelled ? "cancelled" : "activity",
      label: cancelled ? "本轮已取消" : "任务流已中止",
      detail: reason,
      status: cancelled ? "cancelled" : "failed",
    };
  } else if (eventType === "error") {
    activity = {
      id: `error-${sequence ?? transcriptOrder}`,
      type: "activity",
      label: "运行失败",
      detail: text(event.error),
      status: "failed",
    };
  } else if (eventType === "hook_message") {
    activity = {
      id: `hook-${sequence ?? transcriptOrder}`,
      type: "activity",
      label: text(event.text) ?? "Hook 消息",
      status: event.is_error === true ? "failed" : "completed",
    };
  }
  if (!activity) return;
  const activityId = activity.id;
  const previousActivity = activities.find((item) => item.id === activityId);
  if (previousActivity) {
    activity = {
      ...activity,
      steerStatus: previousActivity.steerStatus,
      steerMessageId: previousActivity.steerMessageId,
      clientMessageId: previousActivity.clientMessageId,
    };
  }
  const index =
    currentIndex >= 0
      ? currentIndex
      : this.ensureAssistantMessage(messages, turnId, attemptId);
  const existingIndex = activities.findIndex((item) => item.id === activityId);
  if (existingIndex >= 0) activities[existingIndex] = activity;
  else activities.push(activity);
  messages[index] = { ...messages[index], activities };
  messages[index] = syncOrderedActivity(
    messages[index],
    activity,
    sequence,
    transcriptOrder,
  );
  this.patch({ messages });
}

function syncOrderedActivity(
  message: ChatMessage,
  activity: TaskActivityView,
  sequence?: number,
  arrivalOrdinal?: number,
): ChatMessage {
  const orderedBlocks = [...(message.orderedBlocks ?? [])];
  const existing = orderedBlocks.find(
    (block) => block.kind === "activity" && block.id === activity.id,
  );
  const candidate: AssistantTranscriptBlock = {
    kind: "activity",
    id: activity.id,
    activity,
    sequence: earlierSequence(existing?.sequence, sequence),
    arrivalOrdinal: existing?.arrivalOrdinal ?? arrivalOrdinal,
  };
  const needsResegment =
    (!existing ||
      candidate.sequence !== existing.sequence ||
      candidate.arrivalOrdinal !== existing.arrivalOrdinal) &&
    textSegmentSpansOrder(orderedBlocks, candidate);
  upsertOrderedBlock(orderedBlocks, candidate);
  if (needsResegment) resegmentLiveTextBlocks(orderedBlocks);
  return { ...message, orderedBlocks };
}

function earlierSequence(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function patch(this: TaskRuntime, update: Partial<TaskSnapshot>): void {
  this.snapshot = { ...this.snapshot, ...update };
  if (this.snapshot.stopRequestedTurnId &&
      ((!this.snapshot.running && this.snapshot.connected) || (this.snapshot.activeTurnId && this.snapshot.activeTurnId !== this.snapshot.stopRequestedTurnId))) {
    this.snapshot = { ...this.snapshot, stopRequestedTurnId: undefined, stopAcceptanceUnknown: false };
  }
  for (const listener of this.listeners) listener();
}
