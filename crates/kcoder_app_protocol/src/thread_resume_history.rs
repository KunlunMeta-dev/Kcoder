//! Optional first transcript page on an already authorized thread resume.
use crate::{ThreadMessage, ThreadReadResult, ThreadResumeResult};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_THREAD_RESUME_HISTORY_PAGE_V1: &str = "threadResumeHistoryPageV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadResumeHistoryOptionsV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Use only when both resume-history and indexed-pages capabilities exist.
    #[serde(default)]
    pub indexed: bool,
}

impl ThreadResumeHistoryOptionsV1 {
    /// New inline options reject invalid limits before activating a thread.
    /// This does not change the legacy read methods' clamping behavior.
    pub fn is_valid(&self) -> bool {
        self.limit.is_none_or(|limit| (1..=100).contains(&limit))
    }
}

/// The outer resume result carries the one authoritative Thread projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadResumeHistoryPageV1 {
    pub messages: Vec<ThreadMessage>,
    pub range_start: usize,
    pub range_end: usize,
    pub has_more_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadResumeHistoryUnavailableCodeV1 {
    ReadFailed,
    ResponseBudgetExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadResumeHistoryV1 {
    Ready {
        page: ThreadResumeHistoryPageV1,
    },
    Unavailable {
        code: ThreadResumeHistoryUnavailableCodeV1,
    },
}

impl From<ThreadReadResult> for ThreadResumeResult {
    fn from(page: ThreadReadResult) -> Self {
        Self {
            thread: page.thread,
            history: Some(ThreadResumeHistoryV1::Ready {
                page: ThreadResumeHistoryPageV1 {
                    messages: page.messages,
                    range_start: page.range_start,
                    range_end: page.range_end,
                    has_more_before: page.has_more_before,
                    before_cursor: page.before_cursor,
                },
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resume_history_contract_preserves_legacy_and_rejects_ambiguous_outcomes() {
        let legacy: crate::ThreadResumeParams =
            serde_json::from_value(json!({"threadId":"thread-1"})).unwrap();
        assert!(legacy.history.is_none());
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            json!({"threadId":"thread-1"})
        );
        let options: ThreadResumeHistoryOptionsV1 =
            serde_json::from_value(json!({"limit":50})).unwrap();
        assert!(!options.indexed);
        for limit in [0, 101, u32::MAX] {
            assert!(
                !ThreadResumeHistoryOptionsV1 {
                    limit: Some(limit),
                    indexed: false
                }
                .is_valid()
            );
        }
        for limit in [None, Some(1), Some(50), Some(100)] {
            assert!(
                ThreadResumeHistoryOptionsV1 {
                    limit,
                    indexed: false
                }
                .is_valid()
            );
        }
        let ready = json!({"status":"ready","page":{
            "messages":[],"rangeStart":0,"rangeEnd":0,"hasMoreBefore":false
        }});
        let value: ThreadResumeHistoryV1 = serde_json::from_value(ready.clone()).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), ready);
        for code in ["readFailed", "responseBudgetExceeded"] {
            let unavailable = json!({"status":"unavailable","code":code});
            let value: ThreadResumeHistoryV1 = serde_json::from_value(unavailable.clone()).unwrap();
            assert_eq!(serde_json::to_value(value).unwrap(), unavailable);
        }
        for invalid in [
            json!({"status":"unavailable","code":"raw error"}),
            json!({"status":"unavailable","code":"readFailed","page":{}}),
            json!({"status":"ready","page":{},"code":"readFailed"}),
            json!({"status":"ready","page":{
                "messages":[],"rangeStart":0,"rangeEnd":0,"hasMoreBefore":false,"thread":{}
            }}),
        ] {
            assert!(serde_json::from_value::<ThreadResumeHistoryV1>(invalid).is_err());
        }
    }
}
