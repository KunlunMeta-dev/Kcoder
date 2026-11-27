//! Recorded-shape SSE fixtures for multi-turn tool loops: reasoning continuity,
//! stop reasons and usage presence through the real HTTP adapters. Loopback
//! only; no credentials, proxies or model calls.
use super::{GeminiProvider, OpenAiProvider, Provider};
use futures::StreamExt;
use kcoder_config::ApiFormat;
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessageOrigin, MessagesRequest, StreamEvent,
    ToolDefinition, Usage,
};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::task::JoinHandle;

const ENCRYPTED: &str = "gAAAAB-fixture-encrypted-reasoning==";
const CALL_SIGNATURE: &str = "Q2FsbFNpZ25hdHVyZUZpeHR1cmU=";
const TEXT_SIGNATURE: &str = "VGV4dFNpZ25hdHVyZUZpeHR1cmU=";

/// Serves one SSE reply per connection and returns every JSON request body.
async fn serve(replies: Vec<String>) -> (SocketAddr, JoinHandle<Vec<Value>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut bodies = Vec::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = super::http_fixture::read_request(&mut socket).await;
            let end = request
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap();
            bodies.push(serde_json::from_slice(&request[end + 4..]).unwrap());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        bodies
    });
    (address, server)
}

struct Turn {
    content: Vec<ContentBlock>,
    stop_reason: Option<String>,
    usage: Option<Usage>,
}

/// Assemble normalized events the way the Engine and Wiki loops do.
async fn run(provider: &dyn Provider, request: MessagesRequest) -> Turn {
    let events: Vec<StreamEvent> = tokio::time::timeout(
        Duration::from_secs(3),
        provider
            .stream_messages(request)
            .unwrap()
            .collect::<Vec<_>>(),
    )
    .await
    .expect("bounded fixture stream")
    .into_iter()
    .map(|event| event.expect("fixture stream event"))
    .collect();
    assert!(matches!(events.last(), Some(StreamEvent::MessageStop)));
    let mut turn = Turn {
        content: Vec::new(),
        stop_reason: None,
        usage: None,
    };
    for event in events {
        match event {
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                assert_eq!(index, turn.content.len(), "contiguous block indices");
                turn.content.push(content_block);
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                match (&mut turn.content[index], delta) {
                    (ContentBlock::Text { text }, ContentDelta::TextDelta { text: delta }) => {
                        text.push_str(&delta)
                    }
                    (
                        ContentBlock::Thinking { thinking, .. },
                        ContentDelta::ThinkingDelta { thinking: delta },
                    ) => thinking.push_str(&delta),
                    (
                        ContentBlock::Thinking { signature, .. },
                        ContentDelta::SignatureDelta { signature: delta },
                    ) => signature.push_str(&delta),
                    (
                        ContentBlock::ToolUse { input, .. },
                        ContentDelta::InputJsonDelta { partial_json },
                    ) => {
                        let mut raw = match &mut *input {
                            Value::Object(map) if map.is_empty() => String::new(),
                            Value::String(raw) => std::mem::take(raw),
                            other => other.to_string(),
                        };
                        raw.push_str(&partial_json);
                        *input = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
                    }
                    (block, delta) => panic!("delta {delta:?} does not fit {block:?}"),
                }
            }
            StreamEvent::MessageDelta { delta } => {
                if delta.stop_reason.is_some() {
                    turn.stop_reason = delta.stop_reason;
                }
                if delta.usage.is_some() {
                    turn.usage = delta.usage;
                }
            }
            _ => {}
        }
    }
    turn
}

fn read_tool() -> ToolDefinition {
    ToolDefinition {
        name: "read".into(),
        description: "Read one file".into(),
        input_schema: json!({"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}),
    }
}

fn follow_up(content: &[ContentBlock]) -> Vec<Message> {
    let results = content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } => Some(ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: vec![ContentBlock::Text {
                    text: format!("result for {id}"),
                }],
                is_error: Some(false),
            }),
            _ => None,
        })
        .collect();
    vec![
        Message::user_text("read index.md"),
        Message::Assistant {
            content: content.to_vec(),
            usage: None,
        },
        Message::User {
            content: results,
            origin: MessageOrigin::Unknown,
            agent_message: None,
        },
    ]
}

