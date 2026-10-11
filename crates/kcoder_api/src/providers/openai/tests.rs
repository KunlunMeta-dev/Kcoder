#[tokio::test]
async fn native_openai_protocols_emit_one_message_start_after_valid_response() {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for api_format in [ApiFormat::OpenaiChatCompletions, ApiFormat::OpenaiResponses] {
        for success in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let size: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if request.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                let (status, body) = if !success {
                    (
                        "429 Too Many Requests",
                        "{\"error\":{\"message\":\"fixture\"}}".to_string(),
                    )
                } else if api_format == ApiFormat::OpenaiResponses {
                    ("200 OK", concat!(
                        "event: response.output_text.delta\ndata: {\"delta\":\"summary\"}\n\n",
                        "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n"
                    ).to_string())
                } else {
                    ("200 OK", concat!(
                        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"summary\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: [DONE]\n\n"
                    ).to_string())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            // No credential is required by this local compatible fixture.
            let provider = OpenAiProvider::local_compatible()
                .unwrap()
                .with_base_url(format!("http://{address}/v1"))
                .with_api_format(api_format);
            let events: Vec<_> = provider
                .stream_messages(MessagesRequest::new("fixture-model", vec![]))
                .unwrap()
                .collect()
                .await;
            server.await.unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, Ok(StreamEvent::MessageStart { .. })))
                    .count(),
                usize::from(success)
            );
            if success {
                assert!(
                    matches!(&events[0], Ok(StreamEvent::MessageStart { message }) if message.model == "fixture-model" && message.role == "assistant")
                );
                assert!(matches!(events.last(), Some(Ok(StreamEvent::MessageStop))));
                assert!(events.iter().all(Result::is_ok));
                let mut open = std::collections::BTreeSet::new();
                for event in &events {
                    match event.as_ref().unwrap() {
                        StreamEvent::ContentBlockStart { index, .. } => {
                            assert!(open.insert(*index));
                        }
                        StreamEvent::ContentBlockStop { index } => {
                            assert!(open.remove(index));
                        }
                        StreamEvent::MessageStop => assert!(
                            open.is_empty(),
                            "message cannot finish with unclosed blocks"
                        ),
                        _ => {}
                    }
                }
            } else {
                assert!(events.iter().any(Result::is_err));
            }
        }
    }
}

#[tokio::test]
async fn minimax_finish_reason_eof_requires_terminal_and_preserves_tail() {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (minimax, reason, done, expected) in [
        (true, Some("stop"), false, true),
        (true, Some("length"), false, true),
        (true, None, false, false),
        (true, Some("unknown"), false, false),
        (false, Some("stop"), false, false),
        (true, Some("stop"), true, true),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let size: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            let chunk = serde_json::json!({"choices":[{"index":0,"delta":{"content":"answer","reasoning_content":"thought"},"finish_reason":reason}],"usage":{"prompt_tokens":3,"completion_tokens":4}});
            let mut body = format!(
                "data: {chunk}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":4}}}}\n\n"
            );
            if done {
                body.push_str("data: [DONE]\n\n");
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let mut provider = OpenAiProvider::new("fixture", "MiniMax-M3")
            .unwrap()
            .with_base_url(format!("http://{address}/v1"))
            .with_no_proxy(true)
            .unwrap();
        if minimax {
            provider = provider.with_minimax_protocol();
        }
        let events: Vec<_> = provider
            .stream_messages(MessagesRequest::new("MiniMax-M3", vec![]))
            .unwrap()
            .collect()
            .await;
        server.await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Ok(StreamEvent::MessageStop)))
                .count(),
            usize::from(expected)
        );
        assert_eq!(events.iter().any(Result::is_err), !expected);
        assert!(events.iter().any(|e| matches!(e, Ok(StreamEvent::ContentBlockDelta {delta: ContentDelta::ThinkingDelta {thinking}, ..}) if thinking == "thought")));
        assert!(events.iter().any(|e| matches!(e, Ok(StreamEvent::ContentBlockDelta {delta: ContentDelta::TextDelta {text}, ..}) if text == "answer")));
        assert!(events.iter().any(|e| matches!(e, Ok(StreamEvent::MessageDelta {delta}) if delta.usage.as_ref().is_some_and(|u| u.output_tokens == 4))));
    }
}

