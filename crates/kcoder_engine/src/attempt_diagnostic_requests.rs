//! Diagnostic snapshots scoped to one built request, including its retries.

use kcoder_state::DiagnosticRequest;
use kcoder_types::MessagesRequest;

pub(crate) struct AttemptDiagnosticRequests {
    original: DiagnosticRequest,
    normalized: Option<DiagnosticRequest>,
}

impl AttemptDiagnosticRequests {
    pub(crate) fn new(request: MessagesRequest) -> Self {
        Self {
            original: DiagnosticRequest::new(request),
            normalized: None,
        }
    }

    pub(crate) fn select(&mut self, disable_reasoning: bool) -> DiagnosticRequest {
        if disable_reasoning {
            self.normalized
                .get_or_insert_with(|| {
                    let mut request = self.original.request().clone();
                    request.reasoning_effort = None;
                    request.recovery_disable_reasoning = true;
                    DiagnosticRequest::new(request)
                })
                .clone()
        } else {
            self.original.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_retries_share_snapshot_identity() {
        let mut requests = AttemptDiagnosticRequests::new(MessagesRequest::new("model", vec![]));
        let first = requests.select(true);
        let retry = requests.select(true);
        assert!(std::ptr::eq(first.request(), retry.request()));
    }

    #[test]
    fn normalization_preserves_original_and_all_other_fields() {
        let mut request =
            MessagesRequest::new("model", vec![kcoder_types::Message::user_text("history")])
                .with_system("system")
                .with_max_tokens(321)
                .with_path_first_tools(true)
                .with_reasoning_effort(Some(kcoder_types::ReasoningEffort::High))
                .with_tools(vec![kcoder_types::ToolDefinition {
                    name: "read".into(),
                    description: "Read a file".into(),
                    input_schema: serde_json::json!({"type": "object"}),
                }]);
        request.debug_session_id = Some("session".into());
        request.trajectory_agent_depth = Some(2);
        let expected_original = format!("{request:?}");
        let mut expected_normalized = request.clone();
        expected_normalized.reasoning_effort = None;
        expected_normalized.recovery_disable_reasoning = true;
        let mut requests = AttemptDiagnosticRequests::new(request);
        assert!(requests.normalized.is_none());
        let original = requests.select(false);
        let normalized = requests.select(true);
        let retry = requests.select(false);
        assert!(std::ptr::eq(original.request(), retry.request()));
        assert!(!std::ptr::eq(original.request(), normalized.request()));
        assert_eq!(format!("{:?}", original.request()), expected_original);
        assert_eq!(
            format!("{:?}", normalized.request()),
            format!("{expected_normalized:?}")
        );
    }

    #[test]
    fn rebuilt_request_has_isolated_snapshots_and_new_content() {
        let mut previous = AttemptDiagnosticRequests::new(MessagesRequest::new(
            "model",
            vec![kcoder_types::Message::user_text("old history")],
        ));
        let old_original = previous.select(false);
        let old_normalized = previous.select(true);
        let rebuilt = MessagesRequest::new(
            "model",
            vec![kcoder_types::Message::user_text("compacted history")],
        );
        let expected = serde_json::to_value(&rebuilt).unwrap();
        let mut requests = AttemptDiagnosticRequests::new(rebuilt);
        assert!(requests.normalized.is_none());
        let original = requests.select(false);
        let normalized = requests.select(true);
        assert!(!std::ptr::eq(old_original.request(), original.request()));
        assert!(!std::ptr::eq(
            old_normalized.request(),
            normalized.request()
        ));
        assert_eq!(serde_json::to_value(original.request()).unwrap(), expected);
        assert_eq!(
            serde_json::to_value(normalized.request()).unwrap(),
            expected
        );
    }
}
