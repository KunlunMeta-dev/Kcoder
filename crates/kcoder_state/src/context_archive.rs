//! Derived, incremental index of compression sources in the original transcript.
//! The current State supplies the root. Paths and references grant no authority.
use crate::history_store::{SourceStamp, committed_source_stamp};
use crate::{AppState, HistoryEntry};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_types::context_archive::{
    ContextBlockInfo, ContextBlockSource, ContextHistoryHit, ContextHistoryPage,
    ContextHistoryQuery,
};
use kcoder_types::{ContentBlock, Message, MessageOrigin};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
mod checkpoint;
mod inheritance;
pub use checkpoint::ContextHistoryCheckpoint;
pub use inheritance::ContextHistoryAnchor;
pub(crate) use inheritance::InheritedArchive;
use inheritance::{ArchiveReference, open_archive};

const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const SCAN_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROWS: usize = 1_000_000;
const MAX_BLOCKS: usize = 4096;
const MAX_PAGE_CHARS: usize = 32_000;

#[derive(Debug, thiserror::Error)]
#[error(
    "context history indexing failed or its source changed; reconcile the original history and reopen the session"
)]
struct ArchiveCorrupt;

#[derive(Debug)]
struct Row {
    offset: u64,
    bytes: usize,
    digest: [u8; 32],
    is_summary: bool,
    inherited: bool,
}

#[derive(Debug)]
struct InheritedFile {
    reference: ArchiveReference,
    file: File,
    identity: PortableLeaseIdentity,
    offset: u64,
    hash: Sha256,
    verified: bool,
}

#[derive(Debug)]
struct Block {
    source: ContextBlockSource,
    summary: String,
    summary_truncated: bool,
    parent_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct ContextArchive {
    path: PathBuf,
    file: File,
    identity: PortableLeaseIdentity,
    stamp: SourceStamp,
    offset: u64,
    rows: HashMap<String, Row>,
    blocks: HashMap<String, Block>,
    pending_source: Option<ContextBlockSource>,
    // One verified message is retained across its text pages. Native body
    // replacement, directory/file replacement and session changes drop it.
    cached_message: Option<(String, Message)>,
    poisoned: bool,
    inherited: Option<InheritedFile>,
    // Release open archive handles before the temporary storage lease.
    _private_storage: Option<std::sync::Arc<kcoder_config::PrivateTempDir>>,
}

impl AppState {
    /// Read only this State's currently reachable compression ancestry. The
    /// caller keeps its normal turn cancellation and tool authorization gates.
    pub fn context_history(
        &self,
        query: &ContextHistoryQuery,
        cancelled: impl Fn() -> bool,
    ) -> Result<ContextHistoryPage> {
        let lifecycle = self.inspection_lifecycle_identity();
        self.context_history_for_lifecycle(query, &lifecycle, cancelled)
    }

