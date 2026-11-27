//! Tool-result collections are derived only from typed array elements, never parsed from text.
use crate::{
    history_attachments::{AttachmentValue, HistoryAttachmentView},
    history_json::{self, Segment, Value},
    history_normalization::HISTORY_NORMALIZATION_REVISION,
};
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::ExternalHistoryReader;
use kcoder_types::{
    historical_attachment::*, historical_tool_attachments::*, imported_transcript::*,
    migration::MigrationSourceKind,
};
use sha2::{Digest, Sha256};
use std::io::Cursor;
mod local;
const MAGIC: &[u8; 8] = b"KCTAT001";
const HEADER: usize = 32;
const ROW: usize = 32;
pub const MAX_TOOL_ATTACHMENTS: usize = 10_000;
const MAX_INDEX_BYTES: usize = HEADER + MAX_TOOL_ATTACHMENTS * ROW;

pub struct HistoryToolAttachments {
    view: HistoryAttachmentView,
    record: HistoricalRecord,
    block: u32,
    replacement: Option<u32>,
    parent: HistoricalValueRef,
    id: String,
    _branch: Option<kcoder_state::external_history::branch_views::HistoricalBranchView>,
}
struct Item {
    source_array_index: u32,
    code: u8,
    value: HistoricalValueRef,
}
fn kind(code: u8) -> Result<&'static str> {
    Ok(match code {
        1 => "image",
        2 => "document",
        3 => "file",
        4 => "input_image",
        5 => "output_image",
        6 => "input_file",
        7 => "input_audio",
        _ => anyhow::bail!("history_tool_attachments_invalid_index"),
    })
}
pub(crate) fn kind_code(source: MigrationSourceKind, value: &str) -> Option<u8> {
    match (source, value) {
        (MigrationSourceKind::ClaudeCode, "image") => Some(1),
        (MigrationSourceKind::ClaudeCode, "document") => Some(2),
        (MigrationSourceKind::ClaudeCode, "file") => Some(3),
        (MigrationSourceKind::Codex, "input_image") => Some(4),
        (MigrationSourceKind::Codex, "output_image") => Some(5),
        (MigrationSourceKind::Codex, "image") => Some(1),
        (MigrationSourceKind::Codex, "input_file") => Some(6),
        (MigrationSourceKind::Codex, "file") => Some(3),
        (MigrationSourceKind::Codex, "input_audio") => Some(7),
        _ => None,
    }
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
impl HistoryToolAttachments {
    pub(crate) fn with_branch(
        mut self,
        branch: kcoder_state::external_history::branch_views::HistoricalBranchView,
    ) -> Self {
        self._branch = Some(branch);
        self
    }
    pub(crate) fn projection_identity(&self) -> String {
        self.view.content_identity()
    }

    pub fn open(
        archive: ExternalHistoryReader,
        record: u64,
        block: u32,
        replacement: Option<u32>,
    ) -> Result<Self> {
        Self::open_with_revision(
            archive,
            record,
            block,
            replacement,
            HISTORY_NORMALIZATION_REVISION,
        )
    }
    pub fn open_with_revision(
        archive: ExternalHistoryReader,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        revision: &str,
    ) -> Result<Self> {
        let view = HistoryAttachmentView::open_with_revision(archive, revision)?;
        let record = view.resolved_record(record, replacement)?;
        let HistoricalRecordData::Message { blocks, .. } = &record.data else {
            anyhow::bail!("history_tool_attachments_not_a_result")
        };
        let Some(HistoricalBlock::ToolResult { output: parent, .. }) = blocks.get(block as usize)
        else {
            anyhow::bail!("history_tool_attachments_not_a_result")
        };
        ensure!(
            parent.record == record.record,
            "history_tool_attachments_invalid_source"
        );
        view.archive()
            .open_record_range(parent.record, parent.offset, parent.bytes)?;
        let parent = parent.clone();
        let id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "typed-tool-attachments/1",
                revision,
                record.source,
                &parent
            ))?)
        );
        Ok(Self {
            view,
            record,
            block,
            replacement,
            parent,
            id,
            _branch: None,
        })
    }
    pub fn source_identity(&self) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &self.id,
                self.view.content_identity(),
                self.view
                    .archive()
                    .receipt()?
                    .context("external_history_not_committed")?
                    .archive_id
            ))?)
        ))
    }
    fn blob(
        &self,
        writable: bool,
    ) -> Result<Option<kcoder_state::external_history::attachments::HistoricalAttachmentStore>>
    {
        self.view.archive().attachment_blob(&self.id, writable)
    }
    fn summary_from(
        &self,
        receipt: &HistoricalAttachmentReceipt,
    ) -> Result<HistoricalToolAttachmentSummary> {
        let header = self
            .blob(false)?
            .context("history_tool_attachments_not_ready")?
            .read_chunk(0, HEADER)?;
        ensure!(
            header.len() == HEADER
                && &header[..8] == MAGIC
                && header[25..].iter().all(|v| *v == 0)
                && header[24] <= 1,
            "history_tool_attachments_invalid_index"
        );
        let summary = HistoricalToolAttachmentSummary {
            structured: header[24] == 1,
            attachments: u32_at(&header, 8),
            source_items: u32_at(&header, 12),
            unknown_items: u32_at(&header, 16),
            opaque_items: u32_at(&header, 20),
        };
        ensure!(
            summary.attachments as usize <= MAX_TOOL_ATTACHMENTS
                && summary.source_items as u64
                    <= kcoder_types::external_history::EXTERNAL_HISTORY_MAX_RECORDS
                && summary.attachments as u64
                    + summary.unknown_items as u64
                    + summary.opaque_items as u64
                    <= summary.source_items as u64
                && (summary.structured || summary.source_items == 0)
                && receipt.bytes == (HEADER + summary.attachments as usize * ROW) as u64,
            "history_tool_attachments_invalid_index"
        );
        Ok(summary)
    }
    pub fn summary(&self) -> Result<Option<HistoricalToolAttachmentSummary>> {
        let Some(blob) = self.blob(false)? else {
            return Ok(None);
        };
        blob.receipt()?
            .map(|receipt| self.summary_from(&receipt))
            .transpose()
    }
    pub fn build(
        &self,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalToolAttachmentSummary> {
        ensure!(
            check(HistoricalAttachmentStage::Inspecting, 0),
            "history_tool_attachments_cancelled"
        );
        let mut blob = self
            .view
            .archive()
            .attachment_blob_with_check(&self.id, true, || {
                check(HistoricalAttachmentStage::Inspecting, 0)
            })?
            .context("history_tool_attachments_not_ready")?;
        if let Some(receipt) = blob.receipt()? {
            let mut digest = Sha256::new();
            let mut at = 0;
            while at < receipt.bytes {
                ensure!(
                    check(HistoricalAttachmentStage::Inspecting, 0),
                    "history_tool_attachments_cancelled"
                );
                let bytes = blob.read_chunk(at, HISTORICAL_ATTACHMENT_CHUNK_BYTES)?;
                ensure!(!bytes.is_empty(), "history_tool_attachments_invalid_index");
                at += bytes.len() as u64;
                digest.update(&bytes);
            }
            ensure!(
                format!("{:x}", digest.finalize()) == receipt.sha256,
                "history_tool_attachments_invalid_index"
            );
            return self.summary_from(&receipt);
        }
        let mut rows = Vec::new();
        let mut summary = HistoricalToolAttachmentSummary {
            structured: false,
            attachments: 0,
            source_items: 0,
            unknown_items: 0,
            opaque_items: 0,
        };
        let mut pending: Option<(u64, String)> = None;
        let mut structured = false;
        if self.parent.encoding == HistoricalValueEncoding::Json {
            history_json::walk(
                self.view.archive().open_record_range(
                    self.parent.record,
                    self.parent.offset,
                    self.parent.bytes,
                )?,
                |path, node| {
                    if let [Segment::Index(index), Segment::Key(name)] = path
                        && name == "type"
                        && let Value::String(value) = &node.value
                        && value.bytes == value.preview.len() as u64
                    {
                        pending = Some((*index, value.preview.clone()));
                    }
                    if let [Segment::Index(index)] = path {
                        summary.source_items = summary
                            .source_items
                            .checked_add(1)
                            .context("history_tool_attachments_item_budget_exceeded")?;
                        let source_type = pending
                            .take()
                            .filter(|(at, _)| at == index)
                            .map(|(_, value)| value);
                        if let Some(code) = source_type
                            .as_deref()
                            .and_then(|v| kind_code(self.record.source, v))
                        {
                            ensure!(
                                matches!(node.value, Value::Object),
                                "history_tool_attachments_invalid_source"
                            );
                            ensure!(
                                (rows.len() / ROW) < MAX_TOOL_ATTACHMENTS,
                                "history_tool_attachments_item_budget_exceeded"
                            );
                            let mut row = [0u8; ROW];
                            row[..4].copy_from_slice(&u32::try_from(*index)?.to_le_bytes());
                            row[4] = code;
                            row[8..16].copy_from_slice(
                                &(self.parent.offset + node.span.start).to_le_bytes(),
                            );
                            row[16..24]
                                .copy_from_slice(&(node.span.end - node.span.start).to_le_bytes());
                            rows.extend_from_slice(&row);
                            summary.attachments += 1;
                        } else if matches!(
                            source_type.as_deref(),
                            Some("encrypted_content" | "redacted_thinking" | "thinking")
                        ) {
                            summary.opaque_items += 1;
                        } else if !matches!(
                            source_type.as_deref(),
                            Some("text" | "input_text" | "output_text")
                        ) {
                            summary.unknown_items += 1;
                        }
                    }
                    if path.is_empty() {
                        structured = matches!(node.value, Value::Array);
                    }
                    Ok(())
                },
                |bytes| check(HistoricalAttachmentStage::Inspecting, bytes),
            )?;
            ensure!(structured, "history_tool_attachments_unrecognized_envelope");
        }
        let mut header = [0u8; HEADER];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&summary.attachments.to_le_bytes());
        header[12..16].copy_from_slice(&summary.source_items.to_le_bytes());
        header[16..20].copy_from_slice(&summary.unknown_items.to_le_bytes());
        header[20..24].copy_from_slice(&summary.opaque_items.to_le_bytes());
        header[24] = u8::from(structured);
        let mut bytes = Vec::with_capacity(HEADER + rows.len());
        bytes.extend_from_slice(&header);
        bytes.extend(rows);
        let receipt = blob.publish(&mut Cursor::new(bytes), MAX_INDEX_BYTES as u64, |_| {
            check(HistoricalAttachmentStage::Inspecting, self.parent.bytes)
        })?;
        self.summary_from(&receipt)
    }
    fn item(&self, index: u32) -> Result<Item> {
        let summary = self
            .summary()?
            .context("history_tool_attachments_not_ready")?;
        ensure!(
            index < summary.attachments,
            "history_tool_attachments_invalid_cursor"
        );
        let row = self
            .blob(false)?
            .context("history_tool_attachments_not_ready")?
            .read_chunk((HEADER + index as usize * ROW) as u64, ROW)?;
        ensure!(
            row.len() == ROW
                && row[5..8].iter().all(|v| *v == 0)
                && row[24..].iter().all(|v| *v == 0),
            "history_tool_attachments_invalid_index"
        );
        let code = row[4];
        kind(code)?;
        let offset = u64_at(&row, 8);
        let bytes = u64_at(&row, 16);
        let source_array_index = u32_at(&row, 0);
        ensure!(
            bytes > 0
                && source_array_index < summary.source_items
                && offset >= self.parent.offset
                && offset
                    .checked_add(bytes)
                    .is_some_and(|end| end <= self.parent.offset + self.parent.bytes),
            "history_tool_attachments_invalid_index"
        );
        Ok(Item {
            source_array_index,
            code,
            value: HistoricalValueRef {
                record: self.parent.record,
                offset,
                bytes,
                encoding: HistoricalValueEncoding::Json,
                decoded_bytes: None,
                decoded_sha256: None,
                preview: None,
            },
        })
    }
    pub fn page(&self, cursor: u32) -> Result<HistoricalToolAttachmentPage> {
        let summary = self
            .summary()?
            .context("history_tool_attachments_not_ready")?;
        ensure!(
            cursor <= summary.attachments,
            "history_tool_attachments_invalid_cursor"
        );
        let end = summary.attachments.min(cursor.saturating_add(10));
        let mut items = Vec::new();
        for index in cursor..end {
            let item = self.item(index)?;
            items.push(HistoricalToolAttachmentItem {
                index,
                source_array_index: item.source_array_index,
                source_type: kind(item.code)?.into(),
            });
        }
        Ok(HistoricalToolAttachmentPage {
            items,
            next_cursor: (end < summary.attachments).then_some(end),
            summary,
        })
    }
    fn input<'a>(&'a self, item: &'a Item) -> Result<AttachmentValue<'a>> {
        Ok(AttachmentValue {
            record: &self.record,
            block: self.block,
            replacement: self.replacement,
            source_type: kind(item.code)?,
            value: &item.value,
            media_type: None,
        })
    }
    pub fn inspect_item(
        &self,
        index: u32,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        let item = self.item(index)?;
        self.view.inspect_value(self.input(&item)?, check)
    }
    pub fn extract_item(
        &self,
        index: u32,
        maximum: u64,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        let item = self.item(index)?;
        self.view.process_value(self.input(&item)?, maximum, check)
    }
    pub fn item_receipt(&self, index: u32) -> Result<Option<HistoricalAttachmentReceipt>> {
        let item = self.item(index)?;
        self.view.value_receipt(self.input(&item)?)
    }
    pub fn item_identity(&self, index: u32) -> Result<String> {
        let item = self.item(index)?;
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                self.source_identity()?,
                self.view.value_id(self.input(&item)?)?
            ))?)
        ))
    }
    pub fn read_item_chunk(
        &self,
        index: u32,
        offset: u64,
        limit: usize,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Vec<u8>> {
        ensure!(
            check(HistoricalAttachmentStage::Extracting, 0),
            "history_tool_attachments_cancelled"
        );
        let item = self.item(index)?;
        let bytes = self.view.value_chunk(self.input(&item)?, offset, limit)?;
        ensure!(
            check(HistoricalAttachmentStage::Extracting, bytes.len() as u64),
            "history_tool_attachments_cancelled"
        );
        Ok(bytes)
    }
}
