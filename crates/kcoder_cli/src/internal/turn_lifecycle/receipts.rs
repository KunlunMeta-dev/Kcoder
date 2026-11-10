//! Bounded reads of turn submission and terminal receipts.

use kcoder_attachment_retention::acceptance::TurnClientMessageArtifact;
use kcoder_cli_storage::private_files::hex_sha256;
use kcoder_engine::QueryEngine;
use kcoder_transcript::TurnOutcomeArtifact;
use std::io::Read;

pub fn terminal_status(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Option<String> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let directory = kcoder_config::PrivateDirectory::open_existing(path.parent()?).ok()?;
    let mut bytes = Vec::new();
    directory
        .open_regular_file(path.file_name()?)
        .ok()?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let outcome: TurnOutcomeArtifact = serde_json::from_slice(&bytes).ok()?;
    (outcome.version == 1
        && outcome.thread_id == thread_id
        && outcome.turn_id == turn_id
        && matches!(
            outcome.status.as_str(),
            "completed" | "failed" | "interrupted"
        ))
    .then_some(outcome.status)
}

pub fn submitted_turn_id(
    engine: &QueryEngine,
    thread_id: &str,
    client_message_id: &str,
) -> anyhow::Result<Option<String>> {
    use anyhow::ensure;
    let root = engine
        .session_storage_dir_for(thread_id)
        .join("turn-client-messages");
    let mut turn = None;
    for record in read_records::<TurnClientMessageArtifact>(&root)? {
        ensure!(
            record.version == 1 && record.thread_id == thread_id,
            "invalid submission receipt identity"
        );
        if record.client_message_id == client_message_id {
            ensure!(
                turn.is_none(),
                "operation identity names multiple attempts; inspect thread history"
            );
            turn = Some(record.turn_id);
        }
    }
    Ok(turn)
}

pub fn read_records<T: serde::de::DeserializeOwned>(
    directory: &std::path::Path,
) -> anyhow::Result<Vec<T>> {
    use anyhow::{Context, ensure};
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) => ensure!(
            metadata.file_type().is_dir(),
            "invalid acceptance receipt directory"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("cannot inspect acceptance receipt directory"),
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("cannot read acceptance receipts"),
    };
    let handle = kcoder_config::PrivateDirectory::open_existing(directory)?;
    let mut records = Vec::new();
    let mut total_bytes = 0usize;
    for (index, entry) in entries.enumerate() {
        ensure!(index < 10_000, "acceptance receipt lookup limit exceeded");
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let mut bytes = Vec::new();
        handle
            .open_regular_file(path.file_name().context("missing receipt filename")?)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 64 * 1024,
            "acceptance receipt exceeds size limit"
        );
        total_bytes = total_bytes.saturating_add(bytes.len());
        ensure!(
            total_bytes <= 64 * 1024 * 1024,
            "acceptance receipt collection exceeds size limit"
        );
        records.push(serde_json::from_slice(&bytes).context("cannot decode acceptance receipt")?);
    }
    Ok(records)
}