    pub fn context_history_for_lifecycle(
        &self,
        query: &ContextHistoryQuery,
        lifecycle: &crate::AppStateLifecycleIdentity,
        cancelled: impl Fn() -> bool,
    ) -> Result<ContextHistoryPage> {
        ensure!(!cancelled(), "context history cancelled");
        ensure!(
            (1..=20).contains(&query.limit),
            "context history limit must be 1..=20"
        );
        ensure!(
            query
                .query
                .as_ref()
                .is_none_or(|text| !text.trim().is_empty() && text.len() <= 1024),
            "context history query must contain 1..=1024 bytes"
        );
        let (path, root, source) = {
            let inner = self.read_inner();
            ensure!(
                lifecycle.matches_locked(self, &inner),
                "context history session changed before access"
            );
            ensure!(
                inner.history_write_fault.is_none(),
                "context history persistence is faulted; reconcile the original history first"
            );
            let root = inner
                .messages
                .first()
                .filter(|message| message.origin() == MessageOrigin::Compaction)
                .and_then(|_| inner.message_history_ids.first())
                .cloned()
                .flatten();
            (
                inner.history_path.clone(),
                root,
                inner.history_source.clone(),
            )
        };
        let mut empty = ContextHistoryPage {
            notice: Some("no_committed_compression_sources".into()),
            snapshot: String::new(),
            indexing: false,
            scanned_bytes: 0,
            blocks: Vec::new(),
            hits: Vec::new(),
            text: String::new(),
            next_offset: None,
            next_text_offset: None,
        };
        let (Some(path), Some(root), Some(source)) = (path, root, source) else {
            ensure!(
                query.block_id.is_none()
                    && query.message_id.is_none()
                    && query.offset == 0
                    && query.snapshot.is_none(),
                "context history reference is unavailable for this session"
            );
            return Ok(empty);
        };
        source.check_read_binding()?;
        let owner = source.identity();
        let mut cache = self
            .context_archive_cache
            .try_lock()
            .map_err(|_| anyhow::anyhow!("context history index is busy or unavailable"))?;
        let stamp = committed_source_stamp(&path)?;
        let (incarnation, generation, _) = stamp.committed_body_key()?;
        // A selected immutable block keeps its pages across later compactions.
        // Membership is still checked against the current root on every read.
        let selected_root = query.block_id.as_deref().unwrap_or(&root);
        let snapshot = format!("{incarnation}:{generation}:{selected_root}");
        ensure!(
            query
                .snapshot
                .as_ref()
                .is_none_or(|value| value == &snapshot),
            "context history snapshot changed; restart at offset zero"
        );
        let file = open_history(&path)?;
        let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
        let replace = cache.as_ref().is_none_or(|old| {
            old.path != path
                || old.identity != identity
                || !stamp.extends_committed_body(&old.stamp)
        });
        if replace {
            *cache = Some(ContextArchive {
                path: path.clone(),
                file,
                identity,
                stamp: stamp.clone(),
                offset: 0,
                rows: HashMap::new(),
                blocks: HashMap::new(),
                pending_source: None,
                cached_message: None,
                poisoned: false,
                inherited: None,
                _private_storage: source.private_storage(),
            });
        }
        let archive = cache.as_mut().unwrap();
        let refreshed = archive.refresh(&stamp, &cancelled);
        let result = refreshed.and_then(|scanned| {
            empty.snapshot = snapshot;
            empty.notice = None;
            empty.scanned_bytes = scanned;
            if archive.offset < stamp.known_committed_bytes().unwrap()
                || archive
                    .inherited
                    .as_ref()
                    .is_some_and(|file| !file.verified)
            {
                empty.indexing = true;
                empty.next_offset = Some(query.offset);
                return Ok(empty);
            }
            archive.page(&root, query, empty, &cancelled)
        });
        let inner = self.read_inner();
        ensure!(
            lifecycle.matches_locked(self, &inner)
                && inner.history_path.as_ref() == Some(&path)
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|current| owner.matches(current))
                && inner.message_history_ids.first().and_then(Option::as_deref)
                    == Some(root.as_str()),
            "context history session changed during access"
        );
        ensure!(!cancelled(), "context history cancelled");
        source.check_read_binding()?;
        result
    }
}

fn open_history(path: &Path) -> Result<File> {
    let parent = path.parent().context("history source has no parent")?;
    let name = path.file_name().context("history source has no filename")?;
    PrivateDirectory::open_existing(parent)?.open_regular_file(name)
}

