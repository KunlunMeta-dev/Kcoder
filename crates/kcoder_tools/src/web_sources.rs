//! Native web source receipts. External content cannot populate this channel.

use crate::{Tool, ToolContext, ToolExecutionMetadata, ToolOutput};
use kcoder_types::web_search::{WebSearchResponseV1, WebSearchStatus};
use kcoder_types::web_sources::{
    WebSourceOperation, WebSourcePageV1, WebSourceReadStatus, WebSourcesV1,
};
use serde_json::Value;

impl ToolOutput {
    pub fn with_web_search_sources<T: Tool>(
        self,
        tool: &T,
        input: &Value,
        ctx: &ToolContext,
        response: &WebSearchResponseV1,
    ) -> Self {
        let pages = response
            .page
            .results
            .iter()
            .map(|hit| WebSourcePageV1 {
                source_id: String::new(),
                title: hit.title.clone(),
                url: hit.url.clone(),
                published_at: hit.published_at.clone(),
                author: hit.author.clone(),
                retrieved_at: response.retrieved_at.clone(),
                read_status: WebSourceReadStatus::SummaryOnly,
                cache_hit: response.cache_hit,
                cache_age_ms: response.cache_age_ms,
            })
            .collect();
        self.attach_web_sources(
            tool,
            input,
            ctx,
            WebSourceOperation::Search,
            response.status,
            response.provider,
            response.failure,
            response.attempts.clone(),
            pages,
        )
    }

