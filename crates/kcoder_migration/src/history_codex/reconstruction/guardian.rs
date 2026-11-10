//! Verify an auxiliary history snapshot against earlier immutable source records.
use super::*;

const MAX_SNAPSHOT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SOURCE_RECORD_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SOURCE_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SOURCE_SCAN_RECORDS: u64 = 20_000;
const MAX_SNAPSHOT_ITEMS: usize = 512;

fn canonical(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(canonical).collect())
        }
        serde_json::Value::Object(items) => {
            let sorted: std::collections::BTreeMap<_, _> = items
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        value => value,
    }
}

fn fingerprint(value: &serde_json::Value) -> Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(&canonical(value.clone()))?).into())
}

// A readable message may differ only in its source ID or internal turn
// metadata. Its role, content and all other fields must remain identical.
fn message_fingerprint(value: &serde_json::Value) -> Result<Option<[u8; 32]>> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object.get("type").and_then(|value| value.as_str()) != Some("message")
        || !matches!(
            object.get("role").and_then(|value| value.as_str()),
            Some("user" | "assistant")
        )
        || !object.get("content").is_some_and(|value| value.is_array())
    {
        return Ok(None);
    }
    let mut object = object.clone();
    object.remove("id");
    object.remove("internal_chat_message_metadata_passthrough");
    fingerprint(&serde_json::Value::Object(object)).map(Some)
}

// Reasoning is never projected into continuation context. An opaque guardian
// item may be disregarded only after validating its bounded, known shape.
fn discarded_reasoning(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let allowed = [
        "type",
        "id",
        "summary",
        "content",
        "encrypted_content",
        "internal_chat_message_metadata_passthrough",
    ];
    object.keys().all(|key| allowed.contains(&key.as_str()))
        && object.get("type").and_then(|value| value.as_str()) == Some("reasoning")
        && object
            .get("id")
            .is_none_or(|value| value.is_null() || value.as_str().is_some_and(|id| id.len() <= 256))
        && object.get("content").is_none_or(serde_json::Value::is_null)
        && object
            .get("internal_chat_message_metadata_passthrough")
            .is_none_or(|value| value.is_null() || value.is_object())
        && object
            .get("encrypted_content")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty() && value.len() <= 1024 * 1024)
        && object
            .get("summary")
            .and_then(|value| value.as_array())
            .is_some_and(|items| {
                items.len() <= 128
                    && items.iter().all(|item| {
                        item.as_object().is_some_and(|part| {
                            part.len() == 2
                                && part.get("type").and_then(|value| value.as_str())
                                    == Some("summary_text")
                                && part
                                    .get("text")
                                    .and_then(|value| value.as_str())
                                    .is_some_and(|text| text.len() <= 64 * 1024)
                        })
                    })
            })
}

pub(super) fn verify(
    index: &HistoricalProjectionStore,
    archive: &ExternalHistoryReader,
    ordinal: u64,
    value: &HistoricalValueRef,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    ensure!(
        value.record == ordinal
            && value.encoding == HistoricalValueEncoding::Json
            && (1..=MAX_SNAPSHOT_BYTES).contains(&value.bytes)
            && ordinal <= MAX_SOURCE_SCAN_RECORDS,
        "history_reconstruction_source_requires_review"
    );
    let snapshot: Vec<serde_json::Value> =
        serde_json::from_reader(archive.open_record_range(ordinal, value.offset, value.bytes)?)
            .map_err(|_| anyhow::anyhow!("history_reconstruction_source_requires_review"))?;
    ensure!(
        !snapshot.is_empty()
            && snapshot.len() <= MAX_SNAPSHOT_ITEMS
            && snapshot.iter().all(|item| item.is_object()),
        "history_reconstruction_source_requires_review"
    );

    let mut originals = Vec::<([u8; 32], Option<[u8; 32]>)>::new();
    let mut scanned_bytes = 0u64;
    for prior in 0..ordinal {
        ensure!(check(prior), "history_reconstruction_cancelled");
        let record = index.record(prior)?;
        ensure!(
            record.persisted_ordinal == Some(prior),
            "history_reconstruction_source_incomplete"
        );
        ensure!(
            !matches!(&record.data, HistoricalRecordData::Boundary { source_type, .. } if source_type == "rollback"),
            "history_reconstruction_source_requires_review"
        );
        if record
            .codex
            .as_ref()
            .is_none_or(|metadata| metadata.source_type != "response_item")
        {
            continue;
        }
        let page = archive.records(prior, 1)?;
        let source = page
            .records
            .first()
            .context("history_reconstruction_source_incomplete")?;
        if source.bytes > MAX_SOURCE_RECORD_BYTES {
            continue;
        }
        scanned_bytes = scanned_bytes
            .checked_add(source.bytes)
            .context("history_reconstruction_source_requires_review")?;
        ensure!(
            scanned_bytes <= MAX_SOURCE_SCAN_BYTES,
            "history_reconstruction_source_requires_review"
        );
        let raw: serde_json::Value = serde_json::from_reader(archive.open_record(prior)?)
            .map_err(|_| anyhow::anyhow!("history_reconstruction_source_requires_review"))?;
        ensure!(
            raw.get("type").and_then(|value| value.as_str()) == Some("response_item"),
            "history_reconstruction_source_changed"
        );
        let payload = raw
            .get("payload")
            .filter(|value| value.is_object())
            .context("history_reconstruction_source_requires_review")?;
        originals.push((fingerprint(payload)?, message_fingerprint(payload)?));
    }

    let mut next_original = 0;
    for item in &snapshot {
        ensure!(check(ordinal), "history_reconstruction_cancelled");
        if discarded_reasoning(item) {
            continue;
        }
        let exact = fingerprint(item)?;
        let message = message_fingerprint(item)?;
        let mut matched = false;
        while let Some((original_exact, original_message)) = originals.get(next_original) {
            next_original += 1;
            if *original_exact == exact || message.is_some() && message == *original_message {
                matched = true;
                break;
            }
        }
        ensure!(matched, "history_reconstruction_source_requires_review");
    }
    Ok(())
}
