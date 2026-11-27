//! A small, verified subset of non-executable Claude history metadata.
use super::*;

const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 64 * 1024;

pub(super) enum ClaudeMetadata {
    Empty,
    AwaySummary(String),
}

pub(super) fn read(
    archive: &ExternalHistoryReader,
    record: &HistoricalRecord,
) -> Result<Option<ClaudeMetadata>> {
    if record.source != MigrationSourceKind::ClaudeCode {
        return Ok(None);
    }
    let HistoricalRecordData::Metadata {
        source_type,
        payload,
    } = &record.data
    else {
        return Ok(None);
    };
    if !matches!(source_type.as_str(), "system" | "attachment")
        || payload.record != record.record
        || payload.encoding != HistoricalValueEncoding::Json
        || !(1..=MAX_METADATA_BYTES).contains(&payload.bytes)
    {
        return Ok(None);
    }
    let value: serde_json::Value = match serde_json::from_reader(archive.open_record_range(
        record.record,
        payload.offset,
        payload.bytes,
    )?) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let Some(root) = value.as_object() else {
        return Ok(None);
    };
    let common = [
        "type",
        "uuid",
        "parentUuid",
        "sessionId",
        "timestamp",
        "version",
        "isMeta",
        "isSidechain",
        "cwd",
        "entrypoint",
        "gitBranch",
        "userType",
    ];
    let extra = match source_type.as_str() {
        "system" => &["subtype", "durationMs", "messageCount", "content"][..],
        "attachment" => &["attachment"][..],
        _ => return Ok(None),
    };
    if root
        .keys()
        .any(|key| !common.contains(&key.as_str()) && !extra.contains(&key.as_str()))
        || root.get("type").and_then(|value| value.as_str()) != Some(source_type)
    {
        return Ok(None);
    }
    if source_type == "system" {
        match root.get("subtype").and_then(|value| value.as_str()) {
            Some("turn_duration")
                if root
                    .get("durationMs")
                    .and_then(|value| value.as_u64())
                    .is_some()
                    && root
                        .get("messageCount")
                        .and_then(|value| value.as_u64())
                        .is_some()
                    && !root.contains_key("content") =>
            {
                return Ok(Some(ClaudeMetadata::Empty));
            }
            Some("away_summary")
                if !root.contains_key("durationMs") && !root.contains_key("messageCount") =>
            {
                if let Some(text) = root.get("content").and_then(|value| value.as_str())
                    && !text.is_empty()
                    && text.len() <= MAX_SUMMARY_BYTES
                {
                    return Ok(Some(ClaudeMetadata::AwaySummary(text.to_owned())));
                }
            }
            _ => {}
        }
    } else if let Some(attachment) = root.get("attachment").and_then(|value| value.as_object())
        && attachment
            .keys()
            .all(|key| ["type", "content", "itemCount"].contains(&key.as_str()))
        && attachment.get("type").and_then(|value| value.as_str()) == Some("task_reminder")
        && attachment.get("itemCount").and_then(|value| value.as_u64()) == Some(0)
        && attachment
            .get("content")
            .and_then(|value| value.as_array())
            .is_some_and(|items| items.is_empty())
    {
        return Ok(Some(ClaudeMetadata::Empty));
    }
    Ok(None)
}
