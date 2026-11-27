//! Selected records retain physical provenance while replacement/rollback affects only this view.
use super::*;
use crate::history_display::HistoryArchiveView;
use kcoder_types::{historical_display::*, imported_transcript::HistoricalCodexItemRef};
use sha2::{Digest, Sha256};

fn size(value: &impl serde::Serialize) -> Result<usize> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| anyhow::anyhow!("history_branch_page_budget_exceeded"))?;
    ensure!(
        bytes.len() <= 512 * 1024,
        "history_branch_page_budget_exceeded"
    );
    Ok(bytes.len())
}
impl HistoryBranchStore {
    pub fn text_part(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
        request: crate::history_search::SearchPartRead,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalTextChunk> {
        let (recipe, reference, _) = self.item(root_job, view_id, position)?;
        let (archive, record) = self.native_record(&recipe, &reference)?;
        crate::history_display::search::read_part(&archive, &record, request, check)
    }
    pub(crate) fn scan_search_record(
        &self,
        root_job: &str,
        view_id: &str,
        work: &mut crate::history_search::SearchWork<'_>,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let (recipe, reference, _) = self.item(root_job, view_id, work.cursor.position)?;
        let (archive, record) = self.native_record(&recipe, &reference)?;
        crate::history_display::search::scan_record(&archive, &record, work, check)
    }
    pub fn tool_attachments(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
        block: u32,
    ) -> Result<crate::history_tool_attachments::HistoryToolAttachments> {
        let (recipe, reference, _) = self.item(root_job, view_id, position)?;
        let source = recipe
            .sources
            .get(reference.source_index as usize)
            .context("history_branch_invalid_source")?;
        let selected = self
            .source_view(&recipe, &reference)?
            .selected_record(&reference)?;
        ensure!(
            matches!(&selected.data,kcoder_types::imported_transcript::HistoricalRecordData::Message{blocks,..}
            if matches!(blocks.get(block as usize),Some(kcoder_types::imported_transcript::HistoricalBlock::ToolResult{..}))),
            "history_tool_attachments_not_a_result"
        );
        let mut physical = block;
        for omitted in &reference.omitted_blocks {
            if *omitted > physical {
                break;
            }
            physical = physical
                .checked_add(1)
                .context("history_tool_attachments_invalid_source")?;
        }
        let catalog = crate::history_tool_attachments::HistoryToolAttachments::open_with_revision(
            self.archives.reader(&source.archive_id)?,
            reference.record,
            physical,
            reference.replacement_index,
            &recipe.normalization_revision,
        )?;
        ensure!(
            catalog.projection_identity() == source.projection_fingerprint,
            "history_branch_source_changed"
        );
        Ok(catalog.with_branch(self.reference_view(root_job, view_id)?))
    }
    pub fn attachment(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
        block: u32,
    ) -> Result<crate::history_attachments::HistorySelectedAttachment> {
        let (recipe, reference, _) = self.item(root_job, view_id, position)?;
        let source = recipe
            .sources
            .get(reference.source_index as usize)
            .context("history_branch_invalid_source")?;
        let view = crate::history_attachments::HistoryAttachmentView::open_with_revision(
            self.archives.reader(&source.archive_id)?,
            &recipe.normalization_revision,
        )?;
        ensure!(
            view.content_identity() == source.projection_fingerprint,
            "history_branch_source_changed"
        );
        Ok(
            crate::history_attachments::HistorySelectedAttachment::new(view, &reference, block)?
                .with_branch(self.reference_view(root_job, view_id)?),
        )
    }
    pub(crate) fn snapshot(
        &self,
        root_job: &str,
        view_id: &str,
        cursor: u64,
    ) -> Result<(HistoricalBranchItems, String)> {
        self.validate(root_job, view_id)?;
        let view = self.archives.branch(view_id, false)?;
        Ok((view.page(cursor)?, view.content_identity()?))
    }
    fn source_view(
        &self,
        recipe: &HistoricalBranchRecipe,
        item: &HistoricalCodexItemRef,
    ) -> Result<HistoryArchiveView> {
        let source = recipe
            .sources
            .get(item.source_index as usize)
            .context("history_branch_invalid_source")?;
        let view = HistoryArchiveView::open_with_revision(
            self.archives.reader(&source.archive_id)?,
            &recipe.normalization_revision,
        )?;
        ensure!(
            view.content_identity() == source.projection_fingerprint,
            "history_branch_source_changed"
        );
        Ok(view)
    }
    pub(crate) fn native_record(
        &self,
        recipe: &HistoricalBranchRecipe,
        reference: &HistoricalCodexItemRef,
    ) -> Result<(
        kcoder_state::external_history::ExternalHistoryReader,
        kcoder_types::imported_transcript::HistoricalRecord,
    )> {
        let record = self
            .source_view(recipe, reference)?
            .selected_record(reference)?;
        let source = recipe
            .sources
            .get(reference.source_index as usize)
            .context("history_branch_invalid_source")?;
        Ok((self.archives.reader(&source.archive_id)?, record))
    }
    pub fn page(
        &self,
        root_job: &str,
        view_id: &str,
        cursor: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalBranchDisplayPage> {
        let (snapshot, _) = self.snapshot(root_job, view_id, cursor)?;
        let root = self
            .archives
            .reader(&snapshot.recipe.sources[0].archive_id)?;
        let mut page = HistoricalBranchDisplayPage {
            progress: snapshot.progress,
            title: root.origin().title.clone(),
            source_session_id: root.origin().source_session_id.clone(),
            items: Vec::new(),
            next_cursor: None,
        };
        let mut remaining = (512usize * 1024).saturating_sub(size(&page)? + 256);
        let total = page.progress.written_items;
        for (index, reference) in snapshot.items.iter().enumerate() {
            ensure!(check(cursor + index as u64), "history_branch_cancelled");
            let view = self.source_view(&snapshot.recipe, reference)?;
            let source = self
                .archives
                .reader(&snapshot.recipe.sources[reference.source_index as usize].archive_id)?;
            let source_session_id = source.origin().source_session_id.clone();
            let extra = size(&source_session_id)? + 512;
            let selected = view.selected_record(reference)?;
            let projected = HistoryArchiveView::project_record(
                &selected,
                remaining.saturating_sub(extra),
                &mut check,
            )?;
            let Some((record, used)) = projected else {
                ensure!(
                    !page.items.is_empty(),
                    "history_branch_page_budget_exceeded"
                );
                break;
            };
            remaining = remaining.saturating_sub(used + extra);
            page.items.push(HistoricalBranchDisplayItem {
                position: cursor + index as u64,
                source_index: reference.source_index,
                source_session_id,
                replacement_index: reference.replacement_index,
                omitted_blocks: reference.omitted_blocks.len() as u32,
                record,
            });
        }
        let next = cursor + page.items.len() as u64;
        page.next_cursor = (next < total).then_some(next);
        size(&page)?;
        Ok(page)
    }
    fn item(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
    ) -> Result<(HistoricalBranchRecipe, HistoricalCodexItemRef, String)> {
        let (snapshot, identity) = self.snapshot(root_job, view_id, position)?;
        let reference = snapshot
            .items
            .into_iter()
            .next()
            .context("history_branch_item_not_found")?;
        Ok((snapshot.recipe, reference, identity))
    }
    pub fn text_identity(&self, root_job: &str, view_id: &str, position: u64) -> Result<String> {
        let (recipe, reference, identity) = self.item(root_job, view_id, position)?;
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                identity,
                position,
                reference,
                &recipe.sources
            ))?)
        ))
    }
    pub fn blocks(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
        cursor: u32,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalDisplayBlocksPage> {
        let (recipe, reference, _) = self.item(root_job, view_id, position)?;
        self.source_view(&recipe, &reference)?
            .selected_blocks(&reference, cursor, check)
    }
    pub fn text(
        &self,
        root_job: &str,
        view_id: &str,
        position: u64,
        block: u32,
        offset: u64,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalTextChunk> {
        let (recipe, reference, _) = self.item(root_job, view_id, position)?;
        self.source_view(&recipe, &reference)?
            .selected_text(&reference, block, offset, check)
    }
}
