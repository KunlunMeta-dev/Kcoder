/** Stop rather than replacing a binding created by another owner. */
export function originalBindingAlreadyRestored(current, originalTask, originalBinding) {
  if (!originalTask) return true;
  if (current == null) return false;
  if (current.task?.threadId !== originalTask || current.id !== originalBinding?.id) {
    throw new Error('Original task binding identity changed; manual reconciliation is required');
  }
  return true;
}

/** Finish a confirmed binding restoration without writing normal artifacts during cleanup. */
export async function finishBindingRestoration({ context, dialog, close, restored, recordArtifact }) {
  await close(dialog);
  if (recordArtifact) {
    await context.writeArtifactJson('original-binding-restored.json', { restored, restoredThroughPublicMenu: true });
  }
}
