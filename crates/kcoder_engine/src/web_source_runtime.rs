//! Native web receipt wiring is based on exact objects, never model-facing names.
use kcoder_tools::Tool;

pub(super) fn is_native_web_tool(tool: &dyn Tool) -> bool {
    tool.type_id() == std::any::TypeId::of::<kcoder_tools::WebSearchTool>()
        || tool.type_id() == std::any::TypeId::of::<kcoder_tools::WebFetchTool>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EngineEvent,
        test_support::{
            engine_builder::TestEngineBuilder, events::simple_text_events,
            providers::SequentialEventsProvider,
        },
    };
    use futures::StreamExt;
    use kcoder_tools::{ToolContext, ToolError, ToolExecutionMetadata, ToolOutput, ToolRegistry};
    use kcoder_types::{ContentBlock, Message, StreamEvent, web_search::WebSearchResponseV1};
    use serde_json::{Value, json};
    use std::sync::Arc;

    struct FixtureApproval;
    #[async_trait::async_trait]
    impl kcoder_permissions::PermissionPrompt for FixtureApproval {
        async fn ask(
            &self,
            _: &str,
            _: String,
            _: &Value,
        ) -> kcoder_permissions::PermissionResponse {
            kcoder_permissions::PermissionResponse::AllowOnce
        }
        async fn ask_explicit_context_with_edit(
            &self,
            context: &kcoder_permissions::PermissionRequestContext,
        ) -> kcoder_permissions::PermissionDialogResult {
            assert_eq!(context.tool_name, "WebSearch");
            kcoder_permissions::PermissionDialogResult {
                response: kcoder_permissions::PermissionResponse::AllowOnce,
                modified_input: None,
            }
        }
    }

    #[derive(Debug)]
    struct NativeSearchFixture;
    #[async_trait::async_trait]
    impl Tool for NativeSearchFixture {
        fn name(&self) -> String {
            "WebSearch".into()
        }
        fn description(&self) -> String {
            "Deterministic native receipt fixture".into()
        }
        fn input_schema(&self) -> Value {
            json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]})
        }
        fn requires_explicit_approval(&self) -> bool {
            true
        }
        async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
            let response: WebSearchResponseV1 = serde_json::from_value(json!({
                "schemaVersion":1,"requestId":"fixture-request","status":"success","provider":"exa-public",
                "retrievedAt":"2026-10-31T00:00:00Z","elapsedMs":1,"attempts":[],
                "page":{"results":[{"sourceId":"untrusted-upstream-id","title":"Fixture page","url":"https://example.com/fixture","snippet":"Deterministic data"}]}
            })).unwrap();
            Ok(ToolOutput::text(serde_json::to_string(&response).unwrap())
                .with_web_search_sources(self, &input, ctx, &response))
        }
    }
    #[test]
    fn receipt_wiring_recognizes_builtin_objects_and_rejects_same_name_impostors() {
        assert!(is_native_web_tool(&kcoder_tools::WebSearchTool::default()));
        assert!(is_native_web_tool(&kcoder_tools::WebFetchTool));
        assert!(!is_native_web_tool(&NativeSearchFixture));
    }
    #[tokio::test]
    async fn local_turn_native_sources_reach_history_without_entering_model_messages() {
        // Mocked model/tool data verifies provenance plumbing, not public search quality.
        let root = tempfile::tempdir().unwrap();
        let (provider, _) = SequentialEventsProvider::new(vec![
            vec![
                StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "native-search".into(),
                        name: "WebSearch".into(),
                        input: json!({"query":"official docs"}),
                    },
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageStop,
            ],
            simple_text_events("Fixture answer"),
        ]);
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(provider))
            .tool_registry(ToolRegistry::new().register(NativeSearchFixture))
            .build_with_profile_directory();
        let history_path = root
            .path()
            .join(format!("{}.jsonl", engine.state.session_id()));
        engine.state.with_history_path(&history_path);
        engine
            .state
            .add_message(Message::user_text("Search the fixture"));
        assert!(engine.state.current_history_attempt_identity().is_none());
        let events: Vec<_> = engine.run_turn_stream(&FixtureApproval).collect().await;
        let receipt = events
            .iter()
            .find_map(|event| match event {
                EngineEvent::ToolResult { id, output, .. } if id == "native-search" => output
                    .execution_metadata
                    .iter()
                    .find_map(|metadata| match metadata {
                        ToolExecutionMetadata::WebSources(receipt) => Some(receipt.clone()),
                        _ => None,
                    }),
                _ => None,
            })
            .unwrap_or_else(|| panic!("native web receipt absent: {events:?}"));
        assert_eq!(receipt.identity.thread_id, engine.state.session_id());
        assert!(receipt.identity.turn_id.starts_with("local-turn-"));
        assert!(receipt.identity.attempt_id.starts_with("local-attempt-"));
        assert_ne!(receipt.sources[0].source_id, "untrusted-upstream-id");
        assert_eq!(
            receipt.sources[0].read_status,
            kcoder_types::web_sources::WebSourceReadStatus::SummaryOnly
        );
        engine.state.flush_history().await.unwrap();
        assert!(
            kcoder_state::load_transcript_history(&history_path)
                .unwrap()
                .iter()
                .any(|entry| entry.web_sources.contains(&receipt))
        );
        assert!(
            !serde_json::to_string(&engine.state.messages())
                .unwrap()
                .contains("webSources")
        );
        assert!(engine.state.current_history_attempt_identity().is_none());
    }
}
