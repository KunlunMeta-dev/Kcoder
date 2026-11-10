//! Streaming extraction from authenticated archived blocks, with no network or source-file reads.
use crate::{
    history_json::{self, Node, Segment, Value},
    history_normalization::HISTORY_NORMALIZATION_REVISION,
};
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::{
    ExternalHistoryReader, projection::HistoricalProjectionStore,
};
use kcoder_types::{historical_attachment::*, imported_transcript::*};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io::{Cursor, Read},
};
mod decode;
mod local;

pub struct HistoryAttachmentView {
    archive: ExternalHistoryReader,
    projection: HistoricalProjectionStore,
}
/// Bound by the branch domain, rather than a client-supplied physical record or replacement.
pub struct HistorySelectedAttachment {
    view: HistoryAttachmentView,
    record: u64,
    block: u32,
    replacement: Option<u32>,
    _branch: Option<kcoder_state::external_history::branch_views::HistoricalBranchView>,
}
impl HistorySelectedAttachment {
    pub(crate) fn new(
        view: HistoryAttachmentView,
        reference: &HistoricalCodexItemRef,
        block: u32,
    ) -> Result<Self> {
        let selected = crate::history_codex::selected_record(
            view.projection.record(reference.record)?,
            reference,
        )?;
        ensure!(
            matches!(&selected.data, HistoricalRecordData::Message { blocks, .. }
            if matches!(blocks.get(block as usize), Some(HistoricalBlock::Attachment { .. }))),
            "history_attachment_block_not_found"
        );
        let mut physical = block;
        for omitted in &reference.omitted_blocks {
            if *omitted > physical {
                break;
            }
            physical = physical
                .checked_add(1)
                .context("history_attachment_invalid_source")?;
        }
        Ok(Self {
            view,
            record: reference.record,
            block: physical,
            replacement: reference.replacement_index,
            _branch: None,
        })
    }
    pub(crate) fn with_branch(
        mut self,
        branch: kcoder_state::external_history::branch_views::HistoricalBranchView,
    ) -> Self {
        self._branch = Some(branch);
        self
    }
    pub fn inspect(
        &self,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        self.view
            .inspect(self.record, self.block, self.replacement, check)
    }
    pub fn extract(
        &self,
        maximum: u64,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        self.view
            .extract(self.record, self.block, self.replacement, maximum, check)
    }
    pub(crate) fn identity(&self) -> Result<String> {
        self.view
            .binding_identity(self.record, self.block, self.replacement)
    }
    pub(crate) fn receipt(&self) -> Result<Option<HistoricalAttachmentReceipt>> {
        self.view
            .saved_receipt(self.record, self.block, self.replacement)
    }
    pub(crate) fn process(
        &self,
        maximum: u64,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        self.view
            .process(self.record, self.block, self.replacement, maximum, check)
    }
    pub fn read_chunk(
        &self,
        offset: u64,
        limit: usize,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Vec<u8>> {
        self.view.read_chunk(
            self.record,
            self.block,
            self.replacement,
            offset,
            limit,
            check,
        )
    }
}
pub(crate) struct AttachmentValue<'a> {
    pub record: &'a HistoricalRecord,
    pub block: u32,
    pub replacement: Option<u32>,
    pub source_type: &'a str,
    pub value: &'a HistoricalValueRef,
    pub media_type: Option<&'a str>,
}
struct Prepared {
    id: String,
    value: HistoricalValueRef,
    content: Option<HistoricalValueRef>,
    prefix_bytes: usize,
    info: HistoricalAttachmentInfo,
}
type Fields = BTreeMap<Vec<Segment>, Node>;
fn key(parts: &[&str]) -> Vec<Segment> {
    parts.iter().map(|s| Segment::Key((*s).into())).collect()
}
fn text<'a>(fields: &'a Fields, at: &[&str]) -> Option<&'a str> {
    match &fields.get(&key(at))?.value {
        Value::String(value) if value.bytes == value.preview.len() as u64 => Some(&value.preview),
        _ => None,
    }
}
fn mime(value: Option<&str>) -> Option<String> {
    value
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 255
                && s.split_once('/')
                    .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !b.contains('/'))
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/.-+_".contains(&c))
        })
        .map(str::to_owned)
}
fn name(value: Option<&str>) -> Option<String> {
    value
        .map(|s| s.rsplit(['/', '\\']).next().unwrap_or_default())
        .filter(|s| !s.is_empty() && s.len() <= 255 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
fn string_ref(
    fields: &Fields,
    at: &[&str],
    outer: &HistoricalValueRef,
) -> Option<HistoricalValueRef> {
    let node = fields.get(&key(at))?;
    let Value::String(value) = &node.value else {
        return None;
    };
    Some(HistoricalValueRef {
        record: outer.record,
        offset: outer.offset + node.span.start,
        bytes: node.span.end - node.span.start,
        encoding: HistoricalValueEncoding::JsonString,
        decoded_bytes: Some(value.bytes),
        decoded_sha256: Some(value.sha256.clone()),
        preview: None,
    })
}

impl HistoryAttachmentView {
    pub(crate) fn content_identity(&self) -> String {
        self.projection.source_fingerprint()
    }
    fn id(
        &self,
        record: &HistoricalRecord,
        block: u32,
        replacement: Option<u32>,
        source_type: &str,
        value: &HistoricalValueRef,
    ) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "embedded-attachments/1",
                self.projection.adapter_revision(),
                record.source,
                source_type,
                value,
                replacement,
                block,
            ))?)
        ))
    }
    pub fn open(archive: ExternalHistoryReader) -> Result<Self> {
        Self::open_with_revision(archive, HISTORY_NORMALIZATION_REVISION)
    }
    pub fn open_with_revision(archive: ExternalHistoryReader, revision: &str) -> Result<Self> {
        let projection = archive
            .projection(revision, false)?
            .context("history_attachment_normalization_required")?;
        ensure!(
            projection.progress()?.normalization_complete,
            "history_attachment_normalization_required"
        );
        Ok(Self {
            archive,
            projection,
        })
    }
    fn reference_id(&self, record: u64, block: u32, replacement: Option<u32>) -> Result<String> {
        let selected = crate::history_codex::selected_record(
            self.projection.record(record)?,
            &HistoricalCodexItemRef {
                source_index: 0,
                record,
                replacement_index: replacement,
                omitted_blocks: Vec::new(),
            },
        )?;
        let HistoricalRecordData::Message { blocks, .. } = &selected.data else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        let Some(HistoricalBlock::Attachment {
            source_type, value, ..
        }) = blocks.get(block as usize)
        else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        self.id(&selected, block, replacement, source_type, value)
    }
    pub(crate) fn binding_identity(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
    ) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                self.content_identity(),
                self.reference_id(record, block, replacement)?,
                self.archive
                    .receipt()?
                    .context("external_history_not_committed")?
                    .archive_id,
            ))?)
        ))
    }
    pub(crate) fn saved_receipt(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
    ) -> Result<Option<HistoricalAttachmentReceipt>> {
        self.archive
            .attachment_blob(&self.reference_id(record, block, replacement)?, false)?
            .map(|blob| blob.receipt())
            .transpose()
            .map(Option::flatten)
    }
    pub(crate) fn process(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        maximum: u64,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        ensure!(
            maximum <= HISTORICAL_ATTACHMENT_MAX_BYTES,
            "history_attachment_invalid_budget"
        );
        let prepared = self.prepare(record, block, replacement, &mut check)?;
        if matches!(
            prepared.info.kind,
            HistoricalAttachmentKind::EmbeddedBase64 | HistoricalAttachmentKind::EmbeddedText
        ) {
            self.materialize(prepared, maximum, check)
        } else {
            Ok(prepared.info)
        }
    }
    fn prepare(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Prepared> {
        let record = crate::history_codex::selected_record(
            self.projection.record(record)?,
            &HistoricalCodexItemRef {
                source_index: 0,
                record,
                replacement_index: replacement,
                omitted_blocks: Vec::new(),
            },
        )?;
        let HistoricalRecordData::Message { blocks, .. } = &record.data else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        let Some(HistoricalBlock::Attachment {
            source_type,
            value,
            media_type,
        }) = blocks.get(block as usize)
        else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        self.prepare_value(
            AttachmentValue {
                record: &record,
                block,
                replacement,
                source_type,
                value,
                media_type: media_type.as_deref(),
            },
            check,
        )
    }
    fn prepare_value(
        &self,
        input: AttachmentValue<'_>,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Prepared> {
        ensure!(
            check(HistoricalAttachmentStage::Inspecting, 0),
            "history_attachment_cancelled"
        );
        let AttachmentValue {
            record,
            block,
            replacement,
            source_type,
            value,
            media_type,
        } = input;
        ensure!(
            value.encoding == HistoricalValueEncoding::Json,
            "history_attachment_invalid_source"
        );
        let mut fields = Fields::new();
        let allowed = [
            key(&["type"]),
            key(&["source", "type"]),
            key(&["source", "data"]),
            key(&["source", "media_type"]),
            key(&["source", "url"]),
            key(&["source", "file_id"]),
            key(&["image_url"]),
            key(&["audio_url"]),
            key(&["file_data"]),
            key(&["file_id"]),
            key(&["filename"]),
            key(&["title"]),
            key(&["media_type"]),
            key(&["path"]),
            key(&["file_path"]),
        ];
        history_json::walk(
            self.archive
                .open_record_range(value.record, value.offset, value.bytes)?,
            |path, node| {
                if allowed.iter().any(|v| v == path) {
                    fields.insert(path.to_vec(), node);
                }
                Ok(())
            },
            |bytes| check(HistoricalAttachmentStage::Inspecting, bytes),
        )?;
        ensure!(
            text(&fields, &["type"]) == Some(source_type),
            "history_attachment_source_type_changed"
        );
        let id = self.id(record, block, replacement, source_type, value)?;
        let mut prepared = Prepared {
            id,
            value: value.clone(),
            content: None,
            prefix_bytes: 0,
            info: HistoricalAttachmentInfo {
                kind: HistoricalAttachmentKind::Unsupported,
                media_type: mime(media_type.or_else(|| text(&fields, &["media_type"]))),
                display_name: name(
                    text(&fields, &["filename"]).or_else(|| text(&fields, &["title"])),
                ),
                receipt: None,
                issue: Some("history_attachment_unsupported_source".into()),
            },
        };
        let source_kind = text(&fields, &["source", "type"]);
        if matches!(source_type, "image" | "document" | "file")
            && matches!(source_kind, Some("base64" | "text"))
        {
            prepared.content = string_ref(&fields, &["source", "data"], value);
            prepared.info.media_type = mime(text(&fields, &["source", "media_type"]));
            if prepared.content.is_some() && prepared.info.media_type.is_some() {
                prepared.info.kind = if source_kind == Some("base64") {
                    HistoricalAttachmentKind::EmbeddedBase64
                } else {
                    HistoricalAttachmentKind::EmbeddedText
                };
                prepared.info.issue = None;
            }
        } else if let Some(node) = fields
            .get(&key(&["image_url"]))
            .or_else(|| fields.get(&key(&["file_data"])))
            .or_else(|| fields.get(&key(&["audio_url"])))
        {
            if let Value::String(value) = &node.value {
                if value.preview.starts_with("data:") {
                    if let Some((prefix, _)) = value.preview.split_once(',')
                        && let Some(media) = prefix
                            .strip_prefix("data:")
                            .and_then(|s| s.strip_suffix(";base64"))
                        && let Some(media) = mime(Some(media))
                    {
                        prepared.content = string_ref(
                            &fields,
                            if fields.contains_key(&key(&["image_url"])) {
                                &["image_url"]
                            } else if fields.contains_key(&key(&["file_data"])) {
                                &["file_data"]
                            } else {
                                &["audio_url"]
                            },
                            &prepared.value,
                        );
                        prepared.info.kind = HistoricalAttachmentKind::EmbeddedBase64;
                        prepared.info.media_type = Some(media);
                        prepared.info.issue = None;
                        prepared.prefix_bytes = prefix.len() + 1;
                    }
                } else if value.bytes == value.preview.len() as u64
                    && let Ok(url) = url::Url::parse(&value.preview)
                {
                    match url.scheme() {
                        "file" => {
                            prepared.info.kind = HistoricalAttachmentKind::LocalReference;
                            prepared.info.issue =
                                Some("history_attachment_local_grant_required".into());
                        }
                        "http" | "https" => {
                            prepared.info.kind = HistoricalAttachmentKind::RemoteReference;
                            prepared.info.issue =
                                Some("history_attachment_remote_not_fetched".into());
                        }
                        _ => {}
                    }
                }
            }
        } else if text(&fields, &["file_id"]).is_some()
            || matches!(source_kind, Some("url" | "file"))
        {
            prepared.info.kind = HistoricalAttachmentKind::RemoteReference;
            prepared.info.issue = Some("history_attachment_remote_not_fetched".into());
        } else if text(&fields, &["path"])
            .or_else(|| text(&fields, &["file_path"]))
            .is_some()
        {
            prepared.info.kind = HistoricalAttachmentKind::LocalReference;
            prepared.info.issue = Some("history_attachment_local_grant_required".into());
        }
        if let Some(blob) = self.archive.attachment_blob(&prepared.id, false)? {
            prepared.info.receipt = blob.receipt()?;
        }
        Ok(prepared)
    }
    pub(crate) fn archive(&self) -> &ExternalHistoryReader {
        &self.archive
    }
    pub(crate) fn resolved_record(
        &self,
        record: u64,
        replacement: Option<u32>,
    ) -> Result<HistoricalRecord> {
        crate::history_codex::selected_record(
            self.projection.record(record)?,
            &HistoricalCodexItemRef {
                source_index: 0,
                record,
                replacement_index: replacement,
                omitted_blocks: Vec::new(),
            },
        )
    }
    pub(crate) fn inspect_value(
        &self,
        input: AttachmentValue<'_>,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        Ok(self.prepare_value(input, check)?.info)
    }
    pub(crate) fn process_value(
        &self,
        input: AttachmentValue<'_>,
        maximum: u64,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        ensure!(
            maximum <= HISTORICAL_ATTACHMENT_MAX_BYTES,
            "history_attachment_invalid_budget"
        );
        let prepared = self.prepare_value(input, &mut check)?;
        if matches!(
            prepared.info.kind,
            HistoricalAttachmentKind::EmbeddedBase64 | HistoricalAttachmentKind::EmbeddedText
        ) {
            self.materialize(prepared, maximum, check)
        } else {
            Ok(prepared.info)
        }
    }
    pub(crate) fn value_id(&self, input: AttachmentValue<'_>) -> Result<String> {
        self.id(
            input.record,
            input.block,
            input.replacement,
            input.source_type,
            input.value,
        )
    }
    pub(crate) fn value_receipt(
        &self,
        input: AttachmentValue<'_>,
    ) -> Result<Option<HistoricalAttachmentReceipt>> {
        self.archive
            .attachment_blob(&self.value_id(input)?, false)?
            .map(|blob| blob.receipt())
            .transpose()
            .map(Option::flatten)
    }
    pub(crate) fn value_chunk(
        &self,
        input: AttachmentValue<'_>,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>> {
        self.archive
            .attachment_blob(&self.value_id(input)?, false)?
            .context("history_attachment_not_ready")?
            .read_chunk(offset, limit)
    }
    pub fn inspect(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        Ok(self.prepare(record, block, replacement, check)?.info)
    }
    pub fn extract(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        maximum: u64,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        ensure!(
            maximum <= HISTORICAL_ATTACHMENT_MAX_BYTES,
            "history_attachment_invalid_budget"
        );
        let prepared = self.prepare(record, block, replacement, &mut check)?;
        ensure!(
            matches!(
                prepared.info.kind,
                HistoricalAttachmentKind::EmbeddedBase64 | HistoricalAttachmentKind::EmbeddedText
            ),
            "history_attachment_not_embedded"
        );
        self.materialize(prepared, maximum, check)
    }
    fn materialize(
        &self,
        mut prepared: Prepared,
        maximum: u64,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<HistoricalAttachmentInfo> {
        let content = prepared
            .content
            .context("history_attachment_invalid_source")?;
        let mut blob = self
            .archive
            .attachment_blob_with_check(&prepared.id, true, || {
                check(HistoricalAttachmentStage::Extracting, 0)
            })?
            .context("history_attachment_not_ready")?;
        let callback = RefCell::new(&mut check);
        let progress = Cell::new(0u64);
        let mut input = decode::StringReader::new(
            &self.archive,
            content,
            &callback,
            &progress,
            prepared.prefix_bytes,
        );
        let mut decoded;
        let receipt = if prepared.info.kind == HistoricalAttachmentKind::EmbeddedBase64 {
            decoded = base64::read::DecoderReader::new(
                &mut input,
                &base64::engine::general_purpose::STANDARD,
            );
            blob.publish(&mut decoded, maximum, |bytes| {
                progress.set(bytes);
                callback.borrow_mut()(HistoricalAttachmentStage::Extracting, bytes)
            })?
        } else {
            blob.publish(&mut input, maximum, |bytes| {
                progress.set(bytes);
                callback.borrow_mut()(HistoricalAttachmentStage::Extracting, bytes)
            })?
        };
        prepared.info.receipt = Some(receipt);
        Ok(prepared.info)
    }
    pub fn read_chunk(
        &self,
        record: u64,
        block: u32,
        replacement: Option<u32>,
        offset: u64,
        limit: usize,
        mut check: impl FnMut(HistoricalAttachmentStage, u64) -> bool,
    ) -> Result<Vec<u8>> {
        ensure!(
            check(HistoricalAttachmentStage::Extracting, 0),
            "history_attachment_cancelled"
        );
        let selected = crate::history_codex::selected_record(
            self.projection.record(record)?,
            &HistoricalCodexItemRef {
                source_index: 0,
                record,
                replacement_index: replacement,
                omitted_blocks: Vec::new(),
            },
        )?;
        let HistoricalRecordData::Message { blocks, .. } = &selected.data else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        let Some(HistoricalBlock::Attachment {
            source_type, value, ..
        }) = blocks.get(block as usize)
        else {
            anyhow::bail!("history_attachment_block_not_found");
        };
        let id = self.id(&selected, block, replacement, source_type, value)?;
        let bytes = self
            .archive
            .attachment_blob(&id, false)?
            .context("history_attachment_not_ready")?
            .read_chunk(offset, limit)?;
        ensure!(
            check(HistoricalAttachmentStage::Extracting, bytes.len() as u64),
            "history_attachment_cancelled"
        );
        Ok(bytes)
    }
}