fn named_sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

fn data_sse(frames: &[Value]) -> String {
    frames
        .iter()
        .map(|frame| format!("data: {frame}\r\n\r\n"))
        .collect()
}

#[tokio::test]
async fn responses_tool_loop_replays_encrypted_reasoning_before_its_function_call() {
    let first = named_sse(&[
        json!({"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}),
        json!({"type":"response.reasoning_summary_part.added","sequence_number":2,"item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}),
        json!({"type":"response.reasoning_summary_text.delta","sequence_number":3,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Need the "}),
        json!({"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"index."}),
        json!({"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{"type":"reasoning","id":"rs_1","status":"completed","summary":[{"type":"summary_text","text":"Need the index."}],"encrypted_content":ENCRYPTED}}),
        json!({"type":"response.output_item.added","sequence_number":6,"output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"","status":"in_progress"}}),
        json!({"type":"response.function_call_arguments.delta","sequence_number":7,"item_id":"fc_1","output_index":1,"delta":"{\"file_path\":\"index.md\"}"}),
        json!({"type":"response.output_item.done","sequence_number":8,"output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\"file_path\":\"index.md\"}","status":"completed"}}),
        json!({"type":"response.completed","sequence_number":9,"response":{"id":"resp_1","status":"completed","incomplete_details":null,
            "usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":0},"output_tokens":9,"output_tokens_details":{"reasoning_tokens":5},"total_tokens":29}}}),
    ]);
    let second = named_sse(&[
        json!({"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_2","role":"assistant","content":[]}}),
        json!({"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_2","output_index":0,"content_index":0,"delta":"Partial"}),
        // A truncated response whose usage is explicitly unknown.
        json!({"type":"response.incomplete","sequence_number":2,"response":{"id":"resp_2","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":null}}),
    ]);
    let (address, server) = serve(vec![first, second]).await;
    let provider = OpenAiProvider::new("fixture-key", "gpt-fixture")
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_api_format(ApiFormat::OpenaiResponses)
        .with_no_proxy(true)
        .unwrap();

    let turn = run(
        &provider,
        MessagesRequest::new("gpt-fixture", vec![Message::user_text("read index.md")])
            .with_tools(vec![read_tool()]),
    )
    .await;
    assert_eq!(turn.stop_reason.as_deref(), Some("tool_use"));
    let usage = turn.usage.expect("reported usage");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (20, 9, Some(29))
    );
    assert_eq!(usage.cache_read_input_tokens, Some(0));
    assert_eq!(turn.content.len(), 2);
    let ContentBlock::Thinking {
        thinking,
        signature,
    } = &turn.content[0]
    else {
        panic!("reasoning block first: {:?}", turn.content);
    };
    assert_eq!(thinking, "Need the index.");
    assert!(signature.contains(ENCRYPTED));
    assert_eq!(
        turn.content[1],
        ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "read".into(),
            input: json!({"file_path":"index.md"}),
        }
    );

    let done = run(
        &provider,
        MessagesRequest::new("gpt-fixture", follow_up(&turn.content)).with_tools(vec![read_tool()]),
    )
    .await;
    assert_eq!(done.stop_reason.as_deref(), Some("max_tokens"));
    assert!(done.usage.is_none(), "null usage stays unknown, not zero");
    assert_eq!(
        done.content,
        [ContentBlock::Text {
            text: "Partial".into()
        }]
    );

    let bodies = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    let input = bodies[1]["input"].as_array().unwrap();
    assert_eq!(input.len(), 4, "{input:?}");
    assert_eq!(input[0]["role"], "user");
    // The reasoning item precedes the call it produced and is replayed
    // verbatim except for transient output fields.
    assert_eq!(
        input[1],
        json!({"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Need the index."}],"encrypted_content":ENCRYPTED})
    );
    assert_eq!(
        input[2],
        json!({"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"file_path\":\"index.md\"}"})
    );
    assert_eq!(
        input[3],
        json!({"type":"function_call_output","call_id":"call_1","output":"result for call_1"})
    );
}

fn responses_body(messages: Vec<Message>, extra: Value) -> Value {
    let body = super::openai::build_responses_request_for_test(
        MessagesRequest::new("gpt-fixture", messages),
        extra.as_object().cloned().unwrap_or_default(),
    );
    serde_json::from_str(&body).unwrap()
}

fn reasoning_turn(signature: String) -> Vec<Message> {
    follow_up(&[
        ContentBlock::Thinking {
            thinking: "plan".into(),
            signature,
        },
        ContentBlock::Text {
            text: "Reading.".into(),
        },
        ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "read".into(),
            input: json!({"file_path":"index.md"}),
        },
    ])
}

#[test]
fn responses_history_without_replayable_reasoning_keeps_the_historical_wire_bytes() {
    let id_only = super::openai::responses_reasoning_signature_for_test(
        &json!({"type":"reasoning","id":"rs_9","summary":[]}),
    );
    let legacy = responses_body(reasoning_turn(String::new()), json!({}));
    // Historical layout: calls first, then the assistant text message.
    assert_eq!(legacy["input"][1]["type"], "function_call");
    assert_eq!(legacy["input"][2]["role"], "assistant");
    // Unsigned, foreign or unresolvable reasoning never changes the request.
    for signature in [
        "EqoBCkgIAxABGAIiQAnthropicSignature".to_string(),
        "kcoder.gemini.thought_signature.v1:next:abc".to_string(),
    ] {
        assert_eq!(responses_body(reasoning_turn(signature), json!({})), legacy);
    }
    let stateless = json!({"store": false});
    let mut expected = legacy.clone();
    expected["store"] = json!(false);
    assert_eq!(
        responses_body(reasoning_turn(id_only.clone()), stateless.clone()),
        expected,
        "an id-only item cannot be resolved when the server stores nothing"
    );

    // A stored response resolves the id; output order is then preserved.
    let stored = responses_body(reasoning_turn(id_only), json!({}));
    let kinds: Vec<_> = stored["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            item["type"]
                .as_str()
                .or_else(|| item["role"].as_str())
                .unwrap()
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "user",
            "reasoning",
            "assistant",
            "function_call",
            "function_call_output"
        ]
    );
    assert_eq!(
        stored["input"][1],
        json!({"type":"reasoning","id":"rs_9","summary":[]})
    );

    // Encrypted reasoning survives `store: false`; a trailing reasoning item
    // without the output it produced is never sent.
    let encrypted = super::openai::responses_reasoning_signature_for_test(
        &json!({"type":"reasoning","id":"rs_8","summary":[],"encrypted_content":ENCRYPTED}),
    );
    let mut messages = reasoning_turn(encrypted.clone());
    if let Message::Assistant { content, .. } = &mut messages[1] {
        content.push(ContentBlock::Thinking {
            thinking: String::new(),
            signature: encrypted,
        });
    }
    let body = responses_body(messages, stateless);
    let reasoning: Vec<_> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "reasoning")
        .collect();
    assert_eq!(reasoning.len(), 1);
    assert_eq!(reasoning[0]["encrypted_content"], ENCRYPTED);
}

#[test]
fn responses_terminal_usage_and_stop_reasons_follow_the_wire_contract() {
    let terminal = |event: &str, data: Value| {
        let mut state = super::openai::ResponsesStateForTest::default();
        state.process(event, &data.to_string());
        state.terminal()
    };
    for usage in [json!(null), json!({}), json!("n/a")] {
        let (_, reported) = terminal(
            "response.completed",
            json!({"response":{"status":"completed","usage":usage}}),
        );
        assert_eq!(reported, None, "{usage} is unknown usage");
    }
    // Only a top-level usage is consulted when no response object exists.
    let (_, reported) = terminal("response.completed", json!({"usage":{"input_tokens":4}}));
    let reported = reported.unwrap();
    assert_eq!((reported.input_tokens, reported.total_tokens), (4, None));
    for (event, response, expected) in [
        (
            "response.completed",
            json!({"status":"completed"}),
            "end_turn",
        ),
        (
            "response.incomplete",
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}),
            "max_tokens",
        ),
        (
            "response.incomplete",
            json!({"status":"incomplete","incomplete_details":{"reason":"content_filter"}}),
            "content_filter",
        ),
        (
            "response.completed",
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}),
            "max_tokens",
        ),
    ] {
        let (stop, _) = terminal(event, json!({"response":response}));
        assert_eq!(stop.as_deref(), Some(expected), "{event} {response}");
    }
}