#[tokio::test]
async fn incomplete_tool_identity_is_rejected_atomically_at_terminal() {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    for (id, name, terminal, valid_peer) in [
        (None, None, "done", false),
        (None, None, "finish", false),
        (None, None, "eof", false),
        (Some(""), Some("read"), "done", false),
        (Some("call-1"), Some(""), "done", false),
        (Some(" "), Some("read"), "done", false),
        (Some("call-1"), Some(" \n"), "done", false),
        (None, None, "finish", true),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 16384];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let mut function = serde_json::json!({"arguments":"{\"path\":"});
            if let Some(name) = name {
                function["name"] = serde_json::json!(name);
            }
            let mut call = serde_json::json!({"index":0,"type":"function","function":function});
            if let Some(id) = id {
                call["id"] = serde_json::json!(id);
            }
            let mut calls = vec![call];
            if valid_peer {
                calls.push(serde_json::json!({"index":1,"id":"valid-peer","type":"function","function":{"name":"read","arguments":"{}"}}));
            }
            let chunk = serde_json::json!({"choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]});
            let mut body = format!("data: {chunk}\n\n");
            if terminal != "done" {
                let reason = if terminal == "eof" {
                    "length"
                } else {
                    "tool_calls"
                };
                let chunk =
                    serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]});
                body.push_str(&format!("data: {chunk}\n\n"));
            }
            if terminal != "eof" {
                body.push_str("data: [DONE]\n\n");
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let mut provider = OpenAiProvider::local_compatible()
            .unwrap()
            .with_base_url(format!("http://{address}/v1"));
        if terminal == "eof" {
            provider = provider.with_minimax_protocol();
        }
        let events = tokio::time::timeout(
            Duration::from_secs(2),
            provider
                .stream_messages(MessagesRequest::new(
                    "fixture",
                    vec![Message::user_text("fixture")],
                ))
                .unwrap()
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        let errors: Vec<_> = events
            .iter()
            .filter_map(|event| event.as_ref().err())
            .collect();
        assert_eq!(
            errors.len(),
            1,
            "terminal={terminal} id={id:?} name={name:?}"
        );
        assert!(matches!(errors[0], ApiErrorKind::Api { error_type, .. }
            if error_type == "provider_protocol_error"));
        assert_eq!(
            errors[0].non_http_error_class(),
            Some(crate::NonHttpErrorClass::Permanent)
        );
        assert!(
            !events.iter().any(|event| matches!(
                event,
                Ok(StreamEvent::ContentBlockStop { .. } | StreamEvent::MessageStop)
            )),
            "failed preflight must not finalize any peer or publish successful completion"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    Ok(StreamEvent::ContentBlockStart {
                        content_block: ContentBlock::ToolUse { .. },
                        ..
                    })
                ))
                .count(),
            usize::from(valid_peer),
            "invalid identity must not start a tool block"
        );
    }
}

#[test]
fn normalize_schema_for_openai_declares_collections_for_empty_object_roots() {
    let normalized = super::normalize_schema_for_openai(
        serde_json::json!({"type":"object","additionalProperties":false}),
    );
    assert_eq!(normalized["properties"], serde_json::json!({}));
    assert_eq!(normalized["required"], serde_json::json!([]));

    let untouched = super::normalize_schema_for_openai(serde_json::json!({"type":"string"}));
    assert!(untouched.get("properties").is_none());
    assert!(untouched.get("required").is_none());

    let declared = super::normalize_schema_for_openai(serde_json::json!({
        "type":"object",
        "properties":{"a":{"type":"string"}},
        "required":["a"]
    }));
    assert_eq!(declared["required"], serde_json::json!(["a"]));
    assert_eq!(declared["properties"]["a"]["type"], "string");
}

#[test]
fn path_first_wire_preserves_custom_freeform_final_bodies() {
    let tools = serde_json::json!([{
        "type":"custom", "name":"write", "format":{"type":"text"},
        "parameters":{"properties":{"content":{},"file_path":{}}},
        "custom":{"name":"edit","format":{"type":"grammar","definition":"file_path content"}},
        "function":{"name":"write","parameters":{"properties":{"content":{},"file_path":{}}}}
    }]);
    let extra = serde_json::json!({"tools":tools})
        .as_object()
        .unwrap()
        .clone();
    for responses in [false, true] {
        let build = |enabled| {
            let request =
                kcoder_types::MessagesRequest::new("model", vec![]).with_path_first_tools(enabled);
            if responses {
                super::build_openai_responses_request(request, extra.clone()).unwrap()
            } else {
                super::build_openai_request_with_options(
                    request,
                    super::OpenAiRequestOptions {
                        extra_body: extra.clone(),
                        ..Default::default()
                    },
                )
                .unwrap()
            }
        };
        let disabled = build(false);
        assert_eq!(disabled, build(true));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&disabled).unwrap()["tools"],
            tools
        );
    }
}

#[test]
fn path_first_wire_chat_final_body() {
    super::super::path_first::tests::assert_final_body(|request| {
        super::build_openai_request(request).unwrap()
    });
}

