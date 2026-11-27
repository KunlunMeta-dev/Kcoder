//! Bounded historical display, without current tools, widget authority or resume messages.
use crate::history_normalization::HISTORY_NORMALIZATION_REVISION;
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::{
    ExternalHistoryReader, projection::HistoricalProjectionStore,
};
use kcoder_types::{historical_display::*, imported_transcript::*};
use serde::Serialize;
use std::io::Write;
mod project;
pub(crate) mod search;
pub(crate) mod text;

const PAGE_BYTES: usize = 512 * 1024;
const ROWS: usize = 10;
const INITIAL_BLOCKS: usize = 10;
struct Count {
    bytes: usize,
}
impl Write for Count {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(bytes.len());
        if self.bytes > PAGE_BYTES {
            return Err(std::io::Error::other(
                "history_display_page_budget_exceeded",
            ));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn size(value: &impl Serialize) -> Result<usize> {
    let mut output = Count { bytes: 0 };
    serde_json::to_writer(&mut output, value)
        .map_err(|_| anyhow::anyhow!("history_display_page_budget_exceeded"))?;
    Ok(output.bytes)
}
fn preview(text: &str) -> String {
    let mut end = text.len().min(512);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

pub struct HistoryArchiveView {
    archive: ExternalHistoryReader,
    projection: HistoricalProjectionStore,
}

struct Block<'a> {
    kind: HistoricalDisplayBlockKind,
    value: &'a HistoricalValueRef,
    call_id: Option<&'a str>,
    name: Option<&'a str>,
    namespace: Option<&'a str>,
    source_type: Option<&'a str>,
    outcome: Option<HistoricalToolOutcome>,
}
impl<'a> Block<'a> {
    fn new(kind: HistoricalDisplayBlockKind, value: &'a HistoricalValueRef) -> Self {
        let invalid_text = matches!(
            kind,
            HistoricalDisplayBlockKind::Text | HistoricalDisplayBlockKind::Thinking
        ) && value.encoding != HistoricalValueEncoding::JsonString;
        Self {
            kind: if invalid_text {
                HistoricalDisplayBlockKind::Opaque
            } else {
                kind
            },
            value,
            call_id: None,
            name: None,
            namespace: None,
            source_type: invalid_text.then_some("invalid_text_value"),
            outcome: None,
        }
    }
    fn available(&self) -> bool {
        !matches!(
            self.kind,
            HistoricalDisplayBlockKind::Opaque | HistoricalDisplayBlockKind::Attachment
        )
    }
    fn display(&self, index: u32) -> HistoricalDisplayBlock {
        HistoricalDisplayBlock {
            index,
            kind: self.kind,
            preview: self
                .available()
                .then(|| self.value.preview.as_deref().map(preview))
                .flatten(),
            source_bytes: self.value.bytes,
            decoded_bytes: self.value.decoded_bytes,
            body_available: self.available(),
            call_id: self.call_id.map(str::to_owned),
            name: self.name.map(str::to_owned),
            namespace: self.namespace.map(str::to_owned),
            source_type: self.source_type.map(str::to_owned),
            outcome: self.outcome,
        }
    }
}

fn count(record: &HistoricalRecord) -> usize {
    match &record.data {
        HistoricalRecordData::Message { blocks, .. } => blocks.len(),
        HistoricalRecordData::Compaction { checkpoint } => {
            usize::from(checkpoint.message.is_some())
        }
        HistoricalRecordData::Session { title, .. } => usize::from(title.is_some()),
        HistoricalRecordData::Unknown { payload, .. } => usize::from(payload.is_some()),
        _ => 1,
    }
}
fn block(record: &HistoricalRecord, index: u32) -> Result<Block<'_>> {
    use HistoricalDisplayBlockKind as Kind;
    if let HistoricalRecordData::Message { blocks, .. } = &record.data {
        let block = blocks
            .get(index as usize)
            .context("history_display_block_not_found")?;
        return Ok(match block {
            HistoricalBlock::Text { value } => Block::new(Kind::Text, value),
            HistoricalBlock::Thinking { value } => Block::new(Kind::Thinking, value),
            HistoricalBlock::ToolCall {
                call_id,
                name,
                namespace,
                source_type,
                input,
            } => Block {
                call_id: Some(call_id),
                name: Some(name),
                namespace: namespace.as_deref(),
                source_type: source_type.as_deref(),
                ..Block::new(Kind::ToolCall, input)
            },
            HistoricalBlock::ToolResult {
                call_id,
                output,
                outcome,
            } => Block {
                call_id: Some(call_id),
                outcome: Some(*outcome),
                ..Block::new(Kind::ToolResult, output)
            },
            HistoricalBlock::Opaque { value, source_type } => Block {
                source_type: Some(source_type),
                ..Block::new(Kind::Opaque, value)
            },
            HistoricalBlock::Attachment {
                value, source_type, ..
            } => Block {
                source_type: Some(source_type),
                ..Block::new(Kind::Attachment, value)
            },
        });
    }
    ensure!(index == 0, "history_display_block_not_found");
    let value = match &record.data {
        HistoricalRecordData::Compaction { checkpoint } => checkpoint.message.as_ref(),
        HistoricalRecordData::Session { title, .. } => title.as_ref(),
        HistoricalRecordData::Boundary { payload, .. }
        | HistoricalRecordData::Metadata { payload, .. }
        | HistoricalRecordData::Event { payload, .. } => {
            return Ok(Block::new(Kind::Opaque, payload));
        }
        HistoricalRecordData::Unknown { payload, .. } => {
            return Ok(Block::new(
                Kind::Opaque,
                payload
                    .as_ref()
                    .context("history_display_block_not_found")?,
            ));
        }
        _ => None,
    }
    .context("history_display_block_not_found")?;
    Ok(Block::new(Kind::Text, value))
}

impl HistoryArchiveView {
    /// Native cursor binding only; do not export private source fingerprints in public metadata.
    pub fn content_identity(&self) -> String {
        self.projection.source_fingerprint()
    }

