//! Readable-history reconstruction is separate from exact Codex window selection.
use super::*;
use kcoder_state::external_history::ExternalHistoryReader;

mod guardian;
mod inert;
pub(crate) use inert::{reference as inert_search_reference, summary as inert_search_summary};

const MAX_TOOL_DECLARATION_BYTES: u64 = 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AdditionalTools {
    #[serde(rename = "type")]
    kind: String,
    role: String,
    #[serde(default)]
    id: Option<String>,
    tools: Vec<serde_json::Map<String, serde_json::Value>>,
}

/// Candidate references only. This is not a continuation receipt or proof that
/// the opaque provider checkpoint can be reproduced.
pub struct ReconstructedCodexHistory {
    source_fingerprint: String,
    selection_sha256: String,
    items: Vec<HistoricalCodexItemRef>,
    tool_records: Vec<HistoricalCodexItemRef>,
    opaque_checkpoints: u64,
    omitted_tool_declarations: u64,
    verified_guardian_snapshots: u64,
    inert_search_records: u64,
}

impl ReconstructedCodexHistory {
    pub fn source_fingerprint(&self) -> &str {
        &self.source_fingerprint
    }
    pub fn items(&self) -> &[HistoricalCodexItemRef] {
        &self.items
    }
    pub fn selection_sha256(&self) -> &str {
        &self.selection_sha256
    }
    /// Historical tool evidence is retained as references, not executable calls.
    pub fn tool_records(&self) -> &[HistoricalCodexItemRef] {
        &self.tool_records
    }
    pub fn opaque_checkpoints(&self) -> u64 {
        self.opaque_checkpoints
    }
    /// Old tool declarations remain only in the original archive.
    pub fn omitted_tool_declarations(&self) -> u64 {
        self.omitted_tool_declarations
    }
    pub fn verified_guardian_snapshots(&self) -> u64 {
        self.verified_guardian_snapshots
    }
    pub fn inert_search_records(&self) -> u64 {
        self.inert_search_records
    }
    /// Dereference only against the same immutable source projection.
    pub fn item(
        &self,
        index: &HistoricalProjectionStore,
        position: usize,
    ) -> Result<HistoricalRecordData> {
        ensure!(
            index.source_fingerprint() == self.source_fingerprint,
            "history_reconstruction_source_changed"
        );
        let item = self
            .items
            .get(position)
            .context("history_reconstruction_item_not_found")?;
        selected_data(index.record(item.record)?, item)
    }

    /// Tool records are historical facts and must not be executed as requests.
    pub fn tool_record(
        &self,
        index: &HistoricalProjectionStore,
        position: usize,
    ) -> Result<HistoricalRecordData> {
        ensure!(
            index.source_fingerprint() == self.source_fingerprint,
            "history_reconstruction_source_changed"
        );
        let item = self
            .tool_records
            .get(position)
            .context("history_reconstruction_item_not_found")?;
        selected_data(index.record(item.record)?, item)
    }
}

/// Select readable user/assistant messages from a complete, single-root paginated
/// rollout. The immutable source and its diagnostics are never rewritten. This
/// deliberately does not publish a session or run historical tool calls.
pub fn reconstruct_readable_history(
    index: &HistoricalProjectionStore,
    check: impl FnMut(u64) -> bool,
) -> Result<ReconstructedCodexHistory> {
    reconstruct(index, None, check)
}

/// Reconstruct readable history while excluding verified, inert old tool declarations.
pub fn reconstruct_readable_history_with_tool_declarations(
    index: &HistoricalProjectionStore,
    archive: &ExternalHistoryReader,
    check: impl FnMut(u64) -> bool,
) -> Result<ReconstructedCodexHistory> {
    let receipt = archive
        .receipt()?
        .context("history_reconstruction_source_incomplete")?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &receipt.archive_id,
            &receipt.source_sha256,
            index.adapter_revision(),
        ))?)
    );
    ensure!(
        fingerprint == index.source_fingerprint(),
        "history_reconstruction_source_changed"
    );
    reconstruct(index, Some(archive), check)
}

fn additional_tools_ref(item: &HistoricalCompactionItem) -> Option<&HistoricalValueRef> {
    additional_tools_value(&item.metadata, &item.data)
}

