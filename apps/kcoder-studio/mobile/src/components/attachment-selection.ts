export const MAX_ATTACHMENTS_PER_TURN = 32;

export function remainingAttachmentSlots(selectedCount: number): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_TURN - selectedCount);
}