impl ContextArchive {
    fn refresh(&mut self, stamp: &SourceStamp, cancelled: &impl Fn() -> bool) -> Result<u64> {
        if self.poisoned {
            return Err(ArchiveCorrupt.into());
        }
        let end = stamp
            .known_committed_bytes()
            .context("context history commit is unavailable")?;
        ensure!(
            self.file.metadata()?.len() >= end,
            "context history source is shorter than its commit"
        );
        self.file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(self.file.try_clone()?.take(end - self.offset));
        let start = self.offset;
        let mut inherited_bytes = self.refresh_inherited(SCAN_BYTES, cancelled)?;
        while self.offset < end && self.offset - start + inherited_bytes < SCAN_BYTES {
            ensure!(!cancelled(), "context history cancelled");
            let mut line = Vec::new();
            reader
                .by_ref()
                .take(MAX_LINE_BYTES as u64 + 1)
                .read_until(b'\n', &mut line)?;
            ensure!(
                line.len() <= MAX_LINE_BYTES && line.ends_with(b"\n"),
                "context history record is too large or incomplete"
            );
            if let Err(error) = self.observe(&line, self.offset, false) {
                self.poisoned = true;
                return Err(error);
            }
            self.offset += line.len() as u64;
            if self.inherited.as_ref().is_some_and(|file| !file.verified) {
                inherited_bytes += self.refresh_inherited(
                    SCAN_BYTES.saturating_sub(self.offset - start + inherited_bytes),
                    cancelled,
                )?;
            }
        }
        let current = open_history(&self.path)?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&current)? == self.identity
                && committed_source_stamp(&self.path)?.extends_committed_body(stamp),
            "context history source changed while indexing"
        );
        self.stamp = stamp.clone();
        Ok(self.offset - start + inherited_bytes)
    }

    fn refresh_inherited(&mut self, budget: u64, cancelled: &impl Fn() -> bool) -> Result<u64> {
        let Some(mut inherited) = self.inherited.take() else {
            return Ok(0);
        };
        let result = (|| {
            let current = open_archive(&self.path, &inherited.reference)?;
            ensure!(
                PortableLeaseIdentity::from_regular_handle(&current)? == inherited.identity
                    && inherited.file.metadata()?.len() == inherited.reference.bytes,
                "inherited compression source changed"
            );
            inherited.file.seek(SeekFrom::Start(inherited.offset))?;
            let mut reader = BufReader::new(inherited.file.try_clone()?);
            let start = inherited.offset;
            while inherited.offset < inherited.reference.bytes && inherited.offset - start < budget
            {
                ensure!(!cancelled(), "context history cancelled");
                let mut line = Vec::new();
                reader
                    .by_ref()
                    .take(MAX_LINE_BYTES as u64 + 1)
                    .read_until(b'\n', &mut line)?;
                ensure!(
                    line.len() <= MAX_LINE_BYTES && line.ends_with(b"\n"),
                    "invalid inherited context record"
                );
                self.observe(&line, inherited.offset, true)?;
                inherited.hash.update(&line);
                inherited.offset += line.len() as u64;
                ensure!(
                    inherited.offset <= inherited.reference.bytes,
                    "inherited context exceeded its committed length"
                );
            }
            if inherited.offset == inherited.reference.bytes {
                ensure!(
                    format!("{:x}", inherited.hash.clone().finalize())
                        == inherited.reference.sha256,
                    "inherited context digest does not match"
                );
                inherited.verified = true;
            }
            ensure!(
                inherited.file.metadata()?.len() == inherited.reference.bytes,
                "inherited context changed while indexing"
            );
            Ok(inherited.offset - start)
        })();
        self.inherited = Some(inherited);
        if result.is_err() && !cancelled() {
            self.poisoned = true;
        }
        result
    }

    fn observe(&mut self, line: &[u8], offset: u64, inherited: bool) -> Result<()> {
        let value: serde_json::Value =
            serde_json::from_slice(line).context("invalid context history JSON")?;
        if value.get("type").and_then(|v| v.as_str()) == Some("system") {
            if value.get("subtype").and_then(|v| v.as_str()) == Some("context_archive_reference") {
                ensure!(!inherited, "nested inherited history reference is invalid");
                let reference: ArchiveReference = serde_json::from_value(value["archive"].clone())?;
                if let Some(existing) = &self.inherited {
                    ensure!(
                        existing.reference == reference,
                        "conflicting inherited context reference"
                    );
                } else {
                    let file = open_archive(&self.path, &reference)?;
                    let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
                    self.inherited = Some(InheritedFile {
                        reference,
                        file,
                        identity,
                        offset: 0,
                        hash: Sha256::new(),
                        verified: false,
                    });
                }
            }
            if value.get("subtype").and_then(|v| v.as_str()) == Some("compact_boundary") {
                self.pending_source = value
                    .pointer("/compactMetadata/contextSource")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?;
            }
            return Ok(());
        }
        let Some(id) = value
            .get("uuid")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
        else {
            return Ok(());
        };
        ensure!(
            !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control),
            "invalid context history message identity"
        );
        ensure!(
            self.rows.len() < MAX_ROWS,
            "context history index exceeds its record budget"
        );
        let digest: [u8; 32] = Sha256::digest(line).into();
        let is_summary = value.get("isCompactSummary").and_then(|v| v.as_bool()) == Some(true)
            || value.get("origin").and_then(|v| v.as_str()) == Some("compaction");
        if let Some(old) = self.rows.get(&id) {
            ensure!(
                old.digest == digest,
                "context history contains conflicting message identities"
            );
            return Ok(());
        }
        self.rows.insert(
            id.clone(),
            Row {
                offset,
                bytes: line.len(),
                digest,
                is_summary,
                inherited,
            },
        );
        if is_summary && let Some(mut source) = self.pending_source.take() {
            ensure!(
                source.schema_version == 1 && source.message_ids.len() <= MAX_ROWS,
                "unsupported or oversized context block source"
            );
            ensure!(
                self.blocks.len() < MAX_BLOCKS,
                "context history exceeds its block budget"
            );
            source.complete &= source.message_ids.iter().all(|id| {
                self.rows.get(id).is_some_and(|row| {
                    !row.is_summary
                        || self
                            .blocks
                            .get(id)
                            .is_some_and(|parent| parent.source.complete)
                })
            });
            let entry: HistoryEntry = serde_json::from_value(value)?;
            let summary = text_blocks(&entry.message);
            ensure!(
                summary.len() <= MAX_LINE_BYTES,
                "context block summary exceeds its byte budget"
            );
            let preview = summary.chars().take(2048).collect::<String>();
            let parent_ids = source
                .message_ids
                .iter()
                .filter(|id| self.blocks.contains_key(*id))
                .cloned()
                .collect();
            self.blocks.insert(
                id,
                Block {
                    source,
                    summary_truncated: preview.len() < summary.len(),
                    summary: preview,
                    parent_ids,
                },
            );
        }
        Ok(())
    }

    fn reachable(&self, root: &str) -> Result<Vec<String>> {
        let mut pending = vec![root.to_owned()];
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            ensure!(
                seen.len() <= MAX_BLOCKS,
                "context block ancestry exceeds its budget"
            );
            if let Some(block) = self.blocks.get(&id) {
                result.push(id);
                pending.extend(block.parent_ids.iter().rev().cloned());
            }
        }
        Ok(result)
    }

    fn info(&self, id: &str) -> ContextBlockInfo {
        let block = &self.blocks[id];
        ContextBlockInfo {
            block_id: id.into(),
            summary: block.summary.clone(),
            summary_truncated: block.summary_truncated,
            parent_block_ids: block.parent_ids.clone(),
            source_message_count: block.source.message_ids.len(),
            complete: block.source.complete,
        }
    }

    fn source_ids(&self, root: &str, full: bool) -> Result<Vec<String>> {
        let mut pending = self.blocks[root]
            .source
            .message_ids
            .iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>();
        let mut expanded = HashSet::from([root.to_owned()]);
        let mut result = Vec::new();
        while let Some(id) = pending.pop() {
            if full && let Some(block) = self.blocks.get(&id) {
                ensure!(
                    expanded.insert(id) && block.source.complete,
                    "context block ancestry is cyclic or incomplete"
                );
                pending.extend(block.source.message_ids.iter().rev().cloned());
            } else {
                result.push(id);
            }
            ensure!(
                pending.len() + result.len() <= MAX_ROWS,
                "context block source exceeds its record budget"
            );
        }
        Ok(result)
    }

    fn read_message(&mut self, id: &str) -> Result<(Message, usize)> {
        if let Some((cached_id, message)) = &self.cached_message
            && cached_id == id
        {
            return Ok((message.clone(), 0));
        }
        let row = self
            .rows
            .get(id)
            .context("original context message is unavailable")?;
        let file = if row.inherited {
            &mut self
                .inherited
                .as_mut()
                .context("inherited source unavailable")?
                .file
        } else {
            &mut self.file
        };
        file.seek(SeekFrom::Start(row.offset))?;
        let mut bytes = vec![0u8; row.bytes];
        file.read_exact(&mut bytes)?;
        if <[u8; 32]>::from(Sha256::digest(&bytes)) != row.digest {
            self.poisoned = true;
            return Err(ArchiveCorrupt.into());
        }
        let entry: HistoryEntry = serde_json::from_slice(&bytes)?;
        ensure!(
            entry.uuid.as_deref() == Some(id),
            "original context message identity changed"
        );
        self.cached_message = Some((id.into(), entry.message.clone()));
        Ok((entry.message, bytes.len()))
    }

    fn page(
        &mut self,
        root: &str,
        query: &ContextHistoryQuery,
        mut page: ContextHistoryPage,
        cancelled: &impl Fn() -> bool,
    ) -> Result<ContextHistoryPage> {
        let reachable = self.reachable(root)?;
        if reachable.is_empty() {
            ensure!(
                query.block_id.is_none(),
                "context block source is unavailable"
            );
            page.notice = Some("compression_source_records_unavailable".into());
        }
        if query.block_id.is_none() && query.message_id.is_none() && query.query.is_none() {
            ensure!(
                query.offset <= reachable.len(),
                "context block offset is out of range"
            );
            let end = query
                .offset
                .saturating_add(query.limit)
                .min(reachable.len());
            page.blocks = reachable[query.offset..end]
                .iter()
                .map(|id| self.info(id))
                .collect();
            page.next_offset = (end < reachable.len()).then_some(end);
            return Ok(page);
        }
        let block_id = query.block_id.as_deref().unwrap_or(root);
        ensure!(
            reachable.iter().any(|id| id == block_id),
            "context block is outside the current session ancestry"
        );
        if query.full || query.query.is_some() || query.message_id.is_some() {
            ensure!(
                self.blocks[block_id].source.complete,
                "context block has incomplete source identities"
            );
        }
        let mut ids = self.source_ids(
            block_id,
            query.full || query.query.is_some() || query.message_id.is_some(),
        )?;
        if let Some(message_id) = &query.message_id {
            ensure!(
                query.query.is_none(),
                "select a message or search text, not both"
            );
            ensure!(
                ids.contains(message_id) || self.reachable(block_id)?.contains(message_id),
                "context message is outside the selected block ancestry"
            );
            ids = vec![message_id.clone()];
        }
        if query.query.is_some() {
            let mut corpus = if query.block_id.is_none() {
                reachable
            } else {
                vec![block_id.into()]
            };
            corpus.append(&mut ids);
            let mut seen = HashSet::new();
            ids = corpus
                .into_iter()
                .filter(|id| seen.insert(id.clone()))
                .collect();
        }
        ensure!(
            query.offset <= ids.len(),
            "context source offset is out of range"
        );
        let needle = query.query.as_ref().map(|text| text.to_lowercase());
        let mut remaining = MAX_PAGE_CHARS;
        let mut hits = 0;
        let mut index = query.offset;
        let mut bytes_read = 0;
        while index < ids.len() && hits < query.limit && bytes_read < SCAN_BYTES {
            ensure!(!cancelled(), "context history cancelled");
            let id = &ids[index];
            let is_summary = self.rows.get(id).is_some_and(|row| row.is_summary);
            let (message, bytes) = self.read_message(id)?;
            bytes_read += bytes as u64;
            let text = if is_summary {
                text_blocks(&message)
            } else {
                kcoder_types::public_conversation_message(&message)
                    .map(|message| text_blocks(&message))
                    .unwrap_or_default()
            };
            let text = if let Some(needle) = &needle {
                let Some(excerpt) = search_excerpt(&text, needle) else {
                    index += 1;
                    continue;
                };
                page.hits.push(ContextHistoryHit {
                    block_id: block_id.into(),
                    message_id: id.clone(),
                    excerpt: excerpt.clone(),
                });
                // A search points to a bounded restore page, keeping exact source identity.
                format!("Message {id} in block {block_id}\n{}", excerpt)
            } else {
                text
            };
            if text.is_empty() {
                index += 1;
                continue;
            }
            let text_offset = if index == query.offset {
                query.text_offset
            } else {
                0
            };
            let total_chars = text.chars().count();
            ensure!(
                text_offset <= total_chars,
                "context text offset is out of range"
            );
            let part = text
                .chars()
                .skip(text_offset)
                .take(remaining)
                .collect::<String>();
            let copied = part.chars().count();
            page.text
                .push_str(&format!("\n[Historical source {id}]\n{part}\n"));
            remaining -= copied;
            hits += 1;
            if text_offset + copied < total_chars {
                page.next_offset = Some(index);
                page.next_text_offset = Some(text_offset + copied);
                break;
            }
            index += 1;
            if remaining == 0 {
                break;
            }
        }
        page.scanned_bytes += bytes_read;
        if page.next_offset.is_none() {
            page.next_offset = (index < ids.len()).then_some(index);
        }
        page.blocks.push(self.info(block_id));
        Ok(page)
    }
}