#[test]
fn path_first_wire_responses_final_body() {
    super::super::path_first::tests::assert_final_body(|request| {
        super::build_openai_responses_request(request, serde_json::Map::new()).unwrap()
    });
}
#[test]
fn reviewed_stream_errors_preserve_nested_type_and_redact_fields() {
    use crate::NonHttpErrorClass;
    for detail in [
        serde_json::json!({"type":"error", "code":"rate_limit_error"}),
        serde_json::json!({"type":"sk-secret", "code":"rate_limit_error"}),
        serde_json::json!({"code":"sk-secret"}),
        serde_json::json!({"type":" overloaded_error "}),
    ] {
        for event in ["response.failed", "error", "chat"] {
            let payload = if event == "response.failed" {
                serde_json::json!({"response":{"error":detail}})
            } else {
                serde_json::json!({"error":detail})
            }
            .to_string();
            let error = if event == "chat" {
                super::parse_openai_stream_chunk(&payload).unwrap_err()
            } else {
                super::ResponsesStreamState::default()
                    .process(event, &payload)
                    .unwrap_err()
            };
            assert_eq!(
                error.non_http_error_class(),
                Some(NonHttpErrorClass::Permanent),
                "{event}/{detail}"
            );
            assert!(!error.to_string().contains("sk-secret"), "{event}: {error}");
            assert!(!format!("{error:?}").contains("sk-secret"), "{event}");
        }
    }
    let error = super::ResponsesStreamState::default()
        .process("error", r#"{"type":"error","code":"rate_limit_error"}"#)
        .unwrap_err();
    assert_eq!(
        error.non_http_error_class(),
        Some(NonHttpErrorClass::RateLimited)
    );
}

#[test]
fn chat_stream_error_objects_preserve_exact_types() {
    use crate::NonHttpErrorClass;
    for (kind, expected) in [
        ("overloaded_error", NonHttpErrorClass::Transient),
        ("authentication_error", NonHttpErrorClass::Permanent),
        ("unknown", NonHttpErrorClass::Permanent),
    ] {
        let error = super::parse_openai_stream_chunk(&serde_json::json!({"error": {"type":kind,"code":"rate_limit_error","message":"network 429 api_key=sk-secret"}}).to_string()).unwrap_err();
        assert_eq!(error.non_http_error_class(), Some(expected), "{kind}");
        assert!(matches!(error, crate::ApiErrorKind::Api { .. }));
        assert!(!error.to_string().contains("sk-secret"));
    }
    assert!(super::parse_openai_stream_chunk(r#"{"choices":[]}"#).is_ok());
    assert!(matches!(
        super::parse_openai_stream_chunk(r#"{"error":"network 429"}"#),
        Err(crate::ApiErrorKind::JsonParse(_, _))
    ));
}

#[test]
fn responses_error_types_are_structured_and_diagnostics_stay_redacted() {
    use crate::NonHttpErrorClass;
    for event in ["response.failed", "error"] {
        for (kind, expected) in [
            ("overloaded_error", NonHttpErrorClass::Transient),
            ("authentication_error", NonHttpErrorClass::Permanent),
            ("unknown", NonHttpErrorClass::Permanent),
        ] {
            let detail = serde_json::json!({"type": kind, "code": "rate_limit_error", "message": "network 429 api_key=sk-secret"});
            let payload = if event == "response.failed" {
                serde_json::json!({"response": {"error": detail}})
            } else {
                serde_json::json!({"error": detail})
            };
            let error = super::ResponsesStreamState::default()
                .process(event, &payload.to_string())
                .unwrap_err();
            assert_eq!(
                error.non_http_error_class(),
                Some(expected),
                "{event}/{kind}"
            );
            assert!(!error.to_string().contains("sk-secret"));
        }
    }
}

use super::*;
use kcoder_types::{Message, MessagesRequest, ReasoningEffort, ResponseJsonSchema, ToolDefinition};

#[test]
fn responses_request_uses_responses_shapes_and_limits() {
    let request = MessagesRequest::new("gpt-test", vec![Message::user_text("hello")])
        .with_system("system")
        .with_max_tokens(12_345)
        .with_tools(vec![ToolDefinition {
            name: "read".to_string(),
            description: "read a file".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }]);

    let body = build_openai_responses_request(request, Map::new()).unwrap();
    let value: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(value["model"], "gpt-test");
    assert_eq!(value["instructions"], "system");
    assert_eq!(value["max_output_tokens"], 12_345);
    assert_eq!(value["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(value["tools"][0]["type"], "function");
    assert!(value.get("messages").is_none());
}

#[test]
fn responses_blocks_allocate_contiguous_indices_in_arrival_order() {
    let mut state = ResponsesStreamState::default();
    state.process("response.output_item.added", r#"{"output_index":9,"item":{"type":"function_call","id":"item1","call_id":"call1","name":"bash"}}"#).unwrap();
    state
        .process(
            "response.function_call_arguments.delta",
            r#"{"item_id":"item1","delta":"{}"}"#,
        )
        .unwrap();
    state
        .process(
            "response.output_item.done",
            r#"{"item":{"call_id":"call1"}}"#,
        )
        .unwrap();
    state
        .process(
            "response.reasoning_summary_text.delta",
            r#"{"delta":"think"}"#,
        )
        .unwrap();
    state
        .process("response.output_text.delta", r#"{"delta":"answer"}"#)
        .unwrap();
    state.process("response.output_item.added", r#"{"output_index":15,"item":{"type":"function_call","id":"item2","call_id":"call2","name":"bash"}}"#).unwrap();
    state
        .process("response.output_item.done", r#"{"item":{"id":"item2"}}"#)
        .unwrap();
    let starts: Vec<_> = state
        .pending
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ContentBlockStart { index, .. } => Some(*index),
            _ => None,
        })
        .collect();
    let stops: Vec<_> = state
        .pending
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ContentBlockStop { index } => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(starts, vec![0, 1, 2, 3]);
    assert_eq!(stops, vec![0, 3]);
    assert!(state.tool_indices.is_empty());
}

#[test]
fn responses_stream_maps_text_usage_and_completion() {
    let mut state = ResponsesStreamState::default();
    state
        .process("response.output_text.delta", r#"{"delta":"hello"}"#)
        .unwrap();
    state
        .process(
            "response.completed",
            r#"{"response":{"usage":{"input_tokens":10,"output_tokens":2}}}"#,
        )
        .unwrap();

    assert!(matches!(
        state.pending[0],
        StreamEvent::ContentBlockStart { .. }
    ));
    assert!(matches!(
        state.pending[1],
        StreamEvent::ContentBlockDelta { .. }
    ));
    assert!(matches!(state.pending[2], StreamEvent::MessageDelta { .. }));
    assert!(matches!(state.pending[3], StreamEvent::MessageStop));
    assert!(state.done);
}

#[test]
fn openai_request_includes_system_messages_and_tools() {
    let request = MessagesRequest::new("gpt-4o", vec![Message::user_text("hello")])
        .with_system("You are a helpful assistant.")
        .with_tools(vec![ToolDefinition {
            name: "read".to_string(),
            description: "read a file".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"}
                },
                "required": ["file_path"]
            }),
        }]);

    let body = build_openai_request(request).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["model"], "gpt-4o");
    assert!(payload["stream"].as_bool().unwrap());
    assert_eq!(
        payload["max_tokens"],
        kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS
    );
    assert_eq!(payload["stream_options"]["include_usage"], true);
    assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
    assert_eq!(payload["messages"][0]["role"], "system");
    assert_eq!(payload["messages"][1]["role"], "user");

    let tools = payload["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(tools[0]["function"]["name"], "read");
    assert_eq!(payload["tool_choice"], "auto");
}

#[test]
fn local_openai_request_replays_reasoning_content_with_tool_call_history() {
    let reasoning = "The user wants me to inspect the repository before calling bash.";
    let request = MessagesRequest::new(
        "Qwen3.5-4B",
        vec![
            Message::user_text("Inspect the repository"),
            Message::Assistant {
                content: vec![
                    ContentBlock::Thinking {
                        thinking: reasoning.to_string(),
                        signature: String::new(),
                    },
                    ContentBlock::ToolUse {
                        id: "call_1".to_string(),
                        name: "bash".to_string(),
                        input: serde_json::json!({"command": "pwd"}),
                    },
                ],
                usage: None,
            },
            Message::User {
                origin: kcoder_types::MessageOrigin::Unknown,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "/workspace".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
        ],
    );

    let standard_body = build_openai_request(request.clone()).unwrap();
    let standard_payload: Value = serde_json::from_str(&standard_body).unwrap();
    assert!(
        standard_payload["messages"][1]
            .get("reasoning_content")
            .is_none(),
        "未声明该私有协议的标准请求不得携带 reasoning_content"
    );

    let body = build_openai_request_with_options(
        request,
        OpenAiRequestOptions {
            replay_reasoning_content: true,
            ..OpenAiRequestOptions::default()
        },
    )
    .unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();
    let assistant = &payload["messages"][1];

    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["reasoning_content"], reasoning);
    assert!(assistant["content"].is_null());
    assert_eq!(assistant["tool_calls"][0]["id"], "call_1");
    assert_eq!(payload["messages"][2]["role"], "tool");
    assert_eq!(payload["messages"][2]["tool_call_id"], "call_1");
}

#[test]
fn openai_request_includes_response_json_schema() {
    let request = MessagesRequest::new("gpt-4o", vec![Message::user_text("hello")])
        .with_response_json_schema(
            ResponseJsonSchema::new(
                "observer_draft",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "answer": {"type": "string"}
                    },
                    "required": ["answer"],
                    "additionalProperties": false
                }),
            )
            .with_description("Observer draft JSON"),
        );

    let body = build_openai_request(request).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["response_format"]["type"], "json_schema");
    assert_eq!(
        payload["response_format"]["json_schema"]["name"],
        "observer_draft"
    );
    assert_eq!(
        payload["response_format"]["json_schema"]["description"],
        "Observer draft JSON"
    );
    assert_eq!(payload["response_format"]["json_schema"]["strict"], true);
    assert_eq!(
        payload["response_format"]["json_schema"]["schema"]["properties"]["answer"]["type"],
        "string"
    );
}

#[test]
fn openai_request_can_omit_stream_options_for_local_compatibility() {
    let request =
        MessagesRequest::new("Kimi-2.6", vec![Message::user_text("hello")]).with_max_tokens(128);

    let body = build_openai_request_with_options(
        request,
        OpenAiRequestOptions {
            include_stream_options: false,
            ..OpenAiRequestOptions::default()
        },
    )
    .unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["model"], "Kimi-2.6");
    assert_eq!(payload["max_tokens"], 128);
    assert!(payload.get("stream_options").is_none());
}

#[test]
fn openai_request_merges_extra_body_fields_for_local_compatibility() {
    let request = MessagesRequest::new("Qwen3.6-35B-A3B", vec![Message::user_text("hello")])
        .with_max_tokens(128);
    let mut extra_body = serde_json::Map::new();
    extra_body.insert("top_k".to_string(), serde_json::json!(32));
    extra_body.insert("top_p".to_string(), serde_json::json!(0.95));
    extra_body.insert("temperature".to_string(), serde_json::json!(1.0));
    extra_body.insert(
        "chat_template_kwargs".to_string(),
        serde_json::json!({"enable_thinking": false}),
    );

    let body = build_openai_request_with_options(
        request,
        OpenAiRequestOptions {
            include_stream_options: false,
            extra_body,
            ..OpenAiRequestOptions::default()
        },
    )
    .unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["model"], "Qwen3.6-35B-A3B");
    assert_eq!(payload["top_k"], 32);
    assert_eq!(payload["top_p"], 0.95);
    assert_eq!(payload["temperature"], 1.0);
    assert_eq!(payload["chat_template_kwargs"]["enable_thinking"], false);
}

