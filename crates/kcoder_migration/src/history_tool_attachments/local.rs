use super::*;
impl HistoryToolAttachments {
    pub(crate) fn local_archive(&self) -> &kcoder_state::external_history::ExternalHistoryReader {
        self.view.archive()
    }
    pub(crate) fn local_reference(
        &self,
        index: u32,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<crate::local_attachment::LocalReference<'_>> {
        let item = self.item(index)?;
        let mut reference = self.view.local_value(self.input(&item)?, check)?;
        reference.fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "local-tool-reference/1",
                self.source_identity()?,
                index,
                reference.fingerprint
            ))?)
        );
        Ok(reference)
    }
}