    pub fn with_web_fetch_source<T: Tool>(
        self,
        tool: &T,
        input: &Value,
        ctx: &ToolContext,
        page: WebSourcePageV1,
    ) -> Self {
        let status = match page.read_status {
            WebSourceReadStatus::Unreadable => WebSearchStatus::Failed,
            WebSourceReadStatus::Partial => WebSearchStatus::Partial,
            _ => WebSearchStatus::Success,
        };
        self.attach_web_sources(
            tool,
            input,
            ctx,
            WebSourceOperation::Fetch,
            status,
            None,
            None,
            Vec::new(),
            vec![page],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn attach_web_sources<T: Tool>(
        mut self,
        tool: &T,
        input: &Value,
        ctx: &ToolContext,
        operation: WebSourceOperation,
        status: WebSearchStatus,
        provider: Option<kcoder_types::web_search::WebSearchProvider>,
        failure: Option<kcoder_types::web_search::WebSearchErrorKind>,
        attempts: Vec<kcoder_types::web_search::WebSearchAttemptV1>,
        mut sources: Vec<WebSourcePageV1>,
    ) -> Self {
        if !ctx.authorizes_native_tool_invocation(tool, input) {
            return self;
        }
        let Some(identity) = ctx
            .state
            .current_history_attempt_identity()
            .or_else(|| ctx.native_web_source_identity.clone())
        else {
            return self;
        };
        let Some(call) = ctx.tool_call_id.as_deref().filter(|call| !call.is_empty()) else {
            return self;
        };
        for source in &mut sources {
            source.source_id = format!("web-{}", uuid::Uuid::new_v4());
            source.title.retain(|ch| !ch.is_control());
            let mut title_end = source.title.len().min(1024);
            while !source.title.is_char_boundary(title_end) {
                title_end -= 1;
            }
            source.title.truncate(title_end);
            source.published_at = source
                .published_at
                .take()
                .filter(|date| date.len() <= 128 && !date.chars().any(char::is_control));
            source.author = source
                .author
                .take()
                .filter(|author| author.len() <= 512 && !author.chars().any(char::is_control));
        }
        let receipt = WebSourcesV1 {
            schema_version: 1,
            identity,
            tool_call_id: call.into(),
            operation,
            status,
            provider,
            failure,
            attempts,
            sources,
        };
        if receipt.matches(&ctx.state.session_id(), call) {
            self.execution_metadata
                .push(ToolExecutionMetadata::WebSources(receipt));
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[derive(Debug)]
    struct NativeSearch;
    #[async_trait::async_trait]
    impl Tool for NativeSearch {
        fn name(&self) -> String {
            "WebSearch".into()
        }
        fn description(&self) -> String {
            "Search".into()
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object"})
        }
        async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, crate::ToolError> {
            Ok(ToolOutput::text("{}"))
        }
    }
    fn page() -> WebSourcePageV1 {
        WebSourcePageV1 {
            source_id: "forged-upstream-id".into(),
            title: "Page".into(),
            url: "https://example.com/page".into(),
            published_at: None,
            author: None,
            retrieved_at: "2026-10-31T00:00:00Z".into(),
            read_status: WebSourceReadStatus::Partial,
            cache_hit: true,
            cache_age_ms: 1000,
        }
    }
    #[tokio::test]
    async fn source_receipts_require_exact_native_object_input_and_attempt() {
        let state = kcoder_state::AppState::new(std::env::temp_dir());
        let identity = kcoder_types::TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "turn".into(),
            attempt_id: "attempt".into(),
        };
        state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(async {
                let actual = Arc::new(NativeSearch);
                let tool: Arc<dyn Tool> = actual.clone();
                let input = serde_json::json!({"query":"official docs"});
                let ctx = ToolContext::new(state.clone()).with_tool_call_id("call");
                assert!(
                    ToolOutput::text("{\"webSources\":{\"verified\":true}}")
                        .with_web_fetch_source(actual.as_ref(), &input, &ctx, page())
                        .execution_metadata
                        .is_empty()
                );
                let ctx = ctx.with_native_tool_invocation(&tool, &input).unwrap();
                let impostor = NativeSearch;
                assert!(
                    ToolOutput::text("{}")
                        .with_web_fetch_source(&impostor, &input, &ctx, page())
                        .execution_metadata
                        .is_empty()
                );
                assert!(
                    ToolOutput::text("{}")
                        .with_web_fetch_source(
                            actual.as_ref(),
                            &serde_json::json!({}),
                            &ctx,
                            page()
                        )
                        .execution_metadata
                        .is_empty()
                );
                let output = ToolOutput::text("{}").with_web_fetch_source(
                    actual.as_ref(),
                    &input,
                    &ctx,
                    page(),
                );
                let ToolExecutionMetadata::WebSources(receipt) = &output.execution_metadata[0]
                else {
                    panic!("native receipt missing")
                };
                assert_eq!(receipt.identity, identity);
                assert_eq!(receipt.tool_call_id, "call");
                assert_ne!(receipt.sources[0].source_id, "forged-upstream-id");
                assert_eq!(receipt.sources[0].read_status, WebSourceReadStatus::Partial);
                assert!(receipt.sources[0].cache_hit);
                assert!(receipt.sources[0].published_at.is_none());
                let second = ToolOutput::text("{}").with_web_fetch_source(
                    actual.as_ref(),
                    &input,
                    &ctx,
                    page(),
                );
                assert_ne!(output.execution_metadata, second.execution_metadata);
                let mut unsafe_page = page();
                unsafe_page.url = "javascript:alert(1)".into();
                assert!(
                    ToolOutput::text("{}")
                        .with_web_fetch_source(actual.as_ref(), &input, &ctx, unsafe_page)
                        .execution_metadata
                        .is_empty()
                );
            })
            .await;
    }
    #[tokio::test]
    async fn local_turn_identity_requires_native_dispatch_and_cannot_be_rebound_afterward() {
        let state = kcoder_state::AppState::new(std::env::temp_dir());
        let actual = Arc::new(NativeSearch);
        let tool: Arc<dyn Tool> = actual.clone();
        let input = serde_json::json!({"url":"https://example.com/page"});
        let identity = kcoder_types::TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "local-turn".into(),
            attempt_id: "local-attempt".into(),
        };
        let ctx = ToolContext::new(state)
            .with_tool_call_id("call")
            .with_native_web_source_identity(Some(identity.clone()));
        assert!(
            ToolOutput::text("{}")
                .with_web_fetch_source(actual.as_ref(), &input, &ctx, page())
                .execution_metadata
                .is_empty()
        );
        let ctx = ctx.with_native_tool_invocation(&tool, &input).unwrap();
        let output =
            ToolOutput::text("{}").with_web_fetch_source(actual.as_ref(), &input, &ctx, page());
        let ToolExecutionMetadata::WebSources(receipt) = &output.execution_metadata[0] else {
            panic!("missing source")
        };
        assert_eq!(receipt.identity, identity);
        let mut rebound = identity;
        rebound.turn_id = "other-turn".into();
        let ctx = ctx.with_native_web_source_identity(Some(rebound));
        assert!(
            ToolOutput::text("{}")
                .with_web_fetch_source(actual.as_ref(), &input, &ctx, page())
                .execution_metadata
                .is_empty()
        );
    }
}