#[test]
fn reasoning_recovery_removes_native_override_without_other_changes() {
    for responses in [false, true] {
        let mut request =
            MessagesRequest::new("model", vec![kcoder_types::Message::user_text("hello")])
                .with_reasoning_effort(Some(kcoder_types::ReasoningEffort::High));
        let field = if responses {
            "reasoning"
        } else {
            "reasoning_effort"
        };
        let extra = serde_json::json!({field: if responses { serde_json::json!({"effort":"high"}) } else { serde_json::json!("high") }, "temperature":0.7});
        let build = |request| {
            if responses {
                build_openai_responses_request(request, extra.as_object().unwrap().clone())
            } else {
                build_openai_request_with_options(
                    request,
                    OpenAiRequestOptions {
                        extra_body: extra.as_object().unwrap().clone(),
                        ..Default::default()
                    },
                )
            }
            .unwrap()
        };
        let mut expected: Value = serde_json::from_str(&build(request.clone())).unwrap();
        assert!(expected.as_object_mut().unwrap().remove(field).is_some());
        request.recovery_disable_reasoning = true;
        let actual: Value = serde_json::from_str(&build(request)).unwrap();
        assert_eq!(actual, expected);
        assert!(actual.get("recovery_disable_reasoning").is_none());
    }
}

