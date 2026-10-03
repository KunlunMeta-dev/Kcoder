//! Accepted turn identities are distinct from the count of prompts admitted by Hooks.
use super::{QueryEngine, TurnOutcomeArtifact, hex_sha256, transcript_artifact_journal};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read};

#[derive(Serialize, Deserialize)]
struct Sequence {
    version: u8,
    thread_id: String,
    high_water: usize,
}
#[derive(Serialize, Deserialize)]
pub(super) struct Binding {
    pub version: u8,
    pub thread_id: String,
    pub turn_id: String,
    pub user_message_uuid: String,
}

pub(super) fn latest(engine: &QueryEngine, thread_id: &str, legacy_floor: usize) -> Result<usize> {
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("turn-admissions");
    match std::fs::symlink_metadata(root.join("sequence")) {
        Ok(_) => {
            let handle = kcoder_config::PrivateDirectory::open_existing(&root)?;
            let mut bytes = Vec::new();
            handle
                .open_regular_file(std::ffi::OsStr::new("sequence"))?
                .take(4097)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 4096, "turn admission sequence exceeds limit");
            let sequence: Sequence = serde_json::from_slice(&bytes)?;
            ensure!(
                sequence.version == 1 && sequence.thread_id == thread_id,
                "invalid turn admission sequence"
            );
            Ok(sequence.high_water.max(legacy_floor))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Migrate old failed Hook turns too: they never contributed a model user message.
            let records = super::turn_receipts::read_records::<TurnOutcomeArtifact>(
                &engine
                    .session_storage_dir_for(thread_id)
                    .join("turn-outcomes"),
            )?;
            let mut high = legacy_floor;
            for record in records {
                ensure!(
                    record.version == 1 && record.thread_id == thread_id,
                    "invalid prior turn outcome"
                );
                if let Some(number) = record
                    .turn_id
                    .strip_prefix("turn-")
                    .and_then(|value| value.parse::<usize>().ok())
                {
                    high = high.max(number);
                }
            }
            Ok(high)
        }
        Err(error) => Err(error).context("cannot read turn admission sequence"),
    }
}

pub(super) fn accept(engine: &QueryEngine, thread_id: &str, number: usize) -> Result<()> {
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("turn-admissions");
    let sequence = Sequence {
        version: 1,
        thread_id: thread_id.into(),
        high_water: number,
    };
    transcript_artifact_journal::write(
        &root,
        thread_id,
        transcript_artifact_journal::Kind::TurnAdmissions,
        || {
            super::write_private_artifact_file(
                &root.join("sequence"),
                &serde_json::to_vec(&sequence)?,
            )
        },
    )
}

pub(super) fn bind_user(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Result<()> {
    let user_message_uuid = engine
        .state
        .latest_message_history_id_matching(kcoder_engine::agent::is_real_user_message)
        .context("accepted input has no history identity")?;
    let binding = Binding {
        version: 1,
        thread_id: thread_id.into(),
        turn_id: turn_id.into(),
        user_message_uuid,
    };
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("turn-admissions");
    transcript_artifact_journal::write(
        &root,
        thread_id,
        transcript_artifact_journal::Kind::TurnAdmissions,
        || {
            super::write_private_artifact_file(
                &root.join(format!("{}.json", hex_sha256(turn_id.as_bytes()))),
                &serde_json::to_vec(&binding)?,
            )
        },
    )
}

pub(super) fn bindings(engine: &QueryEngine, thread_id: &str) -> Result<HashMap<String, String>> {
    let records = super::turn_receipts::read_records::<Binding>(
        &engine
            .session_storage_dir_for(thread_id)
            .join("turn-admissions"),
    )?;
    let mut result = HashMap::new();
    for record in records {
        ensure!(
            record.version == 1
                && record.thread_id == thread_id
                && !record.user_message_uuid.is_empty(),
            "invalid turn admission binding"
        );
        ensure!(
            result
                .insert(record.user_message_uuid, record.turn_id)
                .is_none(),
            "duplicate turn admission binding"
        );
    }
    Ok(result)
}

/// Resolve durable admission IDs before truncating at the next real-user boundary.
/// Only an unbound legacy prefix may use positional IDs. A removed modern UUID
/// must never fall back to a new prompt now occupying its old position.
pub(super) fn fork_transcript(
    entries: &[kcoder_state::HistoryEntry],
    admitted: &HashMap<String, String>,
    turn_id: &str,
) -> Result<Vec<kcoder_types::Message>> {
    let requested = turn_id
        .strip_prefix("turn-")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .with_context(|| format!("invalid app-server turn id: {turn_id}"))?;
    let mut identities = std::collections::HashSet::new();
    for id in admitted.values() {
        ensure!(identities.insert(id), "ambiguous turn admission identity");
    }
    let real_users = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| kcoder_engine::agent::is_real_user_message(&entry.message))
        .collect::<Vec<_>>();
    let target = if let Some((uuid, _)) = admitted.iter().find(|(_, id)| id.as_str() == turn_id) {
        let matches = real_users
            .iter()
            .filter(|(_, entry)| entry.uuid.as_deref() == Some(uuid.as_str()))
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "fork turn was not found or is ambiguous: {turn_id}"
        );
        matches[0]
    } else {
        let (index, _) = real_users
            .get(requested - 1)
            .with_context(|| format!("fork turn was not found: {turn_id}"))?;
        ensure!(
            real_users.iter().take(requested).all(|(_, entry)| entry
                .uuid
                .as_ref()
                .is_none_or(|uuid| !admitted.contains_key(uuid))),
            "fork turn has no legacy identity: {turn_id}"
        );
        *index
    };
    let end = real_users
        .iter()
        .find(|(index, _)| *index > target)
        .map(|(index, _)| *index)
        .unwrap_or(entries.len());
    Ok(entries[..end]
        .iter()
        .map(|entry| entry.message.clone())
        .collect())
}

