use serde::{Deserialize, Serialize};

/// Explicit index activation/rebuild, never an implicit side effect of ordinary list requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadHistoryRefreshParams {
    /// Opaque connection-scoped continuation. Omit to request a new rebuild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Required for a new rebuild: manual and unsupported old-writer edits need explicit refresh.
    #[serde(default)]
    pub acknowledge_external_writers: bool,
    /// Cancel a connection-owned rebuild using its current continuation cursor.
    #[serde(default)]
    pub cancel: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadHistoryRefreshStatus {
    Building,
    Ready,
    Incomplete,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryRefreshResult {
    pub status: ThreadHistoryRefreshStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub examined_entries: u64,
    pub indexed_sessions: u64,
    pub issue_count: u64,
    /// Bounded per-entry failure details so clients can show WHY entries were
    /// counted as issues instead of an opaque total. Absent when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ThreadHistoryRefreshIssue>,
}

/// One skipped history entry and why it failed validation or projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryRefreshIssue {
    /// Session id when the failure is attributable to one, else the entry name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_refresh_rejects_unknown_options_and_never_defaults_consent() {
        let empty: ThreadHistoryRefreshParams = serde_json::from_value(json!({})).unwrap();
        assert!(!empty.acknowledge_external_writers);
        assert!(empty.cursor.is_none());
        for invalid in [
            json!({"force":true}),
            json!({"acknowledgeExternalWriters":"yes"}),
        ] {
            assert!(serde_json::from_value::<ThreadHistoryRefreshParams>(invalid).is_err());
        }
    }

    #[test]
    fn history_refresh_wire_preserves_progress_and_opaque_cursor() {
        let wire = json!({"status":"building","nextCursor":"opaque","examinedEntries":7,"indexedSessions":2,"issueCount":0});
        let progress: ThreadHistoryRefreshResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(progress).unwrap(), wire);
        for status in [
            ThreadHistoryRefreshStatus::Ready,
            ThreadHistoryRefreshStatus::Incomplete,
        ] {
            let result = ThreadHistoryRefreshResult {
                status,
                next_cursor: None,
                examined_entries: 7,
                indexed_sessions: 2,
                issue_count: 1,
                issues: Vec::new(),
            };
            assert!(
                serde_json::to_value(result)
                    .unwrap()
                    .get("nextCursor")
                    .is_none()
            );
        }
    }

    #[test]
    fn history_refresh_issues_are_camel_case_and_optional_on_the_wire() {
        let result = ThreadHistoryRefreshResult {
            status: ThreadHistoryRefreshStatus::Incomplete,
            next_cursor: None,
            examined_entries: 9,
            indexed_sessions: 2,
            issue_count: 2,
            issues: vec![
                ThreadHistoryRefreshIssue {
                    session_id: Some("abc123".to_string()),
                    reason: "history source record is corrupt".to_string(),
                },
                ThreadHistoryRefreshIssue {
                    session_id: None,
                    reason: "old.jsonl: unsupported history source version".to_string(),
                },
            ],
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["issues"][0]["sessionId"], "abc123");
        assert_eq!(
            value["issues"][1]["reason"],
            "old.jsonl: unsupported history source version"
        );
        // Round trip and absent-when-empty.
        let parsed: ThreadHistoryRefreshResult = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, result);
        let empty = ThreadHistoryRefreshResult {
            status: ThreadHistoryRefreshStatus::Ready,
            next_cursor: None,
            examined_entries: 0,
            indexed_sessions: 0,
            issue_count: 0,
            issues: Vec::new(),
        };
        assert!(
            serde_json::to_value(&empty)
                .unwrap()
                .get("issues")
                .is_none()
        );
    }
}
