//! Accepted turn identities are distinct from the count of prompts admitted by Hooks.
use crate::receipts::read_records;
use anyhow::{Context, Result, ensure};
use kcoder_cli_storage::{
    private_files::{hex_sha256, write_private_artifact_file},
    transcript_artifact_journal,
};
use kcoder_engine::QueryEngine;
use kcoder_transcript::{TranscriptToolContexts, TurnOutcomeArtifact};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read};

#[derive(Serialize, Deserialize)]
struct Sequence {
    version: u8,
    thread_id: String,
    high_water: usize,
}
use kcoder_transcript_observation::Binding;

/// Project the committed user input through the same visible-history boundary.
/// This is an observation of the original turn, never another input admission.
pub fn user_item(
    engine: &QueryEngine,
    turn_id: &str,
    client_message_id: Option<&str>,
) -> Option<kcoder_app_protocol::Item> {
    let id = engine
        .state
        .latest_message_history_id_matching(kcoder_engine::agent::is_real_user_message)?;
    let message = engine.state.find_latest_message_map(|message| {
        kcoder_engine::agent::is_real_user_message(message).then(|| message.clone())
    })?;
    let entry = kcoder_state::HistoryEntry {
        session_id: engine.session_id(),
        timestamp_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        uuid: Some(id.clone()),
        parent_uuid: None,
        history_attempt: None,
        web_sources: Vec::new(),
        message,
    };
    let mut visible = kcoder_transcript::history_entry_thread_message(
        0,
        entry,
        Some(turn_id.into()),
        &TranscriptToolContexts::new(),
    )?;
    visible.client_message_id = client_message_id.map(str::to_owned);
    Some(kcoder_app_protocol::Item {
        id,
        kind: kcoder_app_protocol::ItemKind::UserMessage,
        content: serde_json::to_value(visible).ok()?,
    })
}

pub fn latest(engine: &QueryEngine, thread_id: &str, legacy_floor: usize) -> Result<usize> {
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
            let records = read_records::<TurnOutcomeArtifact>(
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

pub fn accept(engine: &QueryEngine, thread_id: &str, number: usize) -> Result<()> {
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
        || write_private_artifact_file(&root.join("sequence"), &serde_json::to_vec(&sequence)?),
    )
}

pub fn bind_user(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Result<()> {
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
            write_private_artifact_file(
                &root.join(format!("{}.json", hex_sha256(turn_id.as_bytes()))),
                &serde_json::to_vec(&binding)?,
            )
        },
    )
}

pub fn bindings(engine: &QueryEngine, thread_id: &str) -> Result<HashMap<String, String>> {
    let records = read_records::<Binding>(
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

pub fn committed_user_uuid(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Result<String> {
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("turn-admissions");
    let directory = kcoder_config::PrivateDirectory::open_existing(&root)?;
    let name = format!("{}.json", hex_sha256(turn_id.as_bytes()));
    let mut bytes = Vec::new();
    directory
        .open_single_link_regular_file(std::ffi::OsStr::new(&name))?
        .take(8193)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 8192, "turn admission binding exceeds limit");
    let record: Binding = serde_json::from_slice(&bytes)?;
    ensure!(
        record.version == 1
            && record.thread_id == thread_id
            && record.turn_id == turn_id
            && !record.user_message_uuid.is_empty(),
        "invalid turn admission binding"
    );
    Ok(record.user_message_uuid)
}

/// Resolve durable admission IDs before truncating at the next real-user boundary.
/// Only an unbound legacy prefix may use positional IDs. A removed modern UUID
/// must never fall back to a new prompt now occupying its old position.
pub fn fork_transcript(
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
            web_sources: Vec::new(),
            history_attempt: None,
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
