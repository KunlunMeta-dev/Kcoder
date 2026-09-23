//! Safe failure metadata for task lists. Raw exception text is deliberately absent.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRecentError {
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    pub kind: ThreadRecentErrorKind,
    pub source: ThreadRecentErrorSource,
    pub category: ThreadRecentErrorCategory,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadRecentErrorKind {
    Failed,
    Interrupted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadRecentErrorSource {
    Provider,
    Execution,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadRecentErrorCategory {
    Authentication,
    RateLimit,
    Network,
    Provider,
    Execution,
    Unknown,
}

pub(crate) fn deserialize_present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<ThreadRecentError>>, D::Error> {
    Option::<ThreadRecentError>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_error_unknown_none_and_safe_metadata_round_trip() {
        let mut summary = crate::ThreadRunFacts::default().summary();
        assert!(serde_json::to_value(&summary)
            .unwrap()
            .get("recentError")
            .is_none());
        summary.recent_error = Some(None);
        let encoded = serde_json::to_value(&summary).unwrap();
        assert!(encoded["recentError"].is_null());
        assert_eq!(
            serde_json::from_value::<crate::ThreadRunSummary>(encoded)
                .unwrap()
                .recent_error,
            Some(None)
        );
        summary.recent_error = Some(Some(ThreadRecentError {
            turn_id: "turn-1".into(),
            attempt_id: Some("turn-1".into()),
            kind: ThreadRecentErrorKind::Failed,
            source: ThreadRecentErrorSource::Provider,
            category: ThreadRecentErrorCategory::Authentication,
            at_ms: 123,
        }));
        let encoded = serde_json::to_value(&summary).unwrap();
        assert_eq!(encoded["recentError"]["category"], "authentication");
        assert_eq!(
            serde_json::from_value::<crate::ThreadRunSummary>(encoded).unwrap(),
            summary
        );
    }
}