fn gemini_provider(address: SocketAddr) -> GeminiProvider {
    GeminiProvider::new("fixture-key", "gemini-fixture")
        .unwrap()
        .with_base_url(format!("http://{address}"))
        .with_no_proxy(true)
        .unwrap()
}

#[tokio::test]
async fn gemini_tool_loop_returns_function_call_thought_signatures() {
    let candidate = |parts: Value| json!({"candidates":[{"content":{"role":"model","parts":parts},"index":0}],"modelVersion":"gemini-fixture"});
    let first = data_sse(&[
        candidate(json!([{"text":"Plan the read.","thought":true}])),
        // Parallel calls: only the first carries the signature.
        candidate(json!([
            {"functionCall":{"name":"read","args":{"file_path":"index.md"}},"thoughtSignature":CALL_SIGNATURE},
            {"functionCall":{"name":"read","args":{"file_path":"log.md"}}}
        ])),
        json!({"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],
            "usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":12,"thoughtsTokenCount":40,"totalTokenCount":82}}),
    ]);
    let second = data_sse(&[
        candidate(json!([{"text":"Done."}])),
        // Streaming delivers the closing signature on an empty text part.
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":TEXT_SIGNATURE}]},"finishReason":"STOP","index":0}]}),
    ]);
    let (address, server) = serve(vec![first, second]).await;
    let provider = gemini_provider(address);
    let turn = run(
        &provider,
        MessagesRequest::new("gemini-fixture", vec![Message::user_text("read index.md")])
            .with_tools(vec![read_tool()]),
    )
    .await;
    assert_eq!(turn.stop_reason.as_deref(), Some("tool_use"));
    let usage = turn.usage.expect("reported usage");
    // Thinking tokens are billed output tokens.
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (30, 52, Some(82))
    );
    assert_eq!(turn.content.len(), 4, "{:?}", turn.content);
    assert!(
        matches!(&turn.content[0], ContentBlock::Thinking { thinking, signature } if thinking == "Plan the read." && signature.is_empty())
    );
    assert!(
        matches!(&turn.content[1], ContentBlock::Thinking { thinking, signature } if thinking.is_empty() && signature.ends_with(CALL_SIGNATURE))
    );
    assert!(matches!(&turn.content[2], ContentBlock::ToolUse { name, .. } if name == "read"));
    assert!(matches!(&turn.content[3], ContentBlock::ToolUse { .. }));

    let done = run(
        &provider,
        MessagesRequest::new("gemini-fixture", follow_up(&turn.content))
            .with_tools(vec![read_tool()]),
    )
    .await;
    assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
    assert!(done.usage.is_none(), "absent usageMetadata stays unknown");

    let bodies = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    let model = &bodies[1]["contents"][1];
    assert_eq!(model["role"], "model");
    // Unsigned thought summaries are still not replayed; the signature goes
    // back on the exact functionCall part that carried it.
    assert_eq!(
        model["parts"],
        json!([
            {"functionCall":{"name":"read","args":{"file_path":"index.md"}},"thoughtSignature":CALL_SIGNATURE},
            {"functionCall":{"name":"read","args":{"file_path":"log.md"}}}
        ])
    );

    // The final text turn keeps its empty signed part for the next request.
    let history = vec![
        Message::user_text("read index.md"),
        Message::Assistant {
            content: done.content,
            usage: None,
        },
        Message::user_text("thanks"),
    ];
    let body: Value = serde_json::from_str(&super::gemini::build_request_for_test(
        MessagesRequest::new("gemini-fixture", history),
    ))
    .unwrap();
    assert_eq!(
        body["contents"][1]["parts"],
        json!([{"text":"Done."},{"text":"","thoughtSignature":TEXT_SIGNATURE}])
    );
}

