//! Main-engine tool loops over real Responses and Gemini HTTP adapters: the
//! reasoning continuity captured by the adapter in turn one must reach the
//! provider again in turn two. Loopback fixtures only; no model calls.
use crate::test_support::engine_builder::{TestEngineBuilder, fixture_settings};
use crate::{EngineEvent, Settings};
use futures::StreamExt;
use kcoder_api::providers::{GeminiProvider, OpenAiProvider, Provider};
use kcoder_config::{ApiFormat, PermissionMode};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolRegistry};
use kcoder_types::{ContentBlock, Message};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug)]
struct FixtureRead;

#[async_trait::async_trait]
impl Tool for FixtureRead {
    fn name(&self) -> String {
        "fixture_read".into()
    }

    fn description(&self) -> String {
        "Return fixed fixture file content".into()
    }

    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]})
    }

    async fn call(&self, _input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput::text("fixture contents"))
    }
}

/// Answers each model request with the next SSE body. The adapters' one-shot
/// connection prewarm (a bodiless HEAD) is acknowledged and not counted.
async fn serve(replies: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut bodies = Vec::new();
        let total = replies.len();
        let mut replies = replies.into_iter();
        while bodies.len() < total {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (header_end, length) = loop {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0, "request ended before its headers");
                bytes.extend_from_slice(&buffer[..count]);
                assert!(bytes.len() <= 4 * 1024 * 1024, "bounded fixture request");
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = std::str::from_utf8(&bytes[..end]).unwrap();
                    let length = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    });
                    break (end + 4, length);
                }
            };
            if bytes.starts_with(b"HEAD ") {
                socket
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                continue;
            }
            let length = length.expect("model requests carry a body length");
            while bytes.len() < header_end + length {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0, "request ended before its body");
                bytes.extend_from_slice(&buffer[..count]);
            }
            bodies.push(serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap());
            let reply = replies.next().expect("no unexpected model request");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        bodies
    });
    (format!("http://{address}"), server)
}

async fn run_tool_loop(
    provider: Arc<dyn Provider>,
    server: tokio::task::JoinHandle<Vec<Value>>,
) -> (Vec<Value>, Vec<Message>) {
    let tmp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(tmp.path())
        .provider(provider)
        .settings(Settings {
            permission_mode: PermissionMode::Bypass,
            ..fixture_settings()
        })
        .tool_registry(ToolRegistry::new().register(FixtureRead))
        .build_with_profile_directory();
    engine
        .state
        .add_message(Message::user_text("read index.md"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events: Vec<_> = tokio::time::timeout(
        Duration::from_secs(10),
        engine.run_turn_stream(&prompt).collect(),
    )
    .await
    .expect("bounded engine tool loop");
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    let bodies = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    (bodies, engine.state.messages())
}

fn assistant_blocks(history: &[Message]) -> Vec<ContentBlock> {
    history
        .iter()
        .find_map(|message| match message {
            Message::Assistant { content, .. }
                if content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolUse { .. })) =>
            {
                Some(content.clone())
            }
            _ => None,
        })
        .expect("persisted tool-use turn")
}

#[tokio::test]
async fn engine_tool_loop_replays_responses_reasoning_items() {
    let named = |events: &[Value]| -> String {
        events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect()
    };
    let first = named(&[
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_engine","summary":[]}}),
        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_engine","summary":[],"encrypted_content":"enc-engine"}}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_engine","call_id":"call_engine","name":"fixture_read","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","item_id":"fc_engine","output_index":1,"delta":"{\"file_path\":\"index.md\"}"}),
        json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_engine","call_id":"call_engine","name":"fixture_read","arguments":"{\"file_path\":\"index.md\"}"}}),
        json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60}}}),
    ]);
    let second = named(&[
        json!({"type":"response.output_text.delta","item_id":"msg_engine","output_index":0,"delta":"Done."}),
        json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":70,"output_tokens":2,"total_tokens":72}}}),
    ]);
    let (base, server) = serve(vec![first, second]).await;
    let provider = OpenAiProvider::new("fixture-key", "gpt-fixture")
        .unwrap()
        .with_base_url(format!("{base}/v1"))
        .with_api_format(ApiFormat::OpenaiResponses)
        .with_no_proxy(true)
        .unwrap();
    let (bodies, history) = run_tool_loop(Arc::new(provider), server).await;
    assert_eq!(bodies.len(), 2);
    // The Engine persists the opaque replay token with the turn.
    assert!(matches!(
        &assistant_blocks(&history)[0],
        ContentBlock::Thinking { thinking, signature } if thinking.is_empty() && signature.contains("enc-engine")
    ));
    let input = bodies[1]["input"].as_array().unwrap();
    let reasoning = input
        .iter()
        .position(|item| item["type"] == "reasoning")
        .expect("reasoning item replayed");
    assert_eq!(
        input[reasoning],
        json!({"type":"reasoning","id":"rs_engine","summary":[],"encrypted_content":"enc-engine"})
    );
    assert_eq!(input[reasoning + 1]["type"], "function_call");
    assert_eq!(input[reasoning + 1]["call_id"], "call_engine");
    assert_eq!(input[reasoning + 2]["type"], "function_call_output");
}

#[tokio::test]
async fn engine_tool_loop_returns_gemini_function_call_signatures() {
    let data = |frames: &[Value]| -> String {
        frames
            .iter()
            .map(|frame| format!("data: {frame}\r\n\r\n"))
            .collect()
    };
    let first = data(&[json!({"candidates":[{"content":{"role":"model","parts":[
            {"functionCall":{"name":"fixture_read","args":{"file_path":"index.md"}},"thoughtSignature":"ZW5naW5lLXNpZw=="}
        ]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":6,"totalTokenCount":46}})]);
    let second = data(&[
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":"Done."}]},"finishReason":"STOP","index":0}],
            "usageMetadata":{"promptTokenCount":60,"candidatesTokenCount":2,"totalTokenCount":62}}),
    ]);
    let (base, server) = serve(vec![first, second]).await;
    let provider = GeminiProvider::new("fixture-key", "gemini-fixture")
        .unwrap()
        .with_base_url(base)
        .with_no_proxy(true)
        .unwrap();
    let (bodies, history) = run_tool_loop(Arc::new(provider), server).await;
    assert_eq!(bodies.len(), 2);
    assert!(matches!(
        assistant_blocks(&history).as_slice(),
        [ContentBlock::Thinking { thinking, .. }, ContentBlock::ToolUse { .. }] if thinking.is_empty()
    ));
    let model_turn = bodies[1]["contents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|content| content["role"] == "model")
        .expect("model turn replayed");
    assert_eq!(
        model_turn["parts"],
        json!([{"functionCall":{"name":"fixture_read","args":{"file_path":"index.md"}},"thoughtSignature":"ZW5naW5lLXNpZw=="}])
    );
}