fn additional_tools_value<'a>(
    metadata: &HistoricalCodexMetadata,
    data: &'a HistoricalRecordData,
) -> Option<&'a HistoricalValueRef> {
    if metadata.response_type.as_deref() != Some("additional_tools") {
        return None;
    }
    match data {
        HistoricalRecordData::Message {
            role: HistoricalRole::Unknown,
            blocks,
            ..
        } => match blocks.as_slice() {
            [HistoricalBlock::Opaque { source_type, value }]
                if source_type == "additional_tools" =>
            {
                Some(value)
            }
            _ => None,
        },
        _ => None,
    }
}

fn validate_additional_tools(
    archive: &ExternalHistoryReader,
    ordinal: u64,
    value: &HistoricalValueRef,
) -> Result<()> {
    ensure!(
        value.record == ordinal
            && value.encoding == HistoricalValueEncoding::Json
            && value.bytes > 0
            && value.bytes <= MAX_TOOL_DECLARATION_BYTES,
        "history_reconstruction_checkpoint_unsupported"
    );
    let reader = archive.open_record_range(ordinal, value.offset, value.bytes)?;
    let item: AdditionalTools = serde_json::from_reader(reader)
        .map_err(|_| anyhow::anyhow!("history_reconstruction_checkpoint_unsupported"))?;
    ensure!(
        item.kind == "additional_tools"
            && item.role == "developer"
            && item
                .id
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 256)
            && item.tools.len() <= 256,
        "history_reconstruction_checkpoint_unsupported"
    );
    Ok(())
}

