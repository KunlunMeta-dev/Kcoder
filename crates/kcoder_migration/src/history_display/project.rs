//! Shared projection for physical records and reconstructed replacement items.
use super::*;
impl HistoryArchiveView {
    pub(crate) fn project_record(
        record: &HistoricalRecord,
        remaining: usize,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Option<(HistoricalDisplayRecord, usize)>> {
        let ordinal = record.record;
        let kind = match &record.data {
            HistoricalRecordData::Message { .. } => HistoricalDisplayKind::Message,
            HistoricalRecordData::Session { .. } => HistoricalDisplayKind::Session,
            HistoricalRecordData::Compaction { .. } => HistoricalDisplayKind::Compaction,
            HistoricalRecordData::Boundary { .. } => HistoricalDisplayKind::Boundary,
            HistoricalRecordData::Metadata { .. } => HistoricalDisplayKind::Metadata,
            HistoricalRecordData::Event { .. } => HistoricalDisplayKind::Event,
            HistoricalRecordData::Unknown { .. } => HistoricalDisplayKind::Unknown,
        };
        let total =
            u32::try_from(count(record)).context("history_display_block_budget_exceeded")?;
        let mut row = HistoricalDisplayRecord {
            record: ordinal,
            kind,
            role: match &record.data {
                HistoricalRecordData::Message { role, .. } => Some(*role),
                _ => None,
            },
            timestamp: record.timestamp.clone(),
            source_id: record.source_id.clone(),
            parent_id: record.parent_id.clone(),
            hidden: record.hidden,
            sidechain: record.sidechain,
            compact_summary: record.compact_summary,
            blocks: Vec::new(),
            total_blocks: total,
            next_block_cursor: (total > 0).then_some(0),
            diagnostics: record.diagnostics.iter().take(16).cloned().collect(),
            total_diagnostics: record
                .diagnostics
                .len()
                .try_into()
                .context("history_display_diagnostic_budget_exceeded")?,
        };
        let minimum = size(&row)?;
        if minimum + 256 > remaining {
            return Ok(None);
        }
        let mut used = minimum + 256;
        for index in 0..total.min(INITIAL_BLOCKS as u32) {
            ensure!(check(ordinal), "history_display_cancelled");
            let value = block(record, index)?.display(index);
            let cost = size(&value)? + 1;
            if used + cost > remaining {
                break;
            }
            row.blocks.push(value);
            used += cost;
            row.next_block_cursor = (index + 1 < total).then_some(index + 1);
        }
        Ok(Some((row, used)))
    }
    pub(crate) fn project_blocks(
        record: &HistoricalRecord,
        cursor: u32,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalDisplayBlocksPage> {
        let ordinal = record.record;
        let total_blocks =
            u32::try_from(count(record)).context("history_display_block_budget_exceeded")?;
        ensure!(cursor <= total_blocks, "history_display_invalid_cursor");
        let mut page = HistoricalDisplayBlocksPage {
            record: ordinal,
            blocks: Vec::new(),
            total_blocks,
            next_cursor: None,
        };
        let mut bytes = size(&page)? + 256;
        for index in cursor..total_blocks.min(cursor.saturating_add(10)) {
            ensure!(check(ordinal), "history_display_cancelled");
            let value = block(record, index)?.display(index);
            let cost = size(&value)? + 1;
            if bytes + cost > PAGE_BYTES {
                ensure!(
                    !page.blocks.is_empty(),
                    "history_display_page_budget_exceeded"
                );
                break;
            }
            page.blocks.push(value);
            bytes += cost;
        }
        let next = page.blocks.last().map_or(cursor, |block| block.index + 1);
        page.next_cursor = (next < total_blocks).then_some(next);
        ensure!(
            size(&page)? <= PAGE_BYTES,
            "history_display_page_budget_exceeded"
        );
        Ok(page)
    }
}
