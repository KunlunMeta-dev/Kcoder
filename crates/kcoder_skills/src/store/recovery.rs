use super::journal::{
    CommitRecord, TransactionPhase, append_commit, read_commits, read_journal, write_journal,
};
use super::replace::remove_tree;
use super::transaction::{
    SkillStore, file_hash, publish_content_move, publish_metadata_file, revision_at_relative,
};
use super::{SkillStoreCommitStatus, SkillStoreDiagnostic, SkillStoreError};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

pub(crate) fn needs_recovery(store: &SkillStore) -> Result<bool, SkillStoreError> {
    let transactions = store.layout.transactions();
    if !transactions.is_dir() {
        return Ok(false);
    }
    for entry in fs::read_dir(&transactions)
        .map_err(|error| SkillStoreError::io("checking skill transactions", error))?
    {
        let entry =
            entry.map_err(|error| SkillStoreError::io("checking skill transaction", error))?;
        if entry.path().join("journal.json").is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn inspect(store: &SkillStore) -> Result<super::SkillStoreInspection, SkillStoreError> {
    let mut report = super::SkillStoreInspection {
        root: store.layout.root.clone(),
        lock_path: store.layout.lock.clone(),
        lock_available: true,
        pending_transactions: Vec::new(),
        orphan_paths: Vec::new(),
        last_commit_generation: None,
        state_generation: None,
        diagnostics: Vec::new(),
    };
    if !store.layout.root.exists() {
        return Ok(report);
    }
    let _lock = match super::lock::StoreLock::shared_existing(&store.layout) {
        Ok(lock) => lock,
        Err(SkillStoreError::Busy { .. }) => {
            report.lock_available = false;
            return Ok(report);
        }
        Err(error) => return Err(error),
    };

    match read_commits(&store.layout, false) {
        Ok(commits) => {
            report.last_commit_generation = commits.last().map(|record| record.generation);
            diagnose_external_drift(store, &commits, &mut report.diagnostics)?;
        }
        Err(error) => report
            .diagnostics
            .push(SkillStoreDiagnostic::CommitLogCorrupt {
                reason: error.to_string(),
            }),
    }
    match super::metadata::load_state(&store.layout) {
        Ok(state) if store.layout.state().exists() => {
            report.state_generation = Some(state.generation);
        }
        Ok(_) => {}
        Err(error) => report
            .diagnostics
            .push(SkillStoreDiagnostic::CommitLogCorrupt {
                reason: error.to_string(),
            }),
    }

    let transactions = store.layout.transactions();
    if transactions.is_dir() {
        let mut entries = fs::read_dir(&transactions)
            .map_err(|error| SkillStoreError::io("inspecting transactions", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| SkillStoreError::io("inspecting transaction entry", error))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry
                .file_type()
                .map_err(|error| SkillStoreError::io("inspecting transaction type", error))?
                .is_dir()
            {
                continue;
            }
            let transaction_id = entry.file_name().to_string_lossy().into_owned();
            let journal = entry.path().join("journal.json");
            if !journal.is_file() {
                report.orphan_paths.push(
                    entry
                        .path()
                        .strip_prefix(&store.layout.root)
                        .unwrap_or(&entry.path())
                        .to_path_buf(),
                );
                report
                    .diagnostics
                    .push(SkillStoreDiagnostic::OrphanTransaction { transaction_id });
                continue;
            }
            match read_journal(&journal) {
                Ok(journal) => report
                    .pending_transactions
                    .push(super::PendingSkillTransaction {
                        transaction_id: journal.transaction_id,
                        operation_id: Some(journal.operation_id),
                        phase: format!("{:?}", journal.phase).to_ascii_lowercase(),
                    }),
                Err(error) => report
                    .diagnostics
                    .push(SkillStoreDiagnostic::CorruptTransaction {
                        transaction_id,
                        reason: error.to_string(),
                    }),
            }
        }
    }

    for entry in fs::read_dir(&store.layout.root)
        .map_err(|error| SkillStoreError::io("inspecting skill root", error))?
    {
        let entry = entry.map_err(|error| SkillStoreError::io("inspecting skill entry", error))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".installing-")
            || name.starts_with(".replacing-")
            || name.ends_with(".tmp")
            || name.contains(".tmp-")
        {
            report.orphan_paths.push(PathBuf::from(name));
        }
    }
    inspect_provenance_revisions(store, &mut report.diagnostics)?;
    let reload_pending = store.layout.root.join(super::layout::RELOAD_PENDING_FILE);
    if reload_pending.is_file()
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(
            &fs::read(&reload_pending).unwrap_or_default(),
        )
        && let Some(transaction_id) = value
            .get("transaction_id")
            .and_then(serde_json::Value::as_str)
    {
        report
            .diagnostics
            .push(SkillStoreDiagnostic::ReloadPending {
                transaction_id: transaction_id.to_string(),
            });
    }
    report.orphan_paths.sort();
    report.orphan_paths.dedup();
    Ok(report)
}

fn inspect_provenance_revisions(
    store: &SkillStore,
    diagnostics: &mut Vec<SkillStoreDiagnostic>,
) -> Result<(), SkillStoreError> {
    let path = store.layout.root.join(super::layout::PROVENANCE_FILE);
    if !path.is_file() {
        return Ok(());
    }
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| SkillStoreError::io("reading provenance for inspection", error))?,
    )
    .map_err(|error| SkillStoreError::serialization("inspecting provenance", error))?;
    let Some(skills) = value.get("skills").and_then(serde_json::Value::as_object) else {
        return Ok(());
    };
    for (name, record) in skills {
        let Some(expected) = record
            .get("revision_sha256")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let actual = revision_at_relative(&store.layout, std::path::Path::new(name), name)?;
        if actual.as_ref().map(|revision| revision.as_str()) != Some(expected) {
            diagnostics.push(SkillStoreDiagnostic::ProvenanceRevisionMismatch {
                skill: name.clone(),
            });
        }
    }
    Ok(())
}

