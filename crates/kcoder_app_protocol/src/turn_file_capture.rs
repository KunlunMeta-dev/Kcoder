//! Workspace interval observations, independent of tool provenance and turn success.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TURN_FILE_CAPTURE_V1: &str = "turnFileCaptureV1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TurnFileCaptureState {
    Capturing,
    Changed,
    Unchanged,
    Disabled,
    Partial,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TurnFileCaptureLimitation {
    PolicyExclusions,
    IncompleteWriters,
    OverlappingWrites,
    CaptureFailed,
    CaptureIncomplete,
    StorageUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnFileCaptureWindow {
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnFileChangesCapture {
    pub version: u8,
    pub capture_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
    pub state: TurnFileCaptureState,
    pub base: Option<TurnFileCaptureWindow>,
    pub head: Option<TurnFileCaptureWindow>,
    pub limitations: Vec<TurnFileCaptureLimitation>,
    pub artifact_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_capture_is_a_record_without_a_diff_or_a_success_claim() {
        let wire = json!({"version":1,"captureId":"c","threadId":"t","turnId":"turn-1",
            "attemptId":"turn-1","state":"failed","base":null,"head":null,
            "limitations":["captureFailed"],"artifactId":null});
        let capture: TurnFileChangesCapture = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(capture.state, TurnFileCaptureState::Failed);
        assert_eq!(serde_json::to_value(capture).unwrap(), wire);
        for invalid in [
            json!({"version":1,"state":"successful"}),
            json!({"version":1,"captureId":"c","threadId":"t","turnId":"turn-1",
                "attemptId":"turn-1","state":"failed","base":null,"head":null,
                "limitations":["captureFailed"],"artifactId":null,"owner":"forged"}),
        ] {
            assert!(serde_json::from_value::<TurnFileChangesCapture>(invalid).is_err());
        }
    }

    #[test]
    fn legacy_thread_messages_do_not_gain_an_invented_capture() {
        let message: crate::ThreadMessage = serde_json::from_value(json!({
            "id":"m","role":"assistant","content":"old result","timestampMs":1
        }))
        .unwrap();
        assert!(message.file_changes_capture.is_none());
        assert!(
            serde_json::to_value(message)
                .unwrap()
                .get("fileChangesCapture")
                .is_none()
        );
    }
}
