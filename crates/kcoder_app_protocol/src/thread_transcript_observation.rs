//! Request-local transcript read identity, separate from a committed snapshot or event watermark.
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_THREAD_TRANSCRIPT_OBSERVATION_V1: &str = "threadTranscriptObservationV1";
pub const TRANSCRIPT_CURSOR_STALE_CODE: i32 = -32041;

/// A complete, bounded read observation. Equality binds pages only within the same authorized
/// workspace/thread and projection version. It grants no deletion, execution or cache authority.
/// Missing proof is omitted rather than filled from a partial page or an unverified old index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadTranscriptObservationV1 {
    /// Binds the exact source stream, complete metadata inventory and full projected transcript.
    #[serde(deserialize_with = "digest")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 64, max = 64), regex(pattern = "^[0-9a-f]{64}$"))
    )]
    pub observation_id: String,
    /// Final Thread/runtime display facts, independent of the selected page's message slice.
    #[serde(deserialize_with = "digest")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 64, max = 64), regex(pattern = "^[0-9a-f]{64}$"))
    )]
    pub view_key: String,
}

fn digest<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "expected a lowercase SHA-256 identity",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transcript_observation_is_distinct_and_strictly_bounded() {
        let valid = json!({"observationId":"a".repeat(64),"viewKey":"b".repeat(64)});
        let parsed: ThreadTranscriptObservationV1 = serde_json::from_value(valid.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), valid);
        for invalid in [
            json!({"observationId":"a".repeat(63),"viewKey":"b".repeat(64)}),
            json!({"observationId":"a".repeat(64),"viewKey":"B".repeat(64)}),
            json!({"observationId":"a".repeat(64)}),
            json!({"status":"available","observationId":"a".repeat(64),"viewKey":"b".repeat(64)}),
            json!({"snapshotId":"a".repeat(64),"viewKey":"b".repeat(64)}),
        ] {
            assert!(serde_json::from_value::<ThreadTranscriptObservationV1>(invalid).is_err());
        }
    }

    #[test]
    fn transcript_observation_roundtrips_independently_through_inline_resume() {
        let mut legacy = json!({
            "thread":{"id":"observed-thread","cwd":"/tmp","status":"idle","createdAt":"1","updatedAt":"1"},
            "messages":[],"rangeStart":0,"rangeEnd":0,"hasMoreBefore":false
        });
        legacy["thread"]["metadata"] =
            serde_json::to_value(crate::ThreadMetadata::default()).unwrap();
        let old: crate::ThreadReadResult = serde_json::from_value(legacy.clone()).unwrap();
        assert!(old.transcript_observation_v1.is_none());
        assert_eq!(serde_json::to_value(old).unwrap(), legacy);
        let observation = json!({"observationId":"a".repeat(64),"viewKey":"b".repeat(64)});
        legacy["transcriptObservationV1"] = observation.clone();
        legacy["transcriptSnapshotV1"] = json!({"status":"unavailable","code":"legacyReader"});
        let read: crate::ThreadReadResult = serde_json::from_value(legacy).unwrap();
        let resumed = serde_json::to_value(crate::ThreadResumeResult::from(read)).unwrap();
        assert_eq!(
            resumed["history"]["page"]["transcriptObservationV1"],
            observation
        );
        assert_eq!(
            resumed["history"]["page"]["transcriptSnapshotV1"]["status"],
            "unavailable"
        );
    }
}
