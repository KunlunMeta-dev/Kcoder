//! Receiving history keeps its physical encoding and authenticated lineage.
use super::{super::*, binding::ReceivedBinding};
use crate::{history_discovery::HistoryPendingSelection, history_sources::HistorySourceBinding};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceivedHistoryBinding {
    receipt: ReceivedBinding,
    history: HistorySourceBinding,
}
impl IncomingTransfers {
    pub fn received_history_selection(
        &self,
        request: &str,
        manifest_sha256: &str,
        entry_id: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoryPendingSelection> {
        let receipt = self.received_binding(request, manifest_sha256, entry_id)?;
        let history = self.history_binding(
            request,
            receipt.source(),
            entry_id,
            receipt.receipt(),
            &mut check,
        )?;
        HistoryPendingSelection::from_received(ReceivedHistoryBinding { receipt, history })
    }
}
impl ReceivedHistoryBinding {
    pub(crate) fn bound(&self) -> &HistorySourceBinding {
        &self.history
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        self.receipt.verify_batch_parent(parent)
    }
    pub(crate) fn verify_history_directory(&self, actual: &PrivateDirectory) -> Result<()> {
        self.receipt.verify_history_directory(actual)
    }
    pub(crate) fn capture(
        &self,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        let receiver = self.receipt.validate()?;
        let expected = self.receipt.receipt();
        let restored = receiver.history_binding(
            &expected.request_id,
            self.receipt.source(),
            &self.receipt.entry().id,
            expected,
            |bytes| check(bytes, self.history.physical_bytes()),
        )?;
        ensure!(
            serde_json::to_vec(&restored)? == serde_json::to_vec(&self.history)?,
            "source_transfer_binding_changed"
        );
        Ok(restored)
    }
}