#[cfg(test)]
mod fork_tests {
    use super::*;
    fn entry(uuid: &str, message: kcoder_types::Message) -> kcoder_state::HistoryEntry {
        kcoder_state::HistoryEntry {
            session_id: "fixture".into(),
            timestamp_ms: 0,
            uuid: Some(uuid.into()),
            parent_uuid: None,
            message,
        }
    }
    fn transcript() -> Vec<kcoder_state::HistoryEntry> {
        use kcoder_types::Message;
        vec![
            entry(
                "prefix",
                Message::runtime_text(
                    "[system] Continue working toward the active `/goal` objective.",
                ),
            ),
            entry("old", Message::user_text("legacy")),
            entry("answer", Message::assistant_text("answer")),
            entry("new", Message::user_text("replacement")),
            entry(
                "followup",
                Message::runtime_text(
                    "[system] Continue working toward the active `/goal` objective.",
                ),
            ),
            entry("final", Message::assistant_text("done")),
            entry("later", Message::user_text("later")),
        ]
    }
    #[test]
    fn legacy_and_mixed_prefix_keep_system_and_synthetic_context() {
        let entries = transcript();
        assert_eq!(
            fork_transcript(&entries, &HashMap::new(), "turn-1")
                .unwrap()
                .len(),
            3
        );
        let bindings = HashMap::from([
            ("new".into(), "turn-5".into()),
            ("later".into(), "turn-9".into()),
        ]);
        assert_eq!(
            fork_transcript(&entries, &bindings, "turn-1")
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            fork_transcript(&entries, &bindings, "turn-5")
                .unwrap()
                .len(),
            6
        );
        assert!(fork_transcript(&entries, &bindings, "turn-2").is_err());
        assert!(fork_transcript(&entries, &bindings, "turn-3").is_err());
        assert_eq!(
            fork_transcript(&entries, &bindings, "turn-9")
                .unwrap()
                .len(),
            7
        );
    }
    #[test]
    fn removed_admission_never_rebinds_to_replacement_position() {
        let entries = vec![entry(
            "new",
            kcoder_types::Message::user_text("replacement"),
        )];
        let bindings = HashMap::from([
            ("removed".into(), "turn-1".into()),
            ("new".into(), "turn-2".into()),
        ]);
        assert!(fork_transcript(&entries, &bindings, "turn-1").is_err());
        assert_eq!(
            fork_transcript(&entries, &bindings, "turn-2")
                .unwrap()
                .len(),
            1
        );
        for invalid in ["turn-0", "turn-x", "bad", "turn-99"] {
            assert!(fork_transcript(&entries, &bindings, invalid).is_err());
        }
    }
    #[test]
    fn duplicate_admission_or_history_identity_is_rejected() {
        let entries = transcript();
        let bindings = HashMap::from([
            ("old".into(), "turn-1".into()),
            ("new".into(), "turn-1".into()),
        ]);
        assert!(fork_transcript(&entries, &bindings, "turn-1").is_err());
        let bindings = HashMap::from([("old".into(), "turn-1".into())]);
        let entries = vec![entries[1].clone(), entries[1].clone()];
        assert!(fork_transcript(&entries, &bindings, "turn-1").is_err());
    }
}
