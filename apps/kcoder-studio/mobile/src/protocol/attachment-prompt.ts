import type { StagedAttachment } from "@/runtime/task-runtime/types";

/** Existing app-server attachment input contract, shared by first and later turns. */
export function legacyAttachmentPrompt(prompt: string, attachments: readonly StagedAttachment[]): string {
  return attachments.length ? `${prompt}\n\n<kcoder_attachments version="1">\n${attachments.map(attachment => JSON.stringify(attachment)).join("\n")}\n</kcoder_attachments>` : prompt;
}