    pub fn open(archive: ExternalHistoryReader) -> Result<Self> {
        Self::open_with_revision(archive, HISTORY_NORMALIZATION_REVISION)
    }

    pub fn open_with_revision(archive: ExternalHistoryReader, revision: &str) -> Result<Self> {
        let projection = archive
            .projection(revision, false)?
            .context("history_display_projection_not_ready")?;
        Ok(Self {
            archive,
            projection,
        })
    }

    /// Physical source order is explicit; this is not a selected effective model branch.
    pub fn page(
        &self,
        cursor: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalDisplayPage> {
        let progress = self.projection.progress()?;
        ensure!(
            cursor <= progress.normalized_records,
            "history_display_invalid_cursor"
        );
        let origin = self.archive.origin();
        let mut page = HistoricalDisplayPage {
            source: origin.source,
            source_session_id: origin.source_session_id.clone(),
            title: origin.title.clone(),
            project: origin.project.clone(),
            items: Vec::new(),
            total_records: progress.normalized_records,
            next_cursor: None,
            normalization_complete: progress.normalization_complete,
            adapter_revision: self.projection.adapter_revision().into(),
        };
        let mut remaining = PAGE_BYTES.saturating_sub(size(&page)? + 256);
        let end = progress.normalized_records.min(cursor + ROWS as u64);
        for ordinal in cursor..end {
            ensure!(check(ordinal), "history_display_cancelled");
            let record = self.projection.record(ordinal)?;
            let Some((row, used)) = Self::project_record(&record, remaining, &mut check)? else {
                ensure!(
                    !page.items.is_empty(),
                    "history_display_page_budget_exceeded"
                );
                break;
            };
            remaining -= used;
            page.items.push(row);
        }
        let next = page.items.last().map_or(cursor, |row| row.record + 1);
        page.next_cursor = (next < progress.normalized_records).then_some(next);
        ensure!(
            size(&page)? <= PAGE_BYTES,
            "history_display_page_budget_exceeded"
        );
        Ok(page)
    }

    pub fn blocks(
        &self,
        ordinal: u64,
        cursor: u32,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalDisplayBlocksPage> {
        ensure!(check(ordinal), "history_display_cancelled");
        let record = self.projection.record(ordinal)?;
        Self::project_blocks(&record, cursor, check)
    }

    pub fn text(
        &self,
        ordinal: u64,
        index: u32,
        offset: u64,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalTextChunk> {
        let record = self.projection.record(ordinal)?;
        let selected = block(&record, index)?;
        ensure!(
            selected.available(),
            "history_display_opaque_body_unavailable"
        );
        text::read(&self.archive, ordinal, selected.value, offset, check)
    }
    pub(crate) fn selected_record(
        &self,
        item: &HistoricalCodexItemRef,
    ) -> Result<HistoricalRecord> {
        crate::history_codex::selected_record(self.projection.record(item.record)?, item)
    }
    pub(crate) fn selected_blocks(
        &self,
        item: &HistoricalCodexItemRef,
        cursor: u32,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalDisplayBlocksPage> {
        Self::project_blocks(&self.selected_record(item)?, cursor, check)
    }
    pub(crate) fn selected_text(
        &self,
        item: &HistoricalCodexItemRef,
        index: u32,
        offset: u64,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalTextChunk> {
        let record = self.selected_record(item)?;
        let value = block(&record, index)?;
        ensure!(value.available(), "history_display_opaque_body_unavailable");
        text::read(&self.archive, item.record, value.value, offset, check)
    }
}