#[test]
fn reasoning_recovery_capability_matches_native_protocol() {
    use crate::RejectedReasoningParameter::*;
    for responses in [false, true] {
        let provider = OpenAiProvider::local_compatible()
            .unwrap()
            .with_api_format(if responses {
                ApiFormat::OpenaiResponses
            } else {
                ApiFormat::OpenaiChatCompletions
            });
        for parameter in [Thinking, ReasoningEffort, Reasoning, ReasoningDotEffort] {
            assert_eq!(
                provider.supports_reasoning_suppression(parameter),
                if responses {
                    matches!(parameter, Reasoning | ReasoningDotEffort)
                } else {
                    parameter == ReasoningEffort
                }
            );
        }
    }
}

#[test]
fn openai_request_includes_reasoning_effort_when_set() {
    let request = MessagesRequest::new("gpt-4o", vec![Message::user_text("hello")])
        .with_reasoning_effort(Some(ReasoningEffort::High));

    let body = build_openai_request(request).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["reasoning_effort"], "high");
}

#[test]
fn openai_request_rewrites_definitions_to_defs_for_tool_schemas() {
    let request =
        MessagesRequest::new("Kimi-2.6", vec![Message::user_text("hello")]).with_tools(vec![
            ToolDefinition {
                name: "ref_test".to_string(),
                description: "test refs".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "definitions": {
                        "Mode": {
                            "type": "string",
                            "enum": ["a", "b"]
                        }
                    },
                    "properties": {
                        "mode": {
                            "$ref": "#/definitions/Mode"
                        }
                    },
                    "required": ["mode"]
                }),
            },
        ]);

    let body = build_openai_request_with_options(
        request,
        OpenAiRequestOptions {
            include_stream_options: false,
            ..OpenAiRequestOptions::default()
        },
    )
    .unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();
    let parameters = &payload["tools"][0]["function"]["parameters"];

    assert!(parameters.get("definitions").is_none());
    assert!(parameters.get("$defs").is_some());
    assert_eq!(parameters["properties"]["mode"]["$ref"], "#/$defs/Mode");
}

#[test]
fn openai_base_url_accepts_base_or_full_chat_completions_url() {
    assert_eq!(
        chat_completions_url("http://127.0.0.1:8000/v1"),
        "http://127.0.0.1:8000/v1/chat/completions"
    );
    assert_eq!(
        chat_completions_url("http://127.0.0.1:8910/v1/chat/completions"),
        "http://127.0.0.1:8910/v1/chat/completions"
    );
    assert_eq!(
        chat_completions_url(" http://127.0.0.1:8910/v1/chat/completions/ "),
        "http://127.0.0.1:8910/v1/chat/completions"
    );
}

#[test]
fn openai_provider_timeout_can_be_configured() {
    let provider = OpenAiProvider::new("test-key", "test-model").unwrap();
    assert_eq!(
        provider.timeout_secs_for_test(),
        DEFAULT_REQUEST_TIMEOUT_SECS
    );

    let provider = provider.with_timeout_secs(600).unwrap();
    assert_eq!(provider.timeout_secs_for_test(), 600);

    let local = OpenAiProvider::local_compatible()
        .unwrap()
        .with_timeout_secs(601)
        .unwrap();
    assert_eq!(local.timeout_secs_for_test(), 601);
}

