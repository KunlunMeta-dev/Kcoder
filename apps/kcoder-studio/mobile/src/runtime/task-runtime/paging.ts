import { TaskRuntime } from "./core";
import { MobileRpcError } from "@/gateway/rpc";
import { historyResetTail, transcriptReadIdentityKey, transcriptReadIdentityMatches,
  mergeReconciledMessages, publishConfirmedHistoryPage, readHistoryPage } from "./history";

export async function loadOlderMessages(this: TaskRuntime): Promise<void> {
  if (
    !this.client ||
    this.snapshot.transcriptActionPending ||
    !this.snapshot.connected ||
    !this.snapshot.hasMoreBefore ||
    !this.snapshot.beforeCursor ||
    this.snapshot.loadingOlder
  )
    return;
  const cursor = this.snapshot.beforeCursor;
  const identity = transcriptReadIdentityKey(this.snapshot);
  const threadId = this.snapshot.threadId;
  const client = this.client;
  const generation = this.clientGeneration;
  const mutationRevision = this.transcriptMutationRevision;
  const current = () => !this.disposed && this.client === client &&
    this.clientGeneration === generation && this.transcriptMutationRevision === mutationRevision &&
    !this.snapshot.transcriptActionPending && this.snapshot.threadId === threadId &&
    this.snapshot.beforeCursor === cursor && transcriptReadIdentityKey(this.snapshot) === identity;
  this.patch({ loadingOlder: true });
  try {
    // An unproved numeric boundary cannot safely extend the displayed history.
    // A user retry gets one fresh bounded page, without a speculative older RPC.
    let resetHistory = identity === null;
    let page: Awaited<ReturnType<typeof readHistoryPage>>;
    let completedRevision = this.completedTranscriptRevision;
    const readFirstPage = () => {
      completedRevision = this.completedTranscriptRevision;
      return readHistoryPage(client, threadId);
    };
    if (resetHistory) page = await readFirstPage();
    else {
      try { page = await readHistoryPage(client, threadId, cursor); }
      catch (error) {
        if (!(error instanceof MobileRpcError) || error.reason !== "remote" || error.code !== -32041) throw error;
        if (!current()) return;
        resetHistory = true;
        page = await readFirstPage();
      }
      if (!resetHistory && !transcriptReadIdentityMatches(this.snapshot, page)) {
        if (!current()) return;
        resetHistory = true;
        page = await readFirstPage();
      }
    }
    if (!current()) return;
    if (resetHistory && transcriptReadIdentityKey(page) === null)
      throw new Error("未能确认历史分页版本，已保留现有记录，请重试或重新连接。");
    if (resetHistory) publishConfirmedHistoryPage(this, page.sourcePage, completedRevision, current);
    this.patch({
      messages: mergeReconciledMessages(
        page.messages,
        resetHistory ? historyResetTail(this.snapshot, page.messages) : this.snapshot.messages,
      ),
      transcriptSnapshotV1: page.transcriptSnapshotV1,
      transcriptObservationV1: page.transcriptObservationV1,
      hasMoreBefore: page.hasMoreBefore,
      beforeCursor: page.beforeCursor,
      loadingOlder: false,
      error: null,
    });
  } catch (error) {
    if (current()) {
      this.patch({
        loadingOlder: false,
        error: `读取更早消息失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
