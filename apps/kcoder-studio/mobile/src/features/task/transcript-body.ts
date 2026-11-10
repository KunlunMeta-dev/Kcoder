import type { ChatMessage } from "@/runtime/task-runtime";

/** Return only text that the transcript renders as assistant body content. */
export function visibleAssistantText(
  message: Pick<ChatMessage, "content" | "orderedBlocks">,
): string | null {
  const value = message.orderedBlocks !== undefined
    ? collectOrderedText(message.orderedBlocks)
    : message.content;
  return value.trim().length > 0 ? value : null;
}

function collectOrderedText(
  blocks: NonNullable<ChatMessage["orderedBlocks"]>,
) {
  let text = "";
  let previousProducerId: string | undefined;
  let hasText = false;
  for (const block of blocks) {
    if (block.kind !== "text") {
      if (hasText) previousProducerId = undefined;
      continue;
    }
    const continuesSameItem =
      hasText &&
      block.producerId !== undefined &&
      block.producerId === previousProducerId;
    if (hasText && !continuesSameItem) text += "\n\n";
    text += block.content;
    hasText = true;
    previousProducerId = block.producerId;
  }
  return text;
}