pub(crate) fn recover_locked(
    store: &SkillStore,
) -> Result<Vec<SkillStoreDiagnostic>, SkillStoreError> {
    let mut diagnostics = Vec::new();
    let transactions = store.layout.transactions();
    let repair_truncated_tail = commit_ready_journal_exists(&transactions)?;
    let commits = read_commits(&store.layout, repair_truncated_tail)?;
    if !transactions.exists() {
        diagnose_external_drift(store, &commits, &mut diagnostics)?;
        return Ok(diagnostics);
    }
    let mut entries = fs::read_dir(&transactions)
        .map_err(|error| SkillStoreError::io("reading skill transactions", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| SkillStoreError::io("reading skill transaction entry", error))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let transaction_dir = entry.path();
        if !entry
            .file_type()
            .map_err(|error| SkillStoreError::io("reading transaction file type", error))?
            .is_dir()
        {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let journal_path = transaction_dir.join("journal.json");
        if !journal_path.exists() {
            diagnostics.push(SkillStoreDiagnostic::OrphanTransaction { transaction_id: id });
            continue;
        }
        let mut journal =
            read_journal(&journal_path).map_err(|error| SkillStoreError::RecoveryRequired {
                transaction_id: id.clone(),
                reason: error.to_string(),
            })?;
        if journal.transaction_id != id {
            return Err(SkillStoreError::RecoveryRequired {
                transaction_id: id,
                reason: "journal transaction id does not match its directory".to_string(),
            });
        }

        if commits
            .iter()
            .any(|record| record.transaction_id == journal.transaction_id)
        {
            verify_after_images(store, &journal, &mut diagnostics)?;
            if journal.phase != TransactionPhase::Cleaned {
                journal.phase = TransactionPhase::Committed;
                write_journal(&transaction_dir, &journal)?;
            }
            let _ = remove_tree(&transaction_dir);
            diagnostics.push(SkillStoreDiagnostic::Recovered {
                transaction_id: journal.transaction_id,
            });
            continue;
        }

        match journal.phase {
            TransactionPhase::Prepared => {
                verify_before_images(store, &journal)?;
                journal.transition(TransactionPhase::Prepared, TransactionPhase::Aborted)?;
                write_journal(&transaction_dir, &journal)?;
                remove_tree(&transaction_dir)?;
            }
            TransactionPhase::Publishing => {
                for index in 0..journal.moves.len() {
                    if let Err(error) =
                        publish_content_move(&store.layout, &mut journal, index, None)
                    {
                        if rollback_content(store, &journal).is_ok() {
                            journal.phase = TransactionPhase::Aborted;
                            write_journal(&transaction_dir, &journal)?;
                            remove_tree(&transaction_dir)?;
                            diagnostics.push(SkillStoreDiagnostic::Recovered {
                                transaction_id: journal.transaction_id.clone(),
                            });
                            break;
                        }
                        return Err(error);
                    }
                    write_journal(&transaction_dir, &journal)?;
                }
                if journal.phase == TransactionPhase::Aborted {
                    continue;
                }
                journal.transition(
                    TransactionPhase::Publishing,
                    TransactionPhase::ContentPublished,
                )?;
                write_journal(&transaction_dir, &journal)?;
                finish_after_content(store, &transaction_dir, &mut journal)?;
                diagnostics.push(SkillStoreDiagnostic::Recovered {
                    transaction_id: journal.transaction_id.clone(),
                });
            }
            TransactionPhase::ContentPublished => {
                finish_after_content(store, &transaction_dir, &mut journal)?;
                diagnostics.push(SkillStoreDiagnostic::Recovered {
                    transaction_id: journal.transaction_id.clone(),
                });
            }
            TransactionPhase::MetadataPublished => {
                finish_commit(store, &transaction_dir, &mut journal)?;
                diagnostics.push(SkillStoreDiagnostic::Recovered {
                    transaction_id: journal.transaction_id.clone(),
                });
            }
            TransactionPhase::Committed | TransactionPhase::Cleaned => {
                verify_after_images(store, &journal, &mut diagnostics)?;
                remove_tree(&transaction_dir)?;
            }
            TransactionPhase::Aborted => {
                remove_tree(&transaction_dir)?;
            }
        }
    }
    let commits = read_commits(&store.layout, false)?;
    diagnose_external_drift(store, &commits, &mut diagnostics)?;
    Ok(diagnostics)
}

fn rollback_content(
    store: &SkillStore,
    journal: &super::journal::TransactionJournal,
) -> Result<(), SkillStoreError> {
    for item in journal.moves.iter().rev() {
        let live = store.layout.root.join(&item.live);
        match &item.before_revision {
            Some(expected) => {
                if revision_at_relative(&store.layout, &item.live, &item.name)?.as_ref()
                    == Some(expected)
                {
                    continue;
                }
                let before = item.before_image.as_ref().ok_or_else(|| {
                    SkillStoreError::RecoveryRequired {
                        transaction_id: journal.transaction_id.clone(),
                        reason: format!(
                            "rollback has no before path for '{}'",
                            item.live.display()
                        ),
                    }
                })?;
                let before_absolute = store.layout.root.join(before);
                if revision_at_relative(&store.layout, before, &item.name)?.as_ref()
                    != Some(expected)
                {
                    return Err(SkillStoreError::RecoveryRequired {
                        transaction_id: journal.transaction_id.clone(),
                        reason: format!(
                            "rollback before-image '{}' is missing or corrupt",
                            before.display()
                        ),
                    });
                }
                if live.exists() {
                    remove_tree(&live)?;
                }
                super::replace::rename_and_sync(&before_absolute, &live)?;
            }
            None => {
                if live.exists() {
                    let current = revision_at_relative(&store.layout, &item.live, &item.name)?;
                    if current != item.after_revision {
                        return Err(SkillStoreError::RecoveryRequired {
                            transaction_id: journal.transaction_id.clone(),
                            reason: format!(
                                "rollback found unknown content at '{}'",
                                item.live.display()
                            ),
                        });
                    }
                    remove_tree(&live)?;
                }
            }
        }
    }
    Ok(())
}

fn commit_ready_journal_exists(transactions: &std::path::Path) -> Result<bool, SkillStoreError> {
    if !transactions.exists() {
        return Ok(false);
    }
    for entry in fs::read_dir(transactions)
        .map_err(|error| SkillStoreError::io("reading transaction directory", error))?
    {
        let entry =
            entry.map_err(|error| SkillStoreError::io("reading transaction entry", error))?;
        let journal = entry.path().join("journal.json");
        if !journal.is_file() {
            continue;
        }
        let Ok(journal) = read_journal(&journal) else {
            continue;
        };
        if matches!(
            journal.phase,
            TransactionPhase::MetadataPublished
                | TransactionPhase::Committed
                | TransactionPhase::Cleaned
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn diagnose_external_drift(
    store: &SkillStore,
    commits: &[CommitRecord],
    diagnostics: &mut Vec<SkillStoreDiagnostic>,
) -> Result<(), SkillStoreError> {
    let mut expected = BTreeMap::new();
    for record in commits {
        for revision in &record.after {
            expected.insert(revision.name.clone(), revision.revision.clone());
        }
    }
    for (name, expected_revision) in expected {
        let relative = std::path::Path::new(&name);
        let actual = match revision_at_relative(&store.layout, relative, &name) {
            Ok(actual) => actual,
            Err(_) => {
                diagnostics.push(SkillStoreDiagnostic::ExternalDrift {
                    skill: name.clone(),
                });
                continue;
            }
        };
        if actual == expected_revision {
            continue;
        }
        if actual.is_some() {
            let package = super::hash::load_package(&store.layout.root.join(&name), &name)?;
            if super::hash::validate_package(&package).is_err() {
                diagnostics.push(SkillStoreDiagnostic::ExternalDrift {
                    skill: name.clone(),
                });
                continue;
            }
        }
        if !diagnostics.iter().any(|diagnostic| {
            matches!(diagnostic, SkillStoreDiagnostic::ExternalDrift { skill } if skill == &name)
        }) {
            diagnostics.push(SkillStoreDiagnostic::ExternalDrift { skill: name });
        }
    }
    Ok(())
}

fn finish_after_content(
    store: &SkillStore,
    transaction_dir: &std::path::Path,
    journal: &mut super::journal::TransactionJournal,
) -> Result<(), SkillStoreError> {
    let _usage_lock = if journal
        .metadata_files
        .iter()
        .any(|item| item.live == std::path::Path::new(super::layout::USAGE_FILE))
    {
        Some(super::lock::StoreLock::usage(
            &store.layout,
            store.lock_timeout,
        )?)
    } else {
        None
    };
    for index in 0..journal.metadata_files.len() {
        if journal.metadata_files[index].live == std::path::Path::new(super::layout::USAGE_FILE) {
            merge_latest_usage_counters(store, journal, index)?;
            journal.metadata_files[index].published = false;
            write_journal(transaction_dir, journal)?;
        }
        publish_metadata_file(
            &store.layout,
            journal,
            index,
            &journal.transaction_id.clone(),
        )?;
        write_journal(transaction_dir, journal)?;
    }
    journal.transition(
        TransactionPhase::ContentPublished,
        TransactionPhase::MetadataPublished,
    )?;
    write_journal(transaction_dir, journal)?;
    finish_commit(store, transaction_dir, journal)
}

fn merge_latest_usage_counters(
    store: &SkillStore,
    journal: &mut super::journal::TransactionJournal,
    index: usize,
) -> Result<(), SkillStoreError> {
    let item = journal.metadata_files.get(index).cloned().ok_or_else(|| {
        SkillStoreError::JournalCorrupt(format!("missing usage metadata index {index}"))
    })?;
    let staged_path = store.layout.root.join(&item.staged);
    let live_path = store.layout.root.join(&item.live);
    if !live_path.is_file() {
        return Ok(());
    }
    let mut staged: serde_json::Value = serde_json::from_slice(
        &fs::read(&staged_path)
            .map_err(|error| SkillStoreError::io("reading staged usage metadata", error))?,
    )
    .map_err(|error| SkillStoreError::serialization("parsing staged usage metadata", error))?;
    let live: serde_json::Value = serde_json::from_slice(
        &fs::read(&live_path)
            .map_err(|error| SkillStoreError::io("reading current usage metadata", error))?,
    )
    .map_err(|error| SkillStoreError::serialization("parsing current usage metadata", error))?;
    let staged_skills = staged
        .get_mut("skills")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| SkillStoreError::JournalCorrupt("staged usage has no skills".to_string()))?;
    let live_skills = live
        .get("skills")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            SkillStoreError::JournalCorrupt("current usage has no skills".to_string())
        })?;
    for (name, live_record) in live_skills {
        let staged_record = staged_skills
            .entry(name.clone())
            .or_insert_with(|| live_record.clone());
        let Some(staged_record) = staged_record.as_object_mut() else {
            continue;
        };
        let Some(live_record) = live_record.as_object() else {
            continue;
        };
        for field in ["view_count", "use_count"] {
            let current = live_record.get(field).and_then(serde_json::Value::as_u64);
            let staged = staged_record.get(field).and_then(serde_json::Value::as_u64);
            if current > staged {
                staged_record.insert(field.to_string(), serde_json::Value::from(current.unwrap()));
            }
        }
        for field in ["last_viewed_at", "last_used_at"] {
            let current = live_record.get(field).and_then(serde_json::Value::as_str);
            let staged = staged_record.get(field).and_then(serde_json::Value::as_str);
            if current > staged {
                staged_record.insert(
                    field.to_string(),
                    serde_json::Value::String(current.unwrap().to_string()),
                );
            }
        }
    }
    let bytes = serde_json::to_vec_pretty(&staged).map_err(|error| {
        SkillStoreError::serialization("serializing merged usage metadata", error)
    })?;
    super::replace::atomic_write(&staged_path, &bytes, &journal.transaction_id)?;
    journal.metadata_files[index].after_sha256 = super::journal::sha256(&bytes);
    Ok(())
}

fn finish_commit(
    store: &SkillStore,
    transaction_dir: &std::path::Path,
    journal: &mut super::journal::TransactionJournal,
) -> Result<(), SkillStoreError> {
    verify_after_images(store, journal, &mut Vec::new())?;
    let record = CommitRecord::from_journal(journal, SkillStoreCommitStatus::Committed);
    append_commit(&store.layout, &record)?;
    journal.transition(
        TransactionPhase::MetadataPublished,
        TransactionPhase::Committed,
    )?;
    write_journal(transaction_dir, journal)?;
    remove_tree(transaction_dir)
}

fn verify_before_images(
    store: &SkillStore,
    journal: &super::journal::TransactionJournal,
) -> Result<(), SkillStoreError> {
    for item in &journal.moves {
        let current = revision_at_relative(&store.layout, &item.live, &item.name)?;
        if current != item.before_revision {
            return Err(SkillStoreError::RecoveryRequired {
                transaction_id: journal.transaction_id.clone(),
                reason: format!(
                    "prepared transaction observed drift at '{}'",
                    item.live.display()
                ),
            });
        }
    }
    Ok(())
}

fn verify_after_images(
    store: &SkillStore,
    journal: &super::journal::TransactionJournal,
    diagnostics: &mut Vec<SkillStoreDiagnostic>,
) -> Result<(), SkillStoreError> {
    for item in &journal.moves {
        let current = revision_at_relative(&store.layout, &item.live, &item.name)?;
        if current != item.after_revision {
            if item.live.components().count() == 1 {
                diagnostics.push(SkillStoreDiagnostic::ExternalDrift {
                    skill: item.name.clone(),
                });
                continue;
            }
            return Err(SkillStoreError::RecoveryRequired {
                transaction_id: journal.transaction_id.clone(),
                reason: format!("committed archive path '{}' drifted", item.live.display()),
            });
        }
    }
    for item in &journal.metadata_files {
        if item.live == std::path::Path::new(super::layout::USAGE_FILE) {
            let bytes = fs::read(store.layout.root.join(&item.live))
                .map_err(|error| SkillStoreError::io("reading committed usage metadata", error))?;
            let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
                SkillStoreError::serialization("parsing committed usage metadata", error)
            })?;
            if !value
                .get("skills")
                .is_some_and(serde_json::Value::is_object)
            {
                return Err(SkillStoreError::RecoveryRequired {
                    transaction_id: journal.transaction_id.clone(),
                    reason: "committed usage metadata has no skills object".to_string(),
                });
            }
            continue;
        }
        if file_hash(&store.layout.root.join(&item.live))?.as_deref() != Some(&item.after_sha256) {
            return Err(SkillStoreError::RecoveryRequired {
                transaction_id: journal.transaction_id.clone(),
                reason: format!("committed metadata '{}' drifted", item.live.display()),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn inspection_of_missing_store_is_read_only() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("missing/skills");
        let store = SkillStore::open(&root).unwrap();
        let report = store.inspect().unwrap();
        assert!(report.lock_available);
        assert!(report.pending_transactions.is_empty());
        assert!(!root.exists());
        assert!(!report.lock_path.exists());
    }

    #[test]
    fn inspection_reports_busy_lock_without_waiting() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        super::super::replace::create_private_dir(&root).unwrap();
        let store = SkillStore::open(&root).unwrap();
        let _held = super::super::lock::StoreLock::exclusive(
            &store.layout,
            super::super::lock::DEFAULT_LOCK_TIMEOUT,
        )
        .unwrap();
        let report = store.inspect().unwrap();
        assert!(!report.lock_available);
    }

    #[test]
    fn inspection_reports_and_clears_reload_pending_marker() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        super::super::replace::create_private_dir(&root).unwrap();
        let transaction_id = format!("skill-txn-{}", uuid::Uuid::new_v4());
        store.record_reload_status(&transaction_id, false).unwrap();
        assert!(
            store
                .inspect()
                .unwrap()
                .diagnostics
                .iter()
                .any(|diagnostic| {
                    matches!(
                        diagnostic,
                        SkillStoreDiagnostic::ReloadPending { transaction_id: found }
                            if found == &transaction_id
                    )
                })
        );
        store.record_reload_status(&transaction_id, true).unwrap();
        assert!(
            !store
                .inspect()
                .unwrap()
                .diagnostics
                .iter()
                .any(|diagnostic| matches!(diagnostic, SkillStoreDiagnostic::ReloadPending { .. }))
        );
    }
}
