use super::*;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::Message;
use std::sync::{Arc, Mutex};

/// Records every request and replays scripted normalized events.
struct Scripted {
    requests: Mutex<Vec<MessagesRequest>>,
    events: Mutex<Vec<Vec<Result<StreamEvent, ApiErrorKind>>>>,
}
impl Provider for Scripted {
    fn name(&self) -> &'static str {
        "wiki-turn-fixture"
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let events = self.events.lock().unwrap().remove(0);
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

fn model(
    events: Vec<Vec<Result<StreamEvent, ApiErrorKind>>>,
) -> (ProviderWikiModel, Arc<Scripted>) {
    let provider = Arc::new(Scripted {
        requests: Mutex::new(Vec::new()),
        events: Mutex::new(events),
    });
    (
        ProviderWikiModel {
            provider: provider.clone(),
            model: "turn-model".into(),
            max_output_tokens: Some(16384),
            reasoning: None,
            configuration: None,
        },
        provider,
    )
}

pub(super) fn turn(first: bool) -> WikiTurnRequest {
    WikiTurnRequest {
        stage: "generation",
        system: "Organize the batch".into(),
        messages: vec![Message::user_text("index.md")],
        tools: kcoder_knowledge_tools(),
        max_output_tokens: 4096,
        cache_key: "batch-cache-key".into(),
        first_turn: first,
    }
}

fn kcoder_knowledge_tools() -> Vec<kcoder_types::ToolDefinition> {
    ["read", "edit", "write"]
        .into_iter()
        .map(|name| kcoder_types::ToolDefinition {
            name: name.into(),
            description: format!("{name} fixture"),
            input_schema: serde_json::json!({"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}),
        })
        .collect()
}

fn start(index: usize, block: ContentBlock) -> Result<StreamEvent, ApiErrorKind> {
    Ok(StreamEvent::ContentBlockStart {
        index,
        content_block: block,
    })
}
fn delta(index: usize, delta: ContentDelta) -> Result<StreamEvent, ApiErrorKind> {
    Ok(StreamEvent::ContentBlockDelta { index, delta })
}
fn stop(index: usize) -> Result<StreamEvent, ApiErrorKind> {
    Ok(StreamEvent::ContentBlockStop { index })
}
fn message_delta(reason: &str, output: Option<u32>) -> Result<StreamEvent, ApiErrorKind> {
    Ok(serde_json::from_value(serde_json::json!({"type":"message_delta","delta":{
        "stop_reason":reason,"stop_sequence":null,
        "usage":output.map(|tokens| serde_json::json!({"input_tokens":0,"output_tokens":tokens}))}}))
    .unwrap())
}

#[tokio::test]
async fn thinking_signature_and_tool_json_deltas_are_kept_for_exact_replay() -> Result<()> {
    let (model, provider) = model(vec![vec![
        start(
            0,
            ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
        ),
        delta(
            0,
            ContentDelta::ThinkingDelta {
                thinking: "plan pages".into(),
            },
        ),
        delta(
            0,
            ContentDelta::SignatureDelta {
                signature: "sig-abc".into(),
            },
        ),
        stop(0),
        start(
            1,
            ContentBlock::RedactedThinking {
                data: "opaque".into(),
            },
        ),
        stop(1),
        start(
            2,
            ContentBlock::Text {
                text: "Reading.".into(),
            },
        ),
        stop(2),
        start(
            3,
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "read".into(),
                input: serde_json::json!({}),
            },
        ),
        delta(
            3,
            ContentDelta::InputJsonDelta {
                partial_json: "{\"file_path\":".into(),
            },
        ),
        delta(
            3,
            ContentDelta::InputJsonDelta {
                partial_json: "\"index.md\"}".into(),
            },
        ),
        stop(3),
        start(
            4,
            ContentBlock::ToolUse {
                id: "t2".into(),
                name: "write".into(),
                input: serde_json::json!({}),
            },
        ),
        delta(
            4,
            ContentDelta::InputJsonDelta {
                partial_json: "{\"file_path\":\"draft/x.md\",\"content\":\"unterminated".into(),
            },
        ),
        stop(4),
        message_delta("tool_use", Some(12)),
        Ok(StreamEvent::MessageStop),
    ]]);
    let (response, usage) = model
        .complete_turn_observed(turn(true), 8192, None, None)
        .await?;
    assert_eq!(usage.unwrap().output_tokens, 12);
    assert_eq!(response.stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(
        response.content[0],
        ContentBlock::Thinking {
            thinking: "plan pages".into(),
            signature: "sig-abc".into()
        }
    );
    assert_eq!(
        response.content[1],
        ContentBlock::RedactedThinking {
            data: "opaque".into()
        }
    );
    let tools: Vec<_> = response.tool_uses().collect();
    assert_eq!(tools[0].2, &serde_json::json!({"file_path":"index.md"}));
    assert_eq!(response.invalid_tool_inputs, ["t2"]);
    assert_eq!(
        tools[1].2,
        &serde_json::json!({}),
        "invalid input is never executed"
    );
    let request = provider.requests.lock().unwrap().remove(0);
    assert_eq!(
        request
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["read", "edit", "write"]
    );
    assert_eq!(request.debug_session_id.as_deref(), Some("batch-cache-key"));
    // The complete assistant message round-trips through serde for persistence.
    let replay: kcoder_knowledge::WikiTurnResponse =
        serde_json::from_str(&serde_json::to_string(&response)?)?;
    assert_eq!(replay, response);
    Ok(())
}

#[tokio::test]
async fn complete_start_input_without_deltas_is_used_and_usage_can_stay_unknown() -> Result<()> {
    let (model, _) = model(vec![vec![
        start(
            0,
            ContentBlock::ToolUse {
                id: "g1".into(),
                name: "write".into(),
                input: serde_json::json!({"file_path":"review.md","content":"## Notes\n"}),
            },
        ),
        stop(0),
        Ok(StreamEvent::MessageStop),
    ]]);
    let (response, usage) = model
        .complete_turn_observed(turn(false), 8192, None, None)
        .await?;
    assert!(usage.is_none(), "no final usage report is not zero usage");
    assert_eq!(response.tool_uses().count(), 1);
    assert!(response.invalid_tool_inputs.is_empty());
    Ok(())
}

#[tokio::test]
async fn truncated_turn_is_an_error_and_executes_nothing() {
    let (model, _) = model(vec![vec![
        start(
            0,
            ContentBlock::ToolUse {
                id: "t".into(),
                name: "write".into(),
                input: serde_json::json!({}),
            },
        ),
        delta(
            0,
            ContentDelta::InputJsonDelta {
                partial_json: "{\"file_path\":\"dra".into(),
            },
        ),
        message_delta("max_tokens", Some(4096)),
        Ok(StreamEvent::MessageStop),
    ]]);
    let error = model
        .complete_turn_observed(turn(false), 8192, None, None)
        .await
        .unwrap_err();
    assert!(error.chain().any(|cause| cause.is::<WikiOutputTruncated>()));
}

#[tokio::test]
async fn first_turn_rejection_without_content_is_typed_and_not_retried() {
    let (model, provider) = model(vec![vec![Err(ApiErrorKind::Api {
        error_type: "invalid_request_error".into(),
        message: "tools are not supported".into(),
    })]]);
    let error = model
        .complete_turn_observed(turn(true), 8192, None, None)
        .await
        .unwrap_err();
    assert!(error.downcast_ref::<WikiToolsRejected>().is_some());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    assert!(!provider.requests.lock().unwrap()[0].tools.is_empty());
    let (later, _) = model_rejecting();
    let error = later
        .complete_turn_observed(turn(false), 8192, None, None)
        .await
        .unwrap_err();
    assert!(error.downcast_ref::<WikiToolsRejected>().is_none());
}

fn model_rejecting() -> (ProviderWikiModel, Arc<Scripted>) {
    model(vec![vec![Err(ApiErrorKind::Api {
        error_type: "invalid_request_error".into(),
        message: String::new(),
    })]])
}

#[test]
fn turn_estimate_counts_tool_definitions() {
    let (model, _) = model(vec![]);
    let mut without = turn(true);
    without.tools.clear();
    assert!(model.estimate_turn(&turn(true)) > model.estimate_turn(&without));
}