fn reconstruct(
    index: &HistoricalProjectionStore,
    archive: Option<&ExternalHistoryReader>,
    mut check: impl FnMut(u64) -> bool,
) -> Result<ReconstructedCodexHistory> {
    ensure!(
        index.source_kind() == MigrationSourceKind::Codex,
        "history_reconstruction_source_mismatch"
    );
    let progress = index.progress()?;
    ensure!(
        progress.normalization_complete
            && progress.normalized_records > 0
            && progress.normalized_records == progress.source_records,
        "history_reconstruction_source_incomplete"
    );
    let first = index.record(0)?;
    let HistoricalRecordData::Session {
        history_mode,
        parent_session_id,
        inherited_before_ordinal,
        ..
    } = &first.data
    else {
        anyhow::bail!("history_reconstruction_source_incomplete");
    };
    ensure!(
        history_mode.as_deref() == Some("paginated")
            && parent_session_id.is_none()
            && inherited_before_ordinal.is_none()
            && first.codex.as_ref().is_some_and(|metadata| {
                metadata.history_base.is_none()
                    && metadata.forked_from_id.is_none()
                    && metadata
                        .root_session_id
                        .as_ref()
                        .is_none_or(|root| metadata.thread_id.as_ref() == Some(root))
            }),
        "history_reconstruction_source_incomplete"
    );
    let mut collected = collect::Collection::new(progress.normalized_records, true, false);
    let mut checkpoints = 0u64;
    let mut omitted_tool_declarations = 0u64;
    let mut verified_guardian_snapshots = 0u64;
    let mut inert_search_records = 0u64;
    for ordinal in 0..progress.normalized_records {
        ensure!(check(ordinal), "history_reconstruction_cancelled");
        let mut record = index.record(ordinal)?;
        ensure!(
            record.persisted_ordinal == Some(ordinal),
            "history_reconstruction_source_incomplete"
        );
        if let (Some(archive), Some(metadata)) = (archive, record.codex.as_ref())
            && let Some(value) = additional_tools_value(metadata, &record.data)
        {
            validate_additional_tools(archive, ordinal, value)?;
            record
                .diagnostics
                .retain(|issue| issue.code != "unsupported_response_item");
            omitted_tool_declarations += 1;
        }
        if let Some(archive) = archive
            && let Some((kind, value)) = inert::reference(&record)
        {
            inert::summary(archive, ordinal, kind, value)?;
            record
                .diagnostics
                .retain(|issue| issue.code != "unsupported_response_item");
            inert_search_records += 1;
        }
        if let HistoricalRecordData::Compaction { checkpoint } = &record.data {
            let Some(replacement) = &checkpoint.replacement else {
                anyhow::bail!("history_reconstruction_checkpoint_unsupported");
            };
            let mut opaque = 0u64;
            let mut verified_guardian = false;
            if let (Some(archive), Some(value)) = (archive, checkpoint.guardian_history.as_ref())
                && record
                    .diagnostics
                    .iter()
                    .any(|issue| issue.code == "invalid_compaction_checkpoint")
            {
                guardian::verify(index, archive, ordinal, value, &mut check)?;
                verified_guardian = true;
                verified_guardian_snapshots += 1;
            }
            for item in replacement {
                if let HistoricalRecordData::Message {
                    role: HistoricalRole::Unknown,
                    blocks,
                    ..
                } = &item.data
                {
                    if matches!(blocks.as_slice(), [
                            HistoricalBlock::Opaque { source_type: kind, .. },
                            HistoricalBlock::Opaque { source_type: encrypted, value },
                        ] if kind == "compaction" && encrypted == "encrypted_content"
                            && value.encoding == HistoricalValueEncoding::JsonString && value.bytes > 2)
                    {
                        opaque += 1;
                    } else if let (Some(archive), Some(value)) =
                        (archive, additional_tools_ref(item))
                    {
                        validate_additional_tools(archive, ordinal, value)?;
                        omitted_tool_declarations += 1;
                    } else {
                        anyhow::bail!("history_reconstruction_checkpoint_unsupported");
                    }
                }
            }
            if opaque > 0
                || (archive.is_some()
                    && replacement
                        .iter()
                        .any(|item| additional_tools_ref(item).is_some()))
            {
                // Only this recognized unsupported checkpoint item is superseded by
                // the verified original records. Other diagnostics remain blocking.
                record
                    .diagnostics
                    .retain(|issue| issue.code != "unsupported_response_item");
                checkpoints += opaque;
            }
            if verified_guardian {
                let mut removed = false;
                record.diagnostics.retain(|issue| {
                    if !removed && issue.code == "invalid_compaction_checkpoint" {
                        removed = true;
                        false
                    } else {
                        true
                    }
                });
                ensure!(removed, "history_reconstruction_source_requires_review");
            }
        }
        collected.push(record, 0, &mut check)?;
    }
    ensure!(
        checkpoints > 0
            || omitted_tool_declarations > 0
            || verified_guardian_snapshots > 0
            || inert_search_records > 0,
        "history_reconstruction_checkpoint_not_found"
    );
    ensure!(
        collected.session_seen && collected.issues.is_empty(),
        "history_reconstruction_source_requires_review"
    );
    let mut issues = BTreeSet::new();
    let items = replay::window(&collected.entries, None, &mut issues, &mut check)?;
    ensure!(
        issues.is_empty(),
        "history_reconstruction_source_requires_review"
    );
    let tool_records = items
        .iter()
        .filter(|item| {
            matches!(
                item.metadata.response_type.as_deref(),
                Some(
                    "function_call"
                        | "function_call_output"
                        | "custom_tool_call"
                        | "custom_tool_call_output"
                )
            ) || archive.is_some()
                && matches!(
                    item.metadata.response_type.as_deref(),
                    Some("web_search_call" | "tool_search_call" | "tool_search_output")
                )
        })
        .map(|item| item.location.clone())
        .collect::<Vec<_>>();
    let items = items
        .into_iter()
        .filter(|item| {
            matches!(item.role, HistoricalRole::User | HistoricalRole::Assistant)
                && item.metadata.response_type.as_deref() == Some("message")
                && (item.role != HistoricalRole::User
                    || item.metadata.contextual_message == Some(false))
        })
        .map(|item| item.location)
        .collect::<Vec<_>>();
    ensure!(
        !items.is_empty(),
        "history_reconstruction_no_readable_messages"
    );
    let source_fingerprint = index.source_fingerprint().to_owned();
    let mut hash = Sha256::new();
    serde_json::to_writer(
        HashWriter(&mut hash),
        &(
            if archive.is_some() {
                "codex-readable-reconstruction/v2"
            } else {
                "codex-readable-reconstruction/v1"
            },
            &source_fingerprint,
            checkpoints,
            &items,
            &tool_records,
        ),
    )?;
    Ok(ReconstructedCodexHistory {
        source_fingerprint,
        selection_sha256: format!("{:x}", hash.finalize()),
        items,
        tool_records,
        opaque_checkpoints: checkpoints,
        omitted_tool_declarations,
        verified_guardian_snapshots,
        inert_search_records,
    })
}
