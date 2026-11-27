use super::*;
use kcoder_types::migration::MigrationSourceKind;
use uuid::Uuid;

pub(super) fn identity(relative: &Path) -> Option<(Uuid, Uuid)> {
    let file = relative.file_name()?.to_str()?;
    let file = file
        .strip_suffix(".jsonl.zst")
        .map(|base| format!("{base}.jsonl"))
        .unwrap_or_else(|| file.to_owned());
    let core = file.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let timestamp = core.get(..19)?;
    if timestamp.get(17..19)? == "60" {
        return None;
    }
    if core.get(19..20)? != "-" {
        return None;
    }
    let date = chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").ok()?;
    if date.format("%Y-%m-%dT%H-%M-%S").to_string() != timestamp {
        return None;
    }
    let ids = core.get(20..)?;
    let (thread, rollout) = ids.split_once('_').unwrap_or((ids, ids));
    Some((
        Uuid::parse_str(thread).ok()?,
        Uuid::parse_str(rollout).ok()?,
    ))
}

pub(super) fn bind_artifact(relative: &Path, origin: &mut ExternalHistoryOrigin) -> Result<()> {
    if origin.source != MigrationSourceKind::Codex {
        return super::claude::validate_artifact(relative, origin);
    }
    let Some((thread, rollout)) = identity(relative) else {
        // Renamed exports can still be archived, but cannot claim a guessed physical
        // identity or satisfy another rollout's history_base pointer.
        ensure!(
            origin.source_artifact_id.is_none(),
            "migration_history_unverified_artifact_identity"
        );
        return Ok(());
    };
    ensure!(
        Uuid::parse_str(&origin.source_session_id).ok() == Some(thread),
        "migration_history_source_filename_mismatch"
    );
    let rollout = rollout.to_string();
    ensure!(
        origin
            .source_artifact_id
            .as_ref()
            .is_none_or(|id| id == &rollout),
        "migration_history_source_filename_mismatch"
    );
    origin.source_artifact_id = Some(rollout);
    Ok(())
}