#[test]
fn gemini_signed_text_and_thought_parts_round_trip_on_their_own_parts() {
    let events = super::gemini::parse_chunk_for_test(&[
        json!({"candidates":[{"content":{"parts":[{"text":"Thought.","thought":true,"thoughtSignature":"VGhvdWdodA=="}]}}]}),
        json!({"candidates":[{"content":{"parts":[{"text":"Answer","thoughtSignature":"QW5zd2Vy"}]},"finishReason":"MAX_TOKENS"}],
            "usageMetadata":{"promptTokenCount":7}}),
    ]);
    let mut content: Vec<ContentBlock> = Vec::new();
    let mut stop = None;
    let mut usage = None;
    for event in events {
        match event {
            StreamEvent::ContentBlockStart { content_block, .. } => content.push(content_block),
            StreamEvent::ContentBlockDelta { delta, .. } => match (content.last_mut(), delta) {
                (
                    Some(ContentBlock::Thinking { thinking, .. }),
                    ContentDelta::ThinkingDelta { thinking: delta },
                ) => thinking.push_str(&delta),
                (Some(ContentBlock::Text { text }), ContentDelta::TextDelta { text: delta }) => {
                    text.push_str(&delta)
                }
                other => panic!("unexpected delta {other:?}"),
            },
            StreamEvent::MessageDelta { delta } => {
                stop = delta.stop_reason.or(stop);
                usage = delta.usage.or(usage);
            }
            _ => {}
        }
    }
    assert_eq!(stop.as_deref(), Some("max_tokens"));
    let usage = usage.expect("prompt count was reported");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (7, 0, None)
    );
    let body: Value = serde_json::from_str(&super::gemini::build_request_for_test(
        MessagesRequest::new(
            "gemini-fixture",
            vec![
                Message::user_text("q"),
                Message::Assistant {
                    content,
                    usage: None,
                },
            ],
        ),
    ))
    .unwrap();
    assert_eq!(
        body["contents"][1]["parts"],
        json!([
            {"text":"Thought.","thought":true,"thoughtSignature":"VGhvdWdodA=="},
            {"text":"Answer","thoughtSignature":"QW5zd2Vy"}
        ])
    );
    // A Gemini signature in a user turn or any foreign signature is ignored.
    let foreign: Value = serde_json::from_str(&super::gemini::build_request_for_test(
        MessagesRequest::new(
            "gemini-fixture",
            vec![Message::Assistant {
                content: vec![
                    ContentBlock::Thinking {
                        thinking: "x".into(),
                        signature: "EqoBCkgIAxABGAIiQAnthropicSignature".into(),
                    },
                    ContentBlock::Text { text: "y".into() },
                ],
                usage: None,
            }],
        ),
    ))
    .unwrap();
    assert_eq!(foreign["contents"][0]["parts"], json!([{"text":"y"}]));
}

#[test]
fn chat_reasoning_replay_stays_limited_to_declared_extensions() {
    let messages = follow_up(&[
        ContentBlock::Thinking {
            thinking: "plan".into(),
            signature: String::new(),
        },
        ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "read".into(),
            input: json!({"file_path":"index.md"}),
        },
    ]);
    for (declared, expected) in [(false, None), (true, Some("plan"))] {
        let body: Value = serde_json::from_str(&super::openai::build_chat_request_for_test(
            MessagesRequest::new("chat-fixture", messages.clone()),
            declared,
        ))
        .unwrap();
        assert_eq!(
            body["messages"][1]["reasoning_content"].as_str(),
            expected,
            "official Chat Completions has no reasoning input field"
        );
        assert_eq!(body["messages"][1]["tool_calls"][0]["id"], "call_1");
    }
}