fn text_blocks(message: &Message) -> String {
    fn blocks(content: &[ContentBlock], text: &mut String) {
        for block in content {
            match block {
                ContentBlock::Text { text: part } => {
                    text.push_str(part);
                    text.push('\n');
                }
                ContentBlock::ToolUse { id, name, input } => {
                    text.push_str(&format!("Tool {name} ({id})\n{input}\n"));
                }
                ContentBlock::ToolResult { content, .. } => blocks(content, text),
                _ => {}
            }
        }
    }
    let mut text = String::new();
    match message {
        Message::User { content, .. } | Message::Assistant { content, .. } => {
            blocks(content, &mut text)
        }
    }
    text
}

fn search_excerpt(text: &str, needle: &str) -> Option<String> {
    let match_offset = text.to_lowercase().find(needle)?;
    let mut lowered_bytes = 0;
    let mut source_offset = 0;
    for (offset, character) in text.char_indices() {
        if lowered_bytes >= match_offset {
            source_offset = offset;
            break;
        }
        lowered_bytes += character.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    let start = text[..source_offset]
        .char_indices()
        .rev()
        .nth(160)
        .map_or(0, |(offset, _)| offset);
    Some(text[start..].chars().take(1000).collect())
}

#[cfg(test)]
#[path = "context_archive/tests.rs"]
mod tests;