#[test]
fn openai_request_headers_include_training_agent_depth() {
    let provider = OpenAiProvider::local_compatible().unwrap();
    let request = MessagesRequest::new("slime-actor", vec![Message::user_text("work")])
        .with_trajectory_agent_depth(2);

    let headers = provider.headers_for_request(&request).unwrap();

    assert_eq!(
        headers
            .get("x-slime-agent-depth")
            .and_then(|value| value.to_str().ok()),
        Some("2")
    );
    assert_eq!(
        headers
            .get("x-slime-replay-reasoning-content")
            .and_then(|value| value.to_str().ok()),
        Some("1")
    );

    let standard_headers = OpenAiProvider::new("test-key", "gpt-test")
        .unwrap()
        .headers_for_request(&request)
        .unwrap();
    assert!(
        standard_headers
            .get("x-slime-replay-reasoning-content")
            .is_none()
    );
}

#[test]
fn openai_stream_maps_ollama_reasoning_field_to_thinking_delta() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-test",
                "choices":[{
                    "index":0,
                    "delta":{"content":"","reasoning":" Process"},
                    "finish_reason":null
                }]
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(matches!(
        state.pending.first(),
        Some(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::Thinking { .. },
            ..
        })
    ));
    assert!(matches!(
        state.pending.get(1),
        Some(StreamEvent::ContentBlockDelta {
            delta: ContentDelta::ThinkingDelta { thinking },
            ..
        }) if thinking == " Process"
    ));
    assert_eq!(
        state.pending.len(),
        2,
        "空的 content 不应急于打开文本块: {:?}",
        state.pending
    );
}

#[test]
fn openai_stream_prefers_reasoning_content_over_reasoning() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-test",
                "choices":[{
                    "index":0,
                    "delta":{"reasoning_content":"canonical","reasoning":"raw"},
                    "finish_reason":null
                }]
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(matches!(
        state.pending.get(1),
        Some(StreamEvent::ContentBlockDelta {
            delta: ContentDelta::ThinkingDelta { thinking },
            ..
        }) if thinking == "canonical"
    ));
}

#[test]
fn openai_stream_maps_reasoning_content_to_thinking_delta() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-test",
                "choices":[{
                    "index":0,
                    "delta":{"reasoning_content":"思考"},
                    "finish_reason":null
                }]
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(matches!(
        state.pending.first(),
        Some(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::Thinking { .. },
            ..
        })
    ));
    assert!(matches!(
        state.pending.get(1),
        Some(StreamEvent::ContentBlockDelta {
            delta: ContentDelta::ThinkingDelta { thinking },
            ..
        }) if thinking == "思考"
    ));
}

#[test]
fn openai_stream_starts_text_after_reasoning_content() {
    let reasoning_chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-test",
                "choices":[{
                    "index":0,
                    "delta":{"reasoning_content":"先想"},
                    "finish_reason":null
                }]
            }"#,
    )
    .unwrap();
    let text_chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-test",
                "choices":[{
                    "index":0,
                    "delta":{"content":"再答"},
                    "finish_reason":null
                }]
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(reasoning_chunk).unwrap();
    state.process_chunk(text_chunk).unwrap();

    assert!(state.pending.iter().any(|event| matches!(
        event,
        StreamEvent::ContentBlockStart {
            content_block: ContentBlock::Text { .. },
            ..
        }
    )));
    assert!(state.pending.iter().any(|event| matches!(
        event,
        StreamEvent::ContentBlockDelta {
            delta: ContentDelta::TextDelta { text },
            ..
        } if text == "再答"
    )));
}

#[test]
fn openai_stream_assigns_distinct_block_indices_to_thinking_text_and_tools() {
    let reasoning_chunk: OpenAiChunk = serde_json::from_str(
        r#"{"choices":[{"index":0,"delta":{"reasoning_content":"想"},"finish_reason":null}]}"#,
    )
    .unwrap();
    let text_and_tool_chunk: OpenAiChunk = serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"content":"答","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":null}]}"#,
        )
        .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(reasoning_chunk).unwrap();
    state.process_chunk(text_and_tool_chunk).unwrap();

    let start_indices: Vec<usize> = state
        .pending
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ContentBlockStart { index, .. } => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(start_indices.len(), 3, "thinking + text + tool starts");
    let mut unique = start_indices.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        start_indices.len(),
        "block indices must not collide: {start_indices:?}"
    );
}

#[test]
fn openai_stream_processes_trailing_delta_in_finish_reason_chunk() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{"choices":[{"index":0,"delta":{"content":"末尾"},"finish_reason":"stop"}]}"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(
        state.pending.iter().any(|event| matches!(
            event,
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            } if text == "末尾"
        )),
        "trailing content in the finish chunk must not be dropped"
    );
}

