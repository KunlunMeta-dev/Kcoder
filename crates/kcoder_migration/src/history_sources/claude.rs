//! Claude has no Codex-style physical rollout UUID; bind an authorized transcript location.
use super::*;

pub(crate) fn file_identity(relative: &Path) -> Option<String> {
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    if parts.is_empty() || parts.len() > 16 {
        return None;
    }
    let name = parts.last()?;
    if !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
        return None;
    }
    Some(format!(
        "claude-file-{:x}",
        Sha256::digest(serde_json::to_vec(&parts).ok()?)
    ))
}

pub(super) fn validate_artifact(relative: &Path, origin: &ExternalHistoryOrigin) -> Result<()> {
    if let Some(claimed) = &origin.source_artifact_id {
        ensure!(
            file_identity(relative).as_ref() == Some(claimed),
            "migration_history_source_filename_mismatch"
        );
    }
    // Omitted identities remain omitted so old explicit-selection archives retain their hashes.
    Ok(())
}
