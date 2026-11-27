//! One operation's frozen entry metadata and its final, same-order statuses.
//! V1 remains readable as written; no historical receipt is migrated on read.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactBinding {
    version: u8,
    preview: CompactPreview,
    result_statuses: Option<Vec<Status>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactPreview {
    operation_id: String,
    selection: StorageLocationRecord,
    confirmation: String,
    pending: bool,
    sources: Vec<CompactSource>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactSource {
    domain: String,
    source_root: PathBuf,
    entries: Vec<CompactEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactEntry {
    relative_path: PathBuf,
    status: Status,
    size_bytes: Option<u64>,
    observed_version: Option<String>,
}

pub(super) fn encode(binding: &CleanupBinding) -> Result<serde_json::Value> {
    if binding.version == 1 {
        return Ok(serde_json::to_value(binding)?);
    }
    ensure!(binding.version == 2, "STORAGE_SOURCE_CLEANUP_UNKNOWN");
    let preview = &binding.preview;
    let mut sources: Vec<CompactSource> = Vec::new();
    for entry in &preview.entries {
        if sources.last().is_none_or(|source| {
            source.domain != entry.domain || source.source_root != entry.source_root
        }) {
            sources.push(CompactSource {
                domain: entry.domain.clone(),
                source_root: entry.source_root.clone(),
                entries: Vec::new(),
            });
        }
        sources.last_mut().unwrap().entries.push(CompactEntry {
            relative_path: entry.relative_path.clone(),
            status: entry.status,
            size_bytes: entry.size_bytes,
            observed_version: entry.observed_version.clone(),
        });
    }
    Ok(serde_json::to_value(CompactBinding {
        version: 2,
        preview: CompactPreview {
            operation_id: preview.operation_id.clone(),
            selection: preview.selection.clone(),
            confirmation: preview.confirmation.clone(),
            pending: preview.pending,
            sources,
        },
        result_statuses: binding
            .result
            .as_ref()
            .map(|result| result.entries.iter().map(|entry| entry.status).collect()),
    })?)
}

pub(super) fn decode(value: &serde_json::Value) -> Result<CleanupBinding> {
    if value.get("version").and_then(serde_json::Value::as_u64) == Some(1) {
        return Ok(serde_json::from_value(value.clone())?);
    }
    let compact: CompactBinding = serde_json::from_value(value.clone())?;
    ensure!(compact.version == 2, "STORAGE_SOURCE_CLEANUP_UNKNOWN");
    let mut entries = Vec::new();
    for source in compact.preview.sources {
        ensure!(
            !source.entries.is_empty()
                && source.entries.len() <= ENTRY_LIMIT.saturating_sub(entries.len()),
            "STORAGE_SOURCE_CLEANUP_UNKNOWN"
        );
        entries.extend(
            source
                .entries
                .into_iter()
                .map(|entry| StorageSourceCleanupEntry {
                    domain: source.domain.clone(),
                    source_root: source.source_root.clone(),
                    relative_path: entry.relative_path,
                    status: entry.status,
                    size_bytes: entry.size_bytes,
                    observed_version: entry.observed_version,
                }),
        );
    }
    let preview = StorageSourceCleanupPreview {
        operation_id: compact.preview.operation_id,
        selection: compact.preview.selection,
        confirmation: compact.preview.confirmation,
        pending: compact.preview.pending,
        entries,
    };
    let result = compact
        .result_statuses
        .map(|statuses| -> Result<_> {
            ensure!(
                statuses.len() == preview.entries.len(),
                "STORAGE_SOURCE_CLEANUP_UNKNOWN"
            );
            let mut entries = preview.entries.clone();
            for (entry, status) in entries.iter_mut().zip(statuses) {
                entry.status = status;
            }
            Ok(StorageSourceCleanupResult {
                operation_id: preview.operation_id.clone(),
                confirmation: preview.confirmation.clone(),
                entries,
            })
        })
        .transpose()?;
    Ok(CleanupBinding {
        version: 2,
        preview,
        result,
    })
}
