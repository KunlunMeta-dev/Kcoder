//! Compile bounded inert historical facts; no Engine, Provider, current tool or permission is built.
use crate::{history_attachment_jobs::HistoryAttachmentJobs, history_branches::HistoryBranchStore};
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::ExternalHistoryReader;
use kcoder_types::{
    historical_attachment::*, historical_context::*, historical_tool_links::*,
    imported_transcript::*, migration::MigrationSourceKind,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
};
mod attachments;
mod blocks;
mod catalogs;
mod claude_metadata;
mod local;
mod tool_parts;
const MAX_SOURCE_ITEMS: u64 = 16_384;
const MAX_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ISSUES: usize = 64;
pub const HISTORY_CONTEXT_REVISION: &str = HISTORICAL_CONTEXT_COMPILER_REVISION;
pub(crate) fn validate_local_attachments(
    root: &str,
    view: &str,
    policy: &HistoricalContextPolicy,
    values: &[HistoricalLocalAttachmentBinding],
) -> Result<()> {
    local::bindings(root, view, policy, values).map(|_| ())
}
#[derive(Clone, Copy)]
pub enum HistoryContextPhase {
    Metadata,
    Correlating,
    Reading,
    VerifyingAttachment,
}
#[derive(Clone, Copy)]
pub struct HistoryContextProgress {
    pub phase: HistoryContextPhase,
    pub position: u64,
    pub bytes: u64,
}
pub struct HistoryContextCompiler {
    branches: HistoryBranchStore,
    attachments: Option<HistoryAttachmentJobs>,
    profile: PathBuf,
}
struct Evidence {
    links: BTreeMap<(u64, u32), HistoricalToolLink>,
    digest: Option<String>,
    ready: bool,
}
struct BlockContext<'a> {
    execution_enrichment: bool,
    root: &'a str,
    view: &'a str,
    position: u64,
    index: u32,
    role: HistoricalRole,
    reference: &'a HistoricalCodexItemRef,
    record: &'a HistoricalRecord,
    archive: &'a ExternalHistoryReader,
}
struct Builder {
    policy: HistoricalContextPolicy,
    report: HistoricalContextReport,
    document: HistoricalContextDocument,
    encoded: u64,
    seen: BTreeSet<(u64, u32)>,
    omitted_tools: BTreeSet<String>,
    local_bindings: BTreeMap<(u64, u32, Option<u32>), HistoricalLocalAttachmentBinding>,
    local_seen: BTreeSet<(u64, u32, Option<u32>)>,
}
struct Size {
    bytes: u64,
    maximum: u64,
}
impl Write for Size {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(bytes.len() as u64);
        if self.bytes > self.maximum {
            return Err(std::io::Error::other(
                "history_context_byte_budget_exceeded",
            ));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn size(value: &impl Serialize, maximum: u64) -> Result<u64> {
    let mut writer = Size { bytes: 0, maximum };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| anyhow::anyhow!("history_context_byte_budget_exceeded"))?;
    Ok(writer.bytes)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
impl Builder {
    fn issue(&mut self, code: &str, position: Option<u64>, block: Option<u32>) {
        if self.report.issues.len() < MAX_ISSUES {
            self.report.issues.push(HistoricalContextIssue {
                code: code.into(),
                position,
                block_index: block,
            })
        } else {
            self.report.issues_truncated = true
        }
    }
    fn push(&mut self, entry: HistoricalContextEntry) -> Result<bool> {
        let cost = match size(&entry, self.policy.max_context_bytes) {
            Ok(value) => value + 1,
            Err(_) => {
                self.issue(
                    "history_context_byte_budget_exceeded",
                    Some(entry.position),
                    Some(entry.block_index),
                );
                return Ok(false);
            }
        };
        let reconstructed = historical_context_revision_reconstructed(&self.document.revision);
        let tool_fact = |value: &HistoricalContextEntry| {
            matches!(
                value.kind,
                HistoricalContextFactKind::ToolCallFact | HistoricalContextFactKind::ToolResultFact
            )
        };
        if reconstructed {
            if tool_fact(&entry)
                && entry
                    .call_id
                    .as_ref()
                    .is_some_and(|id| self.omitted_tools.contains(id))
            {
                self.report.excluded_provider_blocks =
                    self.report.excluded_provider_blocks.saturating_add(1);
                return Ok(false);
            }
            while self.document.entries.len() >= self.policy.max_entries as usize
                || cost > self.policy.max_context_bytes.saturating_sub(self.encoded)
            {
                let Some(at) = self.document.entries.iter().position(tool_fact) else {
                    break;
                };
                let id = self.document.entries[at].call_id.clone();
                if let Some(id) = &id {
                    self.omitted_tools.insert(id.clone());
                }
                let mut index = self.document.entries.len();
                while index > 0 {
                    index -= 1;
                    let current = &self.document.entries[index];
                    let remove = tool_fact(current)
                        && (index == at || id.is_some() && current.call_id == id);
                    if remove {
                        let removed = self.document.entries.remove(index);
                        self.encoded = self
                            .encoded
                            .saturating_sub(size(&removed, self.policy.max_context_bytes)? + 1);
                        self.report.excluded_provider_blocks =
                            self.report.excluded_provider_blocks.saturating_add(1);
                    }
                }
                if tool_fact(&entry)
                    && entry
                        .call_id
                        .as_ref()
                        .is_some_and(|id| self.omitted_tools.contains(id))
                {
                    self.report.excluded_provider_blocks =
                        self.report.excluded_provider_blocks.saturating_add(1);
                    return Ok(false);
                }
            }
        }
        if self.document.entries.len() >= self.policy.max_entries as usize {
            self.issue(
                "history_context_entry_budget_exceeded",
                Some(entry.position),
                Some(entry.block_index),
            );
            return Ok(false);
        }
        if cost > self.policy.max_context_bytes.saturating_sub(self.encoded) {
            self.issue(
                "history_context_byte_budget_exceeded",
                Some(entry.position),
                Some(entry.block_index),
            );
            return Ok(false);
        }
        self.encoded += cost;
        self.document.entries.push(entry);
        Ok(true)
    }
    fn entry(
        &self,
        position: u64,
        block: u32,
        role: HistoricalRole,
        kind: HistoricalContextFactKind,
    ) -> HistoricalContextEntry {
        HistoricalContextEntry {
            position,
            block_index: block,
            source_array_index: None,
            source_role: role,
            kind,
            text: String::new(),
            call_id: None,
            name: None,
            namespace: None,
            outcome: None,
            execution_outcome: None,
        }
    }
    fn text(
        &mut self,
        archive: &ExternalHistoryReader,
        value: &HistoricalValueRef,
        position: u64,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<Option<String>> {
        let available = if historical_context_revision_reconstructed(&self.document.revision) {
            self.policy.max_context_bytes
        } else {
            self.policy.max_context_bytes.saturating_sub(self.encoded)
        };
        if value.decoded_bytes.unwrap_or(value.bytes) > available {
            self.issue("history_context_byte_budget_exceeded", Some(position), None);
            return Ok(None);
        }
        let mut offset = 0;
        let mut text = String::new();
        loop {
            let chunk = crate::history_display::text::read(
                archive,
                value.record,
                value,
                offset,
                |bytes| {
                    check(HistoryContextProgress {
                        phase: HistoryContextPhase::Reading,
                        position,
                        bytes,
                    })
                },
            )?;
            if (text.len() + chunk.text.len()) as u64 > available {
                self.issue("history_context_byte_budget_exceeded", Some(position), None);
                return Ok(None);
            }
            text.push_str(&chunk.text);
            match chunk.next_offset {
                Some(next) => {
                    ensure!(next > offset, "history_context_cursor_stalled");
                    offset = next
                }
                None => break,
            }
        }
        Ok(Some(text))
    }

    /// Reconstruction can retain bounded tool-result excerpts without pretending
    /// they are complete or a summary. The original archive remains authoritative.
    fn reconstructed_tool_text(
        &mut self,
        archive: &ExternalHistoryReader,
        value: &HistoricalValueRef,
        position: u64,
        block: u32,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<Option<String>> {
        const MAX_EXCERPT_BYTES: usize = 8192;
        if !historical_context_revision_reconstructed(&self.document.revision) {
            return self.text(archive, value, position, check);
        }
        let chunk = crate::history_display::text::read(archive, value.record, value, 0, |bytes| {
            check(HistoryContextProgress {
                phase: HistoryContextPhase::Reading,
                position,
                bytes,
            })
        })?;
        let mut text = chunk.text;
        let truncated = chunk.next_offset.is_some() || text.len() > MAX_EXCERPT_BYTES;
        if truncated {
            let mut end = text.len().min(MAX_EXCERPT_BYTES);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str(&format!("\n[Historical tool output excerpt only; the remainder was not summarized. The complete original is retained at history position {position}, block {block}.]"));
        }
        if text.len() as u64 > self.policy.max_context_bytes {
            self.issue("history_context_byte_budget_exceeded", Some(position), None);
            return Ok(None);
        }
        Ok(Some(text))
    }
}
impl HistoryContextCompiler {
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            branches: HistoryBranchStore::open(profile)?,
            attachments: HistoryAttachmentJobs::open_existing(profile)?,
            profile: profile.into(),
        })
    }
    pub fn compile(
        &self,
        root: &str,
        view: &str,
        policy: HistoricalContextPolicy,
        check: impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<HistoricalContextCompilation> {
        self.compile_with_local_attachments(root, view, policy, &[], check)
    }
    pub fn compile_with_local_attachments(
        &self,
        root: &str,
        view: &str,
        policy: HistoricalContextPolicy,
        local_attachments: &[HistoricalLocalAttachmentBinding],
        mut check: impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<HistoricalContextCompilation> {
        ensure!(
            (1..=HISTORICAL_CONTEXT_MAX_BYTES).contains(&policy.max_context_bytes)
                && (1..=HISTORICAL_CONTEXT_MAX_ENTRIES).contains(&policy.max_entries)
                && policy.max_attachments <= 1024
                && policy.max_attachment_bytes <= 2 * 1024 * 1024 * 1024,
            "history_context_invalid_policy"
        );
        let local_bindings = local::bindings(root, view, &policy, local_attachments)?;
        ensure!(
            check(HistoryContextProgress {
                phase: HistoryContextPhase::Metadata,
                position: 0,
                bytes: 0
            }),
            "history_context_cancelled"
        );
        let (first, identity) = self.branches.snapshot(root, view, 0)?;
        let reconstructed = matches!(
            first.recipe.revision.as_str(),
            crate::history_branches::HISTORY_RECONSTRUCTION_BRANCH_REVISION
                | crate::history_branches::HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
        ) && first.progress.structural_complete == Some(false)
            && first.progress.issues.as_slice()
                == ["codex_readable_reconstruction_requires_admission"];
        let execution_enrichment = crate::history_normalization::supports_execution_events(
            &first.recipe.normalization_revision,
        );
        let document = HistoricalContextDocument {
            revision: if reconstructed {
                HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION
            } else {
                HISTORY_CONTEXT_REVISION
            }
            .into(),
            source: first.recipe.source,
            source_job_id: root.into(),
            view_id: view.into(),
            entries: Vec::new(),
            attachments: Vec::new(),
        };
        let mut builder = Builder {
            encoded: size(&document, policy.max_context_bytes)
                .unwrap_or(policy.max_context_bytes + 1),
            policy,
            document,
            seen: BTreeSet::new(),
            omitted_tools: BTreeSet::new(),
            local_bindings,
            local_seen: BTreeSet::new(),
            report: HistoricalContextReport {
                context_compiled: false,
                selected_items: first.progress.written_items,
                entries: 0,
                encoded_bytes: 0,
                attachments: 0,
                attachment_bytes: 0,
                excluded_provider_blocks: 0,
                issues: Vec::new(),
                issues_truncated: false,
            },
        };
        if !reconstructed
            && (first.progress.structural_complete != Some(true)
                || !first.progress.issues.is_empty())
        {
            builder.issue("history_context_incomplete_branch", None, None)
        }
        if first.progress.written_items > MAX_SOURCE_ITEMS {
            builder.issue("history_context_scan_budget_exceeded", None, None)
        }
        if !builder.report.issues.is_empty() {
            return Ok(Self::blocked(builder));
        }
        let evidence = self.evidence(root, view, &mut builder, &mut check)?;
        let mut cursor = 0;
        let mut snapshot = first;
        loop {
            // Branch validation binds its exact interpretation; it need not be the legacy default.
            for (at, reference) in snapshot.items.iter().enumerate() {
                let position = cursor + at as u64;
                ensure!(
                    check(HistoryContextProgress {
                        phase: HistoryContextPhase::Metadata,
                        position,
                        bytes: 0
                    }),
                    "history_context_cancelled"
                );
                let (archive, record) = self.branches.native_record(&snapshot.recipe, reference)?;
                if reconstructed
                    && snapshot.recipe.revision
                        == crate::history_branches::HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
                    && let Some((kind, value)) =
                        crate::history_codex::inert_search_reference(&record)
                {
                    if record.diagnostics.iter().any(|issue| {
                        issue.blocks_continuation && issue.code != "unsupported_response_item"
                    }) {
                        builder.issue("history_context_source_diagnostic", Some(position), None);
                        continue;
                    }
                    let mut entry = builder.entry(
                        position,
                        0,
                        HistoricalRole::Assistant,
                        HistoricalContextFactKind::Text,
                    );
                    entry.text = crate::history_codex::inert_search_summary(
                        &archive,
                        record.record,
                        kind,
                        value,
                    )?;
                    builder.push(entry)?;
                    continue;
                }
                if record
                    .diagnostics
                    .iter()
                    .any(|issue| issue.blocks_continuation)
                {
                    builder.issue("history_context_source_diagnostic", Some(position), None);
                    continue;
                }
                if execution_enrichment
                    && blocks::verified_execution_event(&record, reference, position, &evidence)
                {
                    continue;
                }
                if catalogs::is_foreign_capability_catalog(&archive, &record, |bytes| {
                    check(HistoryContextProgress {
                        phase: HistoryContextPhase::Metadata,
                        position,
                        bytes,
                    })
                })? {
                    builder.report.excluded_provider_blocks += 1;
                    continue;
                }
                if let Some(metadata) = claude_metadata::read(&archive, &record)? {
                    match metadata {
                        claude_metadata::ClaudeMetadata::Empty => {
                            builder.report.excluded_provider_blocks += 1;
                        }
                        claude_metadata::ClaudeMetadata::AwaySummary(summary) => {
                            let mut entry = builder.entry(
                                position,
                                0,
                                HistoricalRole::System,
                                HistoricalContextFactKind::Text,
                            );
                            entry.text = format!("[Historical away summary]\n{summary}");
                            builder.push(entry)?;
                        }
                    }
                    continue;
                }
                let HistoricalRecordData::Message { role, blocks, .. } = &record.data else {
                    builder.issue("history_context_unconverted_record", Some(position), None);
                    continue;
                };
                if *role == HistoricalRole::Unknown {
                    builder.issue("history_context_unknown_role", Some(position), None);
                    continue;
                }
                for (index, block) in blocks.iter().enumerate() {
                    let index = u32::try_from(index)?;
                    let context = BlockContext {
                        execution_enrichment,
                        root,
                        view,
                        position,
                        index,
                        role: *role,
                        reference,
                        record: &record,
                        archive: &archive,
                    };
                    self.block(&context, block, &evidence, &mut builder, &mut check)?;
                }
            }
            let Some(next) = snapshot.next_cursor else {
                break;
            };
            ensure!(next > cursor, "history_context_cursor_stalled");
            cursor = next;
            let (next_snapshot, next_identity) = self.branches.snapshot(root, view, cursor)?;
            ensure!(
                next_identity == identity && next_snapshot.recipe == snapshot.recipe,
                "history_context_source_changed"
            );
            snapshot = next_snapshot;
        }
        if evidence.ready && builder.seen.len() != evidence.links.len() {
            builder.issue("history_context_tool_evidence_mismatch", None, None)
        }
        if builder.local_seen.len() != builder.local_bindings.len() {
            builder.issue("history_context_local_binding_unused", None, None);
        }
        let encoded = size(&builder.document, builder.policy.max_context_bytes);
        if encoded.is_err() {
            builder.issue("history_context_byte_budget_exceeded", None, None)
        }
        if !builder.report.issues.is_empty() || builder.report.issues_truncated {
            return Ok(Self::blocked(builder));
        }
        let (_, after) = self.branches.snapshot(root, view, 0)?;
        ensure!(after == identity, "history_context_source_changed");
        ensure!(
            check(HistoryContextProgress {
                phase: HistoryContextPhase::Metadata,
                position: builder.report.selected_items,
                bytes: 0
            }),
            "history_context_cancelled"
        );
        builder.report.context_compiled = true;
        builder.report.entries = builder.document.entries.len() as u32;
        builder.report.encoded_bytes = encoded?;
        builder.report.attachments = builder.document.attachments.len() as u32;
        let binding = HistoricalContextBinding {
            compiler_revision: builder.document.revision.clone(),
            policy: builder.policy,
            branch_identity: identity,
            tool_links_sha256: evidence.digest,
            attachments_sha256: hash(&builder.document.attachments)?,
            document_sha256: hash(&builder.document)?,
        };
        Ok(HistoricalContextCompilation {
            report: builder.report,
            document: Some(builder.document),
            binding: Some(binding),
        })
    }
    fn blocked(builder: Builder) -> HistoricalContextCompilation {
        HistoricalContextCompilation {
            report: builder.report,
            document: None,
            binding: None,
        }
    }
    fn evidence(
        &self,
        root: &str,
        view: &str,
        builder: &mut Builder,
        check: &mut impl FnMut(HistoryContextProgress) -> bool,
    ) -> Result<Evidence> {
        let state = self.branches.tools_state(root, view)?;
        let ready = state
            .run
            .is_some_and(|v| v.stage == HistoricalToolLinkStage::Ready)
            && state.progress.as_ref().is_some_and(|v| v.sealed);
        let mut result = Evidence {
            ready,
            links: BTreeMap::new(),
            digest: None,
        };
        if !ready {
            return Ok(result);
        }
        if state.progress.as_ref().unwrap().recorded_links > HISTORICAL_CONTEXT_MAX_ENTRIES as u64 {
            builder.issue("history_context_tool_budget_exceeded", None, None);
            return Ok(result);
        }
        let mut cursor = None;
        let mut digest = Sha256::new();
        let mut bytes = 0usize;
        loop {
            ensure!(
                check(HistoryContextProgress {
                    phase: HistoryContextPhase::Correlating,
                    position: 0,
                    bytes: bytes as u64
                }),
                "history_context_cancelled"
            );
            let page = self.branches.tools_page(root, view, cursor.as_deref())?;
            for link in page.links {
                let encoded = serde_json::to_vec(&link)?;
                bytes = bytes
                    .checked_add(encoded.len())
                    .context("history_context_tool_budget_exceeded")?;
                if bytes > MAX_EVIDENCE_BYTES {
                    builder.issue("history_context_tool_budget_exceeded", None, None);
                    return Ok(result);
                }
                digest.update(encoded);
                let known_missing = link.status == HistoricalToolLinkStatus::MissingResult
                    && link.call.is_some()
                    && link.result.is_none()
                    && link.execution_event.is_none()
                    && link.execution_outcome.is_none()
                    && link.outcome == HistoricalToolOutcome::OutcomeUnknown;
                let known_orphan = link.status == HistoricalToolLinkStatus::OrphanResult
                    && link.call.is_none()
                    && link.result.is_some()
                    && link.execution_event.is_none()
                    && link.execution_outcome.is_none()
                    && link.name.is_none()
                    && link.namespace.is_none();
                if link.status != HistoricalToolLinkStatus::Linked
                    && !known_missing
                    && !known_orphan
                {
                    builder.issue(
                        "history_context_unresolved_tool",
                        link.call
                            .as_ref()
                            .or(link.result.as_ref())
                            .map(|v| v.sequence),
                        None,
                    );
                    continue;
                }
                for location in [&link.call, &link.result].into_iter().flatten() {
                    if let Some(block) = location.block {
                        if result
                            .links
                            .insert((location.sequence, block), link.clone())
                            .is_some()
                        {
                            builder.issue(
                                "history_context_tool_evidence_mismatch",
                                Some(location.sequence),
                                Some(block),
                            )
                        }
                    } else {
                        builder.issue(
                            "history_context_tool_evidence_mismatch",
                            Some(location.sequence),
                            None,
                        )
                    }
                }
            }
            match page.next_cursor {
                Some(next) => {
                    ensure!(
                        cursor.as_ref() != Some(&next),
                        "history_context_cursor_stalled"
                    );
                    cursor = Some(next)
                }
                None => break,
            }
        }
        result.digest = Some(format!("{:x}", digest.finalize()));
        Ok(result)
    }
}
