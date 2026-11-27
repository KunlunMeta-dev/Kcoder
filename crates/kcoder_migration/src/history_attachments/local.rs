use super::*;
use crate::local_attachment::LocalReference;
impl HistoryAttachmentView {
    pub(crate) fn local_reference(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<LocalReference<'_>> {
        self.local_prepared(self.prepare(record, block, replacement, check)?)
    }
    pub(crate) fn local_value(
        &self,
        input: AttachmentValue<'_>,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<LocalReference<'_>> {
        self.local_prepared(self.prepare_value(input, check)?)
    }
    fn local_prepared(&self, mut value: Prepared) -> Result<LocalReference<'_>> {
        ensure!(
            value.info.kind == HistoricalAttachmentKind::LocalReference,
            "local_attachment_not_a_local_reference"
        );
        value.info.receipt = None;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "local-reference/1",
                self.content_identity(),
                &value.id,
                self.archive
                    .receipt()?
                    .context("external_history_not_committed")?
                    .archive_id
            ))?)
        );
        Ok(LocalReference {
            archive: &self.archive,
            fingerprint,
            info: value.info,
            revision: self.projection.adapter_revision().to_owned(),
        })
    }
}
impl HistorySelectedAttachment {
    pub(crate) fn local_archive(&self) -> &kcoder_state::external_history::ExternalHistoryReader {
        self.view.archive()
    }
    pub(crate) fn local_reference(
        &self,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<LocalReference<'_>> {
        self.view
            .local_reference(self.record, self.block, self.replacement, check)
    }
}