#[test]
fn openai_stream_buffers_arguments_only_until_tool_identity_arrives() {
    let mut state = OpenAiStreamState::default();
    state.process_chunk(serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}"#,
        ).unwrap()).unwrap();
    assert!(
        state.pending.is_empty(),
        "arguments must not precede their tool start"
    );
    assert_eq!(state.tool_calls[&0].pending_arguments, "{\"path\":");

    state.process_chunk(serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"\"雪\""}}]},"finish_reason":null}]}"#,
        ).unwrap()).unwrap();
    assert!(matches!(&state.pending[0], StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { id, name, .. }, ..
        } if id == "call-1" && name == "read"));
    assert!(state.tool_calls[&0].pending_arguments.is_empty());
    assert_eq!(state.tool_calls[&0].pending_arguments.capacity(), 0);

    state.process_chunk(serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":null}]}"#,
        ).unwrap()).unwrap();
    let arguments: String = state
        .pending
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            } => Some(partial_json.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(arguments, "{\"path\":\"雪\"}");
    assert_eq!(
        state.tool_calls[&0].pending_arguments.capacity(),
        0,
        "started calls must not retain a duplicate argument buffer"
    );
}

#[test]
fn openai_stream_accepts_glm_null_tool_calls_chunk() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"4546133a6e1a4f66b0fb8262e00d83bf",
                "object":"chat.completion.chunk",
                "created":1781768419,
                "model":"GLM-5.2",
                "choices":[{
                    "index":0,
                    "delta":{
                        "role":null,
                        "content":"我是 **",
                        "reasoning_content":null,
                        "tool_calls":null
                    },
                    "logprobs":null,
                    "finish_reason":null,
                    "matched_stop":null
                }],
                "usage":null
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(state.pending.iter().any(|event| matches!(
        event,
        StreamEvent::ContentBlockDelta {
            delta: ContentDelta::TextDelta { text },
            ..
        } if text == "我是 **"
    )));
}

#[test]
fn openai_stream_preserves_prompt_cache_read_tokens() {
    let chunk: OpenAiChunk = serde_json::from_str(
        r#"{
                "id":"chatcmpl-cache",
                "choices":[],
                "usage":{
                    "prompt_tokens":1200,
                    "completion_tokens":80,
                    "prompt_tokens_details":{"cached_tokens":1024}
                }
            }"#,
    )
    .unwrap();
    let mut state = OpenAiStreamState::default();

    state.process_chunk(chunk).unwrap();

    assert!(state.pending.iter().any(|event| matches!(
        event,
        StreamEvent::MessageDelta { delta }
            if delta.usage.as_ref().is_some_and(|usage|
                usage.input_tokens == 1200
                    && usage.output_tokens == 80
                    && usage.cache_read_input_tokens == Some(1024)
                    && usage.total_tokens == Some(1280)
            )
    )));
}

#[test]
fn openai_error_details_extract_type_message_code_and_request_id() {
    let body = r#"{
            "error": {
                "message": "bad request",
                "type": "invalid_request_error",
                "code": "bad_model",
                "param": "model"
            },
            "request_id": "req-123"
        }"#;

    let details = parse_openai_error_details(body);

    assert_eq!(details.error_type.as_deref(), Some("invalid_request_error"));
    assert_eq!(details.message.as_deref(), Some("bad request"));
    assert_eq!(details.code.as_deref(), Some("bad_model"));
    assert_eq!(details.param.as_deref(), Some("model"));
    assert_eq!(details.request_id.as_deref(), Some("req-123"));
}

#[test]
fn openai_error_message_includes_structured_fields_and_redacts_secrets() {
    let body = r#"{"error":{"message":"bad api_key=sk-cp-secret token=abc","type":"auth_error","code":"bad_key"}}"#;
    let details = parse_openai_error_details(body);
    let message = format_openai_api_error_message(
        "openai",
        401,
        "req-header",
        &details,
        body,
        "model=test, max_tokens=1, messages=1, tools=0, body_bytes=2",
    );

    assert!(message.contains("provider=openai"));
    assert!(message.contains("status=401"));
    assert!(message.contains("request_id=req-header"));
    assert!(message.contains("type=auth_error"));
    assert!(message.contains("code=bad_key"));
    assert!(message.contains("request=model=test"));
    assert!(message.contains("[redacted]"));
    assert!(!message.contains("sk-cp-secret"));
    assert!(!message.contains("token=abc"));
}

#[test]
fn openai_request_splits_tool_results_into_separate_messages() {
    let request = MessagesRequest::new(
        "gpt-4o",
        vec![Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![
                ContentBlock::Text {
                    text: "result".to_string(),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "file content".to_string(),
                    }],
                    is_error: Some(false),
                },
            ],
        }],
    );

    let body = build_openai_request(request).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();
    let messages = payload["messages"].as_array().unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "result");
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["tool_call_id"], "call_1");
    assert_eq!(messages[1]["content"], "file content");
}

