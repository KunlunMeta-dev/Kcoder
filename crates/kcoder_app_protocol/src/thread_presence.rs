//! Point-in-time advisory observation of a thread's workspace-scoped presence.
//!
//! This contract does not grant durable deletion or cleanup authority.

use serde::{Deserialize, Serialize};

/// Capability required before a client may call [`crate::method::THREAD_PRESENCE_READ`].
pub const CAPABILITY_THREAD_PRESENCE_READ_V1: &str = "threadPresenceReadV1";

/// Read one thread's bounded presence observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadPresenceReadParams {
    pub thread_id: String,
}

/// Stable reason for a resident runtime being authorized in the current workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadPresenceReadPresentReasonV1 {
    ResidentRuntime,
}

/// Stable reason for an authoritative State-bound deletion observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadPresenceReadAbsentReasonV1 {
    BoundDeletedPrimarySource,
}

/// Stable reasons for an inconclusive observation. Values never include paths or diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadPresenceReadUnknownReasonV1 {
    ColdSourceNotAuthorized,
    MissingHistoryParent,
    MissingControlDirectory,
    MissingControlRecord,
    MissingSourceForLiveRecord,
    LegacyDeletionWithoutBinding,
    BoundDeletionMissingSourceWithoutLock,
    BoundDeletionResidualSameIdentity,
    CompatibilityRootPresent,
    ResidentIdentityMismatch,
    PrimarySourceUnavailable,
    Busy,
    Unsupported,
    ObservationFailed,
}

/// A disposable, point-in-time presence observation. It is not a deletion receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadPresenceReadResultV1 {
    Present {
        #[serde(rename = "threadId")]
        thread_id: String,
        reason: ThreadPresenceReadPresentReasonV1,
    },
    Absent {
        #[serde(rename = "threadId")]
        thread_id: String,
        reason: ThreadPresenceReadAbsentReasonV1,
    },
    Unknown {
        #[serde(rename = "threadId")]
        thread_id: String,
        reason: ThreadPresenceReadUnknownReasonV1,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn presence_request_and_result_have_strict_stable_wire_shapes() {
        let params: ThreadPresenceReadParams =
            serde_json::from_value(json!({"threadId":"thread-1"})).unwrap();
        assert_eq!(params.thread_id, "thread-1");
        for invalid in [
            json!({}),
            json!({"threadId":"thread-1","path":"/private"}),
            json!({"threadId":4}),
        ] {
            assert!(serde_json::from_value::<ThreadPresenceReadParams>(invalid).is_err());
        }

        let results = [
            (
                ThreadPresenceReadResultV1::Present {
                    thread_id: "thread-1".into(),
                    reason: ThreadPresenceReadPresentReasonV1::ResidentRuntime,
                },
                json!({"status":"present","threadId":"thread-1","reason":"residentRuntime"}),
            ),
            (
                ThreadPresenceReadResultV1::Absent {
                    thread_id: "thread-1".into(),
                    reason: ThreadPresenceReadAbsentReasonV1::BoundDeletedPrimarySource,
                },
                json!({"status":"absent","threadId":"thread-1","reason":"boundDeletedPrimarySource"}),
            ),
            (
                ThreadPresenceReadResultV1::Unknown {
                    thread_id: "thread-1".into(),
                    reason: ThreadPresenceReadUnknownReasonV1::ColdSourceNotAuthorized,
                },
                json!({"status":"unknown","threadId":"thread-1","reason":"coldSourceNotAuthorized"}),
            ),
        ];
        for (result, expected) in results {
            let encoded = serde_json::to_value(&result).unwrap();
            assert_eq!(encoded, expected);
            assert_eq!(
                serde_json::from_value::<ThreadPresenceReadResultV1>(encoded).unwrap(),
                result
            );
        }

        assert!(
            serde_json::from_value::<ThreadPresenceReadResultV1>(json!({
                "status": "present",
                "thread_id": "thread-1",
                "reason": "residentRuntime"
            }))
            .is_err()
        );
    }

    #[cfg(feature = "json-schema")]
    #[test]
    fn presence_result_schema_uses_the_wire_field_name() {
        let schema = schemars::schema_for!(ThreadPresenceReadResultV1);
        let schema = serde_json::to_value(schema).unwrap();
        let variants = schema["oneOf"].as_array().unwrap();
        assert_eq!(variants.len(), 3);

        for variant in variants {
            let properties = variant["properties"].as_object().unwrap();
            assert!(properties.contains_key("threadId"));
            assert!(!properties.contains_key("thread_id"));

            let required = variant["required"].as_array().unwrap();
            assert!(required.iter().any(|field| field == "threadId"));
            assert!(!required.iter().any(|field| field == "thread_id"));
        }
    }
}
