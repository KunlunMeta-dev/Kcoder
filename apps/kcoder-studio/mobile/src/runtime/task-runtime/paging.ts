import { TaskRuntime } from "./core";
import { mergeReconciledMessages, readHistoryPage } from "./history";

export async function loadOlderMessages(this: TaskRuntime): Promise<void> {
  if (
    !this.client ||
    !this.snapshot.connected ||
    !this.snapshot.hasMoreBefore ||
    !this.snapshot.beforeCursor ||
    this.snapshot.loadingOlder
  )
    return;
  const cursor = this.snapshot.beforeCursor;
  const client = this.client;
  const generation = this.clientGeneration;
  this.patch({ loadingOlder: true });
  try {
    let resetHistory = false;
    const page = await readHistoryPage(
      client,
      this.snapshot.threadId,
      cursor,
    ).catch(async (error) => {
      if (
        !cursor.startsWith("tp1:") ||
        !(error instanceof Error) ||
        error.message !== "TRANSCRIPT_CURSOR_STALE"
      )
        throw error;
      if (
        this.disposed ||
        this.client !== client ||
        this.clientGeneration !== generation
      )
        throw error;
      resetHistory = true;
      return readHistoryPage(client, this.snapshot.threadId);
    });
    if (
      this.disposed ||
      this.client !== client ||
      this.clientGeneration !== generation ||
      this.snapshot.beforeCursor !== cursor
    )
      return;
    this.patch({
      messages: mergeReconciledMessages(
        page.messages,
        resetHistory
          ? this.snapshot.messages.filter(
              (message) =>
                message.id.startsWith("local-") ||
                (Boolean(this.snapshot.activeTurnId) &&
                  message.turnId === this.snapshot.activeTurnId),
            )
          : this.snapshot.messages,
      ),
      hasMoreBefore: page.hasMoreBefore,
      beforeCursor: page.beforeCursor,
      loadingOlder: false,
    });
  } catch (error) {
    if (
      !this.disposed &&
      this.client === client &&
      this.clientGeneration === generation &&
      this.snapshot.beforeCursor === cursor
    ) {
      this.patch({
        loadingOlder: false,
        error: `读取更早消息失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