#[test]
fn openai_request_maps_image_blocks_to_image_url_parts() {
    let request = MessagesRequest::new(
        "gpt-4o",
        vec![Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![
                ContentBlock::Text {
                    text: "describe this".to_string(),
                },
                ContentBlock::Image {
                    source: kcoder_types::ImageSource::base64("image/png", "abc123"),
                },
            ],
        }],
    );

    let body = build_openai_request(request).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();
    let content = payload["messages"][0]["content"].as_array().unwrap();

    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "describe this");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(
        content[1]["image_url"]["url"],
        "data:image/png;base64,abc123"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn native_transport_observes_completion_and_incomplete_streams() {
    use super::super::transport_metrics::{Outcome, take_observation};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    for (completed, anthropic, failed, responses) in [
        (true, false, false, false),
        (true, false, false, true),
        (false, false, false, true),
        (false, false, false, false),
        (true, true, false, false),
        (false, true, false, false),
        (false, true, true, false),
        (true, true, true, false),
    ] {
        take_observation();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut part = [0u8; 1024];
                let n = socket.read(&mut part).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&part[..n]);
                assert!(request.len() < 16 * 1024);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let size: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            let mut body = if responses {
                "event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"thinking\"}\n\nevent: response.output_text.delta\ndata: {\"delta\":\"hello\"}\n\n".to_string()
            } else if anthropic {
                [
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"fixture\",\"role\":\"assistant\",\"model\":\"fixture\",\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":1,\"cache_read_input_tokens\":4}}}",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":2}}",
                    ].join("\n\n") + "\n\n"
            } else {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\n".to_string()
            };
            if failed {
                body.push_str("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"fixture\"}}\n\n");
            }
            if completed {
                body.push_str(if responses {
                        "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n\n"
                    } else if anthropic {
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    } else {
                        "data: [DONE]\n\n"
                    });
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let provider: Box<dyn Provider> = if anthropic {
            Box::new(
                crate::providers::AnthropicProvider::new("fixture")
                    .unwrap()
                    .with_base_url(format!("http://{address}/v1"))
                    .with_no_proxy(true)
                    .unwrap()
                    .with_timeout_secs(2)
                    .unwrap(),
            )
        } else {
            Box::new(
                OpenAiProvider::local_compatible()
                    .unwrap()
                    .with_api_format(if responses {
                        ApiFormat::OpenaiResponses
                    } else {
                        ApiFormat::OpenaiChatCompletions
                    })
                    .with_base_url(format!("http://{address}/v1"))
                    .with_timeout_secs(2)
                    .unwrap(),
            )
        };
        let stream = provider
            .stream_messages(MessagesRequest::new(
                "fixture",
                vec![Message::user_text("request")],
            ))
            .unwrap();
        let events = tokio::time::timeout(Duration::from_secs(5), stream.collect::<Vec<_>>())
            .await
            .unwrap();
        server.await.unwrap();
        let observed = take_observation().unwrap();
        assert_eq!(
            observed.protocol,
            if responses {
                "responses"
            } else if anthropic {
                "anthropic"
            } else {
                "chat"
            }
        );
        assert!(observed.bytes > 0);
        assert_eq!(observed.status, Some(200));
        assert!(observed.first_text.is_some());
        if responses {
            let thinking: String = events
                .iter()
                .filter_map(|event| match event {
                    Ok(StreamEvent::ContentBlockDelta {
                        delta: kcoder_types::ContentDelta::ThinkingDelta { thinking },
                        ..
                    }) => Some(thinking.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                thinking, "thinking",
                "reasoning must survive even an incomplete stream"
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, Ok(StreamEvent::MessageStop)))
                    .count(),
                usize::from(completed)
            );
        }
        if responses && !completed {
            assert!(
                observed.usage.is_none(),
                "incomplete Responses must not invent usage"
            );
        } else {
            let usage = observed.usage.as_ref().unwrap();
            assert_eq!(usage.input_tokens, Some(10));
            assert_eq!(usage.output_tokens, Some(2));
            if anthropic {
                assert_eq!(usage.cache_read_input_tokens, Some(4));
            }
        }
        if failed {
            assert!(matches!(observed.outcome, Outcome::ResponseError));
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, Err(_) | Ok(StreamEvent::Error { .. })))
                    .count(),
                1
            );
        } else if completed {
            assert!(matches!(observed.outcome, Outcome::UpstreamCompleted));
            assert!(matches!(events.last(), Some(Ok(StreamEvent::MessageStop))));
        } else {
            assert!(matches!(observed.outcome, Outcome::Incomplete));
            assert!(
                matches!(events.last(), Some(Err(ApiErrorKind::Api { error_type, .. })) if error_type == "stream_incomplete")
            );
        }
    }
}

#[tokio::test]
async fn explicit_proxy_routes_provider_requests_through_proxy_socket() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let proxy = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let read = socket.read(&mut bytes).await.unwrap();
        let request = String::from_utf8_lossy(&bytes[..read]).into_owned();
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        request
    });

    let provider = OpenAiProvider::new("test-key", "test-model")
        .unwrap()
        .with_base_url("http://upstream.invalid/v1")
        .with_proxy_url(Some(format!("http://{address}")))
        .unwrap();
    provider.prewarm().await;

    let request = tokio::time::timeout(Duration::from_secs(2), proxy)
        .await
        .expect("provider did not connect to the explicit proxy")
        .unwrap();
    assert!(request.starts_with("HEAD http://upstream.invalid/v1/chat/completions "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-key")
    );
}
