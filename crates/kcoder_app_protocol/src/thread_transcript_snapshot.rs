//! Identity of a proven committed transcript projection, not an event replay cursor.
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_THREAD_TRANSCRIPT_SNAPSHOT_V1: &str = "threadTranscriptSnapshotV1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadTranscriptSnapshotUnavailableCodeV1 {
    LegacyReader,
    UnprovenSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadTranscriptSnapshotV1 {
    Available {
        /// Opaque identity; equality is meaningful only within the same authorized thread scope.
        #[serde(rename = "snapshotId", deserialize_with = "digest")]
        #[cfg_attr(
            feature = "json-schema",
            schemars(length(min = 64, max = 64), regex(pattern = "^[0-9a-f]{64}$"))
        )]
        snapshot_id: String,
        /// Includes the final Thread and runtime display facts, never a single page's messages.
        #[serde(rename = "viewKey", deserialize_with = "digest")]
        #[cfg_attr(
            feature = "json-schema",
            schemars(length(min = 64, max = 64), regex(pattern = "^[0-9a-f]{64}$"))
        )]
        view_key: String,
    },
    Unavailable {
        code: ThreadTranscriptSnapshotUnavailableCodeV1,
    },
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
            "invalid transcript snapshot digest",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_read_to_resume_preserves_optional_wire_identity() {
        let mut legacy = json!({
            "thread":{"id":"fixture","cwd":"/tmp","status":"idle","createdAt":"1","updatedAt":"1"},
            "messages":[],"rangeStart":0,"rangeEnd":0,"hasMoreBefore":false
        });
        legacy["thread"]["metadata"] =
            serde_json::to_value(crate::ThreadMetadata::default()).unwrap();
        let page: crate::ThreadReadResult = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(&page).unwrap(), legacy);
        let resumed = serde_json::to_value(crate::ThreadResumeResult::from(page)).unwrap();
        assert!(
            resumed["history"]["page"]
                .get("transcriptSnapshotV1")
                .is_none()
        );
        let mut available = legacy;
        available["transcriptSnapshotV1"] =
            json!({"status":"available","snapshotId":"a".repeat(64),"viewKey":"b".repeat(64)});
        let page: crate::ThreadReadResult = serde_json::from_value(available.clone()).unwrap();
        let resumed = serde_json::to_value(crate::ThreadResumeResult::from(page)).unwrap();
        assert_eq!(
            resumed["history"]["page"]["transcriptSnapshotV1"],
            available["transcriptSnapshotV1"]
        );
    }

    #[test]
    fn snapshot_contract_distinguishes_unavailable_and_validates_opaque_identities() {
        for value in [
            json!({"status":"available","snapshotId":"a".repeat(64),"viewKey":"b".repeat(64)}),
            json!({"status":"unavailable","code":"legacyReader"}),
            json!({"status":"unavailable","code":"unprovenSource"}),
        ] {
            let decoded: ThreadTranscriptSnapshotV1 =
                serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        }
        for invalid in [
            json!({"status":"available","snapshotId":1,"viewKey":"b".repeat(64)}),
            json!({"status":"available","snapshotId":"a".repeat(63),"viewKey":"b".repeat(64)}),
            json!({"status":"available","snapshotId":"a".repeat(64),"viewKey":"G".repeat(64)}),
            json!({"status":"unavailable","code":"readFailed"}),
            json!({"status":"unavailable","code":"legacyReader","snapshotId":"a".repeat(64)}),
        ] {
            assert!(serde_json::from_value::<ThreadTranscriptSnapshotV1>(invalid).is_err());
        }
    }
}
