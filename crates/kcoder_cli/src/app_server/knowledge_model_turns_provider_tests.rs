//! End-to-end Wiki turn fixtures through every real `kcoder_api` adapter.
//! Each test serves the provider's native streaming wire format from a
//! loopback listener; no credentials, proxies or external services are used.
use super::tests::turn;
use super::*;
use kcoder_api::{AnthropicProvider, GeminiProvider, GenAiProvider, OpenAiProvider, Provider};
use kcoder_knowledge::WikiTokenUsage;
use kcoder_types::{Message, MessageOrigin};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const FIXTURE_KEY: &str = "fixture-only-key";
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const SIGNATURE: &str = "EqoBCkgIAxABGAIiQFixtureSignature+/=only";

#[derive(Clone, Copy, Debug)]
enum Adapter {
    Anthropic,
    OpenAiChat,
    OpenAiResponses,
    Gemini,
    GenAi,
}

impl Adapter {
    const ALL: [Adapter; 5] = [
        Adapter::Anthropic,
        Adapter::OpenAiChat,
        Adapter::OpenAiResponses,
        Adapter::Gemini,
        Adapter::GenAi,
    ];

    fn provider(self, address: SocketAddr) -> Result<Arc<dyn Provider>> {
        Ok(match self {
            Adapter::Anthropic => Arc::new(
                AnthropicProvider::new(FIXTURE_KEY)?
                    .with_base_url(format!("http://{address}"))
                    .with_no_proxy(true)?,
            ),
            Adapter::OpenAiChat => Arc::new(
                OpenAiProvider::new(FIXTURE_KEY, "turn-model")?
                    .with_base_url(format!("http://{address}/v1"))
                    .with_no_proxy(true)?,
            ),
            Adapter::OpenAiResponses => Arc::new(
                OpenAiProvider::new(FIXTURE_KEY, "turn-model")?
                    .with_base_url(format!("http://{address}/v1"))
                    .with_api_format(kcoder_config::ApiFormat::OpenaiResponses)
                    .with_no_proxy(true)?,
            ),
            Adapter::Gemini => Arc::new(
                GeminiProvider::new(FIXTURE_KEY, "turn-model")?
                    .with_base_url(format!("http://{address}"))
                    .with_no_proxy(true)?,
            ),
            Adapter::GenAi => Arc::new(
                GenAiProvider::new(FIXTURE_KEY)?
                    .with_base_url(format!("http://{address}/v1"))
                    .with_no_proxy(true)?,
            ),
        })
    }

    fn request_line(self) -> &'static str {
        match self {
            Adapter::Anthropic => "POST /v1/messages HTTP/1.1",
            Adapter::OpenAiChat | Adapter::GenAi => "POST /v1/chat/completions HTTP/1.1",
            Adapter::OpenAiResponses => "POST /v1/responses HTTP/1.1",
            Adapter::Gemini => {
                "POST /v1beta/models/turn-model:streamGenerateContent?alt=sse HTTP/1.1"
            }
        }
    }

    /// Tool names and schemas as this adapter serializes them on the wire.
    fn wire_tools(self, body: &Value) -> Vec<(String, Value)> {
        let (tools, name, schema) = match self {
            Adapter::Anthropic => ("/tools", "/name", "/input_schema"),
            Adapter::OpenAiChat | Adapter::GenAi => {
                ("/tools", "/function/name", "/function/parameters")
            }
            Adapter::OpenAiResponses => ("/tools", "/name", "/parameters"),
            Adapter::Gemini => ("/tools/0/functionDeclarations", "/name", "/parameters"),
        };
        body.pointer(tools)
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{self:?} request carries no tool array: {body}"))
            .iter()
            .map(|tool| {
                if matches!(
                    self,
                    Adapter::OpenAiChat | Adapter::GenAi | Adapter::OpenAiResponses
                ) {
                    assert_eq!(tool["type"], "function", "{self:?} tool wire type");
                }
                (
                    tool.pointer(name)
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_string(),
                    tool.pointer(schema).cloned().unwrap_or(Value::Null),
                )
            })
            .collect()
    }

    fn assert_tool_definitions(self, captured: &Captured) {
        assert_eq!(
            captured.request_line,
            self.request_line(),
            "{self:?} endpoint"
        );
        let tools = self.wire_tools(&captured.body);
        assert_eq!(
            tools
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["read", "edit", "write"],
            "{self:?} sends the three Wiki tools in order"
        );
        for (name, schema) in tools {
            assert_eq!(schema["type"], "object", "{self:?} {name} schema");
            assert_eq!(
                schema["required"],
                json!(["file_path"]),
                "{self:?} {name} schema"
            );
        }
    }
}

struct Captured {
    request_line: String,
    headers: String,
    body: Value,
}

struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

impl Reply {
    fn sse(body: String) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            body,
        }
    }
}

/// Bounded reader for one fixed-length HTTP/1.1 request.
async fn read_request(socket: &mut TcpStream) -> Captured {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        let count = socket.read(&mut chunk).await.expect("fixture request read");
        assert!(count > 0, "client closed before its complete request");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() <= MAX_REQUEST_BYTES, "bounded fixture request");
        let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let head = std::str::from_utf8(&bytes[..end]).expect("ASCII request head");
        assert!(
            !head
                .lines()
                .any(|line| line.to_ascii_lowercase().starts_with("transfer-encoding:")),
            "fixture expects a fixed-length request body"
        );
        let length: usize = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse().unwrap())
            .expect("request declares its length");
        assert!(
            end + 4 + length <= MAX_REQUEST_BYTES,
            "bounded fixture body"
        );
        if bytes.len() < end + 4 + length {
            continue;
        }
        let (request_line, headers) = head.split_once("\r\n").unwrap_or((head, ""));
        return Captured {
            request_line: request_line.to_string(),
            headers: headers.to_ascii_lowercase(),
            body: serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                .expect("JSON request body"),
        };
    }
}

/// Serves one reply per connection, then reports any further connection
/// (for example an automatic retry) as an extra request.
async fn serve(
    replies: Vec<Reply>,
) -> (SocketAddr, tokio::task::JoinHandle<(Vec<Captured>, usize)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut captured = Vec::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = tokio::time::timeout(Duration::from_secs(3), read_request(&mut socket))
                .await
                .expect("bounded fixture request deadline");
            captured.push(request);
            let reason = if reply.status == 200 {
                "OK"
            } else {
                "Fixture Error"
            };
            let response = format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.status,
                reply.content_type,
                reply.body.len(),
                reply.body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            let _ = socket.shutdown().await;
        }
        let extra = match tokio::time::timeout(Duration::from_millis(300), listener.accept()).await
        {
            Ok(Ok(_)) => 1,
            _ => 0,
        };
        (captured, extra)
    });
    (address, server)
}

async fn finish_server(server: tokio::task::JoinHandle<(Vec<Captured>, usize)>) -> Vec<Captured> {
    let (captured, extra) = tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("fixture server completion")
        .expect("fixture server task");
    assert_eq!(extra, 0, "the client opened an unexpected extra request");
    captured
}

async fn bounded(test: impl std::future::Future<Output = Result<()>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), test)
        .await
        .map_err(|_| anyhow::anyhow!("provider fixture exceeded its 5 s deadline"))?
}

fn wiki_model(provider: Arc<dyn Provider>) -> ProviderWikiModel {
    ProviderWikiModel {
        provider,
        model: "turn-model".into(),
        max_output_tokens: Some(16384),
        reasoning: None,
        configuration: None,
    }
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

fn data_sse(frames: &[Value], terminator: &str, done: bool) -> String {
    let mut body: String = frames
        .iter()
        .map(|frame| format!("data: {frame}{terminator}{terminator}"))
        .collect();
    if done {
        body.push_str(&format!("data: [DONE]{terminator}{terminator}"));
    }
    body
}

/// The first tool call is valid; the second carries truncated JSON and must
/// be reported invalid, never executed, and replayed with an empty object.
fn assert_tool_calls(response: &WikiTurnResponse, read_id: &str, write_id: &str) {
    let tools: Vec<_> = response.tool_uses().collect();
    assert_eq!(tools.len(), 2, "{response:?}");
    assert_eq!(
        tools[0],
        (read_id, "read", &json!({"file_path": "index.md"}))
    );
    assert_eq!(tools[1], (write_id, "write", &json!({})));
    assert_eq!(response.invalid_tool_inputs, [write_id]);
}

fn tool_results(response: &WikiTurnResponse) -> Message {
    Message::User {
        content: response
            .tool_uses()
            .map(|(id, _, _)| ContentBlock::ToolResult {
                tool_use_id: id.to_string(),
                content: vec![ContentBlock::Text {
                    text: format!("result for {id}"),
                }],
                is_error: Some(response.invalid_tool_inputs.iter().any(|bad| bad == id)),
            })
            .collect(),
        origin: MessageOrigin::Unknown,
        agent_message: None,
    }
}

fn follow_up(response: &WikiTurnResponse) -> WikiTurnRequest {
    let mut request = turn(false);
    request.messages = vec![
        Message::user_text("index.md"),
        Message::Assistant {
            content: response.content.clone(),
            usage: None,
        },
        tool_results(response),
    ];
    request
}

fn without_cache_control(mut value: Value) -> Value {
    if let Some(blocks) = value.as_array_mut() {
        for block in blocks {
            if let Some(block) = block.as_object_mut() {
                block.remove("cache_control");
            }
        }
    }
    value
}

#[tokio::test]
async fn anthropic_messages_fixture_keeps_thinking_signature_and_replays_it_verbatim() -> Result<()>
{
    bounded(async {
        let first = named_sse(&[
            json!({"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","content":[],"model":"turn-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"ping"}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan the "}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"index first."}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":SIGNATURE}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Reading "}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"the index."}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_read","name":"read","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\": "}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"index.md\"}"}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_write","name":"write","input":{}}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"draft/x.md\","}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"\"content\":\"unterminated"}}),
            json!({"type":"content_block_stop","index":3}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":57}}),
            json!({"type":"message_stop"}),
        ]);
        let second = named_sse(&[
            json!({"type":"message_start","message":{"id":"msg_fixture_2","type":"message","role":"assistant","content":[],"model":"turn-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":120,"output_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ]);
        let (address, server) = serve(vec![Reply::sse(first), Reply::sse(second)]).await;
        let model = wiki_model(Adapter::Anthropic.provider(address)?);

        let (response, usage) = model
            .complete_turn_observed(turn(true), 8192, None, None)
            .await?;
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 42,
                output_tokens: 57
            })
        );
        assert_eq!(response.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(
            response.content[0],
            ContentBlock::Thinking {
                thinking: "Plan the index first.".into(),
                signature: SIGNATURE.into(),
            }
        );
        assert_eq!(
            response.content[1],
            ContentBlock::Text {
                text: "Reading the index.".into()
            }
        );
        assert_eq!(response.content.len(), 4);
        assert_tool_calls(&response, "toolu_read", "toolu_write");

        let (done, usage) = model
            .complete_turn_observed(follow_up(&response), 8192, None, None)
            .await?;
        assert_eq!(done.text(), "Done.");
        assert!(done.invalid_tool_inputs.is_empty());
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 120,
                output_tokens: 3
            })
        );

        let captured = finish_server(server).await;
        assert_eq!(captured.len(), 2);
        Adapter::Anthropic.assert_tool_definitions(&captured[0]);
        assert!(captured[0].headers.contains(&format!("x-api-key: {FIXTURE_KEY}")));
        Adapter::Anthropic.assert_tool_definitions(&captured[1]);
        let messages = captured[1].body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "assistant");
        // The assistant turn goes back byte-for-byte: signed thinking first,
        // then text and both tool_use blocks (invalid input replayed as {}).
        assert_eq!(messages[1]["content"], serde_json::to_value(&response.content)?);
        assert_eq!(
            messages[1]["content"][0],
            json!({"type":"thinking","thinking":"Plan the index first.","signature":SIGNATURE})
        );
        assert_eq!(
            messages[1]["content"][2],
            json!({"type":"tool_use","id":"toolu_read","name":"read","input":{"file_path":"index.md"}})
        );
        assert_eq!(
            messages[1]["content"][3],
            json!({"type":"tool_use","id":"toolu_write","name":"write","input":{}})
        );
        assert_eq!(messages[2]["role"], "user");
        let results = without_cache_control(messages[2]["content"].clone());
        assert_eq!(
            results
                .as_array()
                .unwrap()
                .iter()
                .map(|block| (block["type"].as_str().unwrap(), block["tool_use_id"].as_str().unwrap()))
                .collect::<Vec<_>>(),
            [("tool_result", "toolu_read"), ("tool_result", "toolu_write")]
        );
        assert_eq!(results[1]["is_error"], true);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn openai_chat_completions_fixture_splits_tool_arguments_and_reports_final_usage()
-> Result<()> {
    bounded(async {
        let chunk = |delta: Value, finish: Value| {
            json!({"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1,"model":"turn-model",
                "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
        };
        let body = data_sse(
            &[
                chunk(json!({"role":"assistant","content":""}), Value::Null),
                chunk(json!({"content":"Reading "}), Value::Null),
                chunk(json!({"content":"the index."}), Value::Null),
                chunk(
                    json!({"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":""}}]}),
                    Value::Null,
                ),
                chunk(json!({"tool_calls":[{"index":0,"function":{"arguments":"{\"file_"}}]}), Value::Null),
                chunk(json!({"tool_calls":[{"index":0,"function":{"arguments":"path\": \"index.md\"}"}}]}), Value::Null),
                chunk(
                    json!({"tool_calls":[{"index":1,"id":"call_write","type":"function","function":{"name":"write","arguments":"{\"file_path\":\"draft/x.md\","}}]}),
                    Value::Null,
                ),
                chunk(json!({"tool_calls":[{"index":1,"function":{"arguments":"\"content\":\"unterminated"}}]}), Value::Null),
                chunk(json!({}), json!("tool_calls")),
                json!({"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1,"model":"turn-model","choices":[],
                    "usage":{"prompt_tokens":31,"completion_tokens":17,"total_tokens":48}}),
            ],
            "\n",
            true,
        );
        let (address, server) = serve(vec![Reply::sse(body)]).await;
        let model = wiki_model(Adapter::OpenAiChat.provider(address)?);
        let (response, usage) = model
            .complete_turn_observed(turn(true), 8192, None, None)
            .await?;
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 31,
                output_tokens: 17
            })
        );
        assert_eq!(response.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(
            response.content[0],
            ContentBlock::Text {
                text: "Reading the index.".into()
            }
        );
        assert_eq!(response.content.len(), 3);
        assert_tool_calls(&response, "call_read", "call_write");

        let captured = finish_server(server).await;
        Adapter::OpenAiChat.assert_tool_definitions(&captured[0]);
        assert_eq!(captured[0].body["tool_choice"], "auto");
        assert_eq!(captured[0].body["stream_options"]["include_usage"], true);
        assert!(
            captured[0]
                .headers
                .contains(&format!("authorization: bearer {FIXTURE_KEY}"))
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn openai_responses_fixture_without_final_usage_reports_unknown_usage() -> Result<()> {
    bounded(async {
        let first = named_sse(&[
            json!({"type":"response.created","sequence_number":0,"response":{"id":"resp_fixture","object":"response","status":"in_progress","output":[]}}),
            json!({"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}),
            json!({"type":"response.reasoning_summary_text.delta","sequence_number":2,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Plan "}),
            json!({"type":"response.reasoning_summary_text.delta","sequence_number":3,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"pages."}),
            json!({"type":"response.output_item.done","sequence_number":4,"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Plan pages."}],"encrypted_content":"opaque-fixture"}}),
            json!({"type":"response.output_item.added","sequence_number":5,"output_index":1,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","sequence_number":6,"item_id":"msg_1","output_index":1,"content_index":0,"delta":"Reading "}),
            json!({"type":"response.output_text.delta","sequence_number":7,"item_id":"msg_1","output_index":1,"content_index":0,"delta":"the index."}),
            json!({"type":"response.output_text.done","sequence_number":8,"item_id":"msg_1","output_index":1,"content_index":0,"text":"Reading the index."}),
            json!({"type":"response.output_item.done","sequence_number":9,"output_index":1,"item":{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Reading the index.","annotations":[]}]}}),
            json!({"type":"response.output_item.added","sequence_number":10,"output_index":2,"item":{"type":"function_call","id":"fc_read","call_id":"call_read","name":"read","arguments":"","status":"in_progress"}}),
            json!({"type":"response.function_call_arguments.delta","sequence_number":11,"item_id":"fc_read","output_index":2,"delta":"{\"file_path\":"}),
            json!({"type":"response.function_call_arguments.delta","sequence_number":12,"item_id":"fc_read","output_index":2,"delta":"\"index.md\"}"}),
            json!({"type":"response.function_call_arguments.done","sequence_number":13,"item_id":"fc_read","output_index":2,"arguments":"{\"file_path\":\"index.md\"}"}),
            json!({"type":"response.output_item.done","sequence_number":14,"output_index":2,"item":{"type":"function_call","id":"fc_read","call_id":"call_read","name":"read","arguments":"{\"file_path\":\"index.md\"}","status":"completed"}}),
            json!({"type":"response.output_item.added","sequence_number":15,"output_index":3,"item":{"type":"function_call","id":"fc_write","call_id":"call_write","name":"write","arguments":"","status":"in_progress"}}),
            json!({"type":"response.function_call_arguments.delta","sequence_number":16,"item_id":"fc_write","output_index":3,"delta":"{\"file_path\":\"draft/x.md\","}),
            json!({"type":"response.function_call_arguments.delta","sequence_number":17,"item_id":"fc_write","output_index":3,"delta":"\"content\":\"unterminated"}),
            json!({"type":"response.output_item.done","sequence_number":18,"output_index":3,"item":{"type":"function_call","id":"fc_write","call_id":"call_write","name":"write","status":"completed"}}),
            // A compatible server that omits usage entirely.
            json!({"type":"response.completed","sequence_number":19,"response":{"id":"resp_fixture","object":"response","status":"completed","output":[]}}),
        ]);
        let second = named_sse(&[
            json!({"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"message","id":"msg_2","status":"in_progress","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_2","output_index":0,"content_index":0,"delta":"Done."}),
            // An explicit null usage is unknown as well, never zero.
            json!({"type":"response.completed","sequence_number":2,"response":{"id":"resp_fixture_2","object":"response","status":"completed","output":[],"usage":null}}),
        ]);
        let (address, server) = serve(vec![Reply::sse(first), Reply::sse(second)]).await;
        let model = wiki_model(Adapter::OpenAiResponses.provider(address)?);
        let (response, usage) = model
            .complete_turn_observed(turn(true), 8192, None, None)
            .await?;
        assert_eq!(usage, None, "a missing final usage report is unknown, not zero");
        assert_eq!(response.stop_reason.as_deref(), Some("tool_use"));
        let ContentBlock::Thinking {
            thinking,
            signature,
        } = &response.content[0]
        else {
            panic!("reasoning first: {:?}", response.content);
        };
        assert_eq!(thinking, "Plan pages.");
        assert!(signature.contains("opaque-fixture"), "{signature}");
        assert_eq!(
            response.content[1],
            ContentBlock::Text {
                text: "Reading the index.".into()
            }
        );
        assert_eq!(response.content.len(), 4);
        assert_tool_calls(&response, "call_read", "call_write");

        let (done, usage) = model
            .complete_turn_observed(follow_up(&response), 8192, None, None)
            .await?;
        assert_eq!(done.text(), "Done.");
        assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(usage, None, "a null final usage report is unknown, not zero");

        let captured = finish_server(server).await;
        assert_eq!(captured.len(), 2);
        Adapter::OpenAiResponses.assert_tool_definitions(&captured[0]);
        assert_eq!(captured[0].body["instructions"], "Organize the batch");
        assert_eq!(captured[0].body["tool_choice"], "auto");
        Adapter::OpenAiResponses.assert_tool_definitions(&captured[1]);
        let input = captured[1].body["input"].as_array().unwrap();
        let kinds: Vec<_> = input
            .iter()
            .map(|item| item["type"].as_str().or_else(|| item["role"].as_str()).unwrap())
            .collect();
        // The reasoning item precedes the output it produced, in output order.
        assert_eq!(
            kinds,
            [
                "user",
                "reasoning",
                "assistant",
                "function_call",
                "function_call",
                "function_call_output",
                "function_call_output"
            ]
        );
        assert_eq!(
            input[1],
            json!({"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Plan pages."}],"encrypted_content":"opaque-fixture"})
        );
        assert_eq!(input[2]["content"][0]["text"], "Reading the index.");
        assert_eq!(input[3]["call_id"], "call_read");
        assert_eq!(input[4]["call_id"], "call_write");
        assert_eq!(input[4]["arguments"], "{}");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn gemini_fixture_keeps_complete_function_call_args_and_rejects_non_object_args() -> Result<()>
{
    bounded(async {
        let candidate = |parts: Value| {
            json!({"candidates":[{"content":{"role":"model","parts":parts},"index":0}],"modelVersion":"turn-model"})
        };
        let first = data_sse(
            &[
                candidate(json!([{"text":"Plan pages.","thought":true}])),
                candidate(json!([{"text":"Reading "}])),
                candidate(json!([{"text":"the index."}])),
                // Gemini delivers each functionCall with complete args. The
                // second carries a truncated JSON string instead of an object.
                // Only the first parallel call carries the thought signature.
                candidate(json!([
                    {"functionCall":{"name":"read","args":{"file_path":"index.md"}},"thoughtSignature":SIGNATURE},
                    {"functionCall":{"name":"write","args":"{\"file_path\":\"draft/x.md\",\"content\":\"unterminated"}}
                ])),
                json!({"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],
                    "usageMetadata":{"promptTokenCount":64,"candidatesTokenCount":21,"totalTokenCount":85},"modelVersion":"turn-model"}),
            ],
            "\r\n",
            false,
        );
        let second = data_sse(
            &[json!({"candidates":[{"content":{"role":"model","parts":[{"text":"Done."}]},"finishReason":"STOP","index":0}],
                "usageMetadata":{"promptTokenCount":90,"candidatesTokenCount":2,"thoughtsTokenCount":5,"totalTokenCount":97},"modelVersion":"turn-model"})],
            "\r\n",
            false,
        );
        let (address, server) = serve(vec![Reply::sse(first), Reply::sse(second)]).await;
        let model = wiki_model(Adapter::Gemini.provider(address)?);
        let (response, usage) = model
            .complete_turn_observed(turn(true), 8192, None, None)
            .await?;
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 64,
                output_tokens: 21
            })
        );
        assert_eq!(response.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(
            response.content[0],
            ContentBlock::Thinking {
                thinking: "Plan pages.".into(),
                signature: String::new(),
            }
        );
        assert_eq!(
            response.content[1],
            ContentBlock::Text {
                text: "Reading the index.".into()
            }
        );
        // The call signature is kept in a signature-only block before its call.
        assert_eq!(
            response.content[2],
            ContentBlock::Thinking {
                thinking: String::new(),
                signature: format!("kcoder.gemini.thought_signature.v1:next:{SIGNATURE}"),
            }
        );
        assert_eq!(response.content.len(), 5);
        // Raw part indices 0..=2 are thought/text; tool parts are 3 and 5
        // (4 anchors the first call's signature).
        assert_tool_calls(&response, "gemini_tool_0_3", "gemini_tool_0_5");

        let (done, usage) = model
            .complete_turn_observed(follow_up(&response), 8192, None, None)
            .await?;
        assert_eq!(done.text(), "Done.");
        assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
        // Thinking tokens are part of the billed output.
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 90,
                output_tokens: 7
            })
        );

        let captured = finish_server(server).await;
        assert_eq!(captured.len(), 2);
        Adapter::Gemini.assert_tool_definitions(&captured[0]);
        Adapter::Gemini.assert_tool_definitions(&captured[1]);
        let model_turn = &captured[1].body["contents"][1];
        assert_eq!(model_turn["role"], "model");
        // Unsigned thought text is not replayed; the signature returns on the
        // exact functionCall part that carried it.
        assert_eq!(
            model_turn["parts"],
            json!([
                {"text":"Reading the index."},
                {"functionCall":{"name":"read","args":{"file_path":"index.md"}},"thoughtSignature":SIGNATURE},
                {"functionCall":{"name":"write","args":{}}}
            ])
        );
        assert!(captured[0].headers.contains(&format!("x-goog-api-key: {FIXTURE_KEY}")));
        assert_eq!(
            captured[0].body["systemInstruction"]["parts"][0]["text"],
            "Organize the batch"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn genai_fixture_without_usage_reports_unknown_and_replays_reasoning_content() -> Result<()> {
    bounded(async {
        let chunk = |delta: Value, finish: Value| {
            json!({"id":"chatcmpl-genai","object":"chat.completion.chunk","created":1,"model":"turn-model",
                "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
        };
        let first = data_sse(
            &[
                chunk(json!({"role":"assistant","reasoning_content":"Plan the "}), Value::Null),
                chunk(json!({"reasoning_content":"index first."}), Value::Null),
                chunk(json!({"content":"Reading "}), Value::Null),
                chunk(json!({"content":"the index."}), Value::Null),
                chunk(
                    json!({"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":"{\"file_path\":"}}]}),
                    Value::Null,
                ),
                chunk(json!({"tool_calls":[{"index":0,"function":{"arguments":"\"index.md\"}"}}]}), Value::Null),
                chunk(
                    json!({"tool_calls":[{"index":1,"id":"call_write","type":"function","function":{"name":"write","arguments":"{\"file_path\":\"draft/x.md\","}}]}),
                    Value::Null,
                ),
                chunk(json!({"tool_calls":[{"index":1,"function":{"arguments":"\"content\":\"unterminated"}}]}), Value::Null),
                // No usage chunk follows: usage stays unknown.
                chunk(json!({}), json!("tool_calls")),
            ],
            "\n",
            true,
        );
        let second = data_sse(
            &[
                chunk(json!({"role":"assistant","content":"Done."}), Value::Null),
                chunk(json!({}), json!("stop")),
                json!({"id":"chatcmpl-genai","object":"chat.completion.chunk","created":1,"model":"turn-model","choices":[],
                    "usage":{"prompt_tokens":90,"completion_tokens":2,"total_tokens":92}}),
            ],
            "\n",
            true,
        );
        let (address, server) = serve(vec![Reply::sse(first), Reply::sse(second)]).await;
        let model = wiki_model(Adapter::GenAi.provider(address)?);
        let (response, usage) = model
            .complete_turn_observed(turn(true), 8192, None, None)
            .await?;
        assert_eq!(usage, None, "a missing final usage report is unknown, not zero");
        assert_eq!(response.stop_reason.as_deref(), Some("tool_calls"));
        assert_eq!(
            response.content[0],
            ContentBlock::Thinking {
                thinking: "Plan the index first.".into(),
                signature: String::new(),
            }
        );
        assert_eq!(
            response.content[1],
            ContentBlock::Text {
                text: "Reading the index.".into()
            }
        );
        assert_eq!(response.content.len(), 4);
        assert_tool_calls(&response, "call_read", "call_write");

        let (done, usage) = model
            .complete_turn_observed(follow_up(&response), 8192, None, None)
            .await?;
        assert_eq!(done.text(), "Done.");
        assert_eq!(
            usage,
            Some(WikiTokenUsage {
                input_tokens: 90,
                output_tokens: 2
            })
        );

        let captured = finish_server(server).await;
        assert_eq!(captured.len(), 2);
        Adapter::GenAi.assert_tool_definitions(&captured[0]);
        assert_eq!(captured[0].body["prompt_cache_key"], "batch-cache-key");
        let messages = captured[1].body["messages"].as_array().unwrap();
        let assistant = messages
            .iter()
            .find(|message| message["role"] == "assistant")
            .expect("assistant replay");
        // genai echoes reasoning_content for providers that require it.
        assert_eq!(assistant["reasoning_content"], "Plan the index first.");
        assert_eq!(assistant["content"], "Reading the index.");
        let calls = assistant["tool_calls"].as_array().unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|call| (
                    call["id"].as_str().unwrap(),
                    call["function"]["name"].as_str().unwrap(),
                    serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap())
                        .unwrap()
                ))
                .collect::<Vec<_>>(),
            [
                ("call_read", "read", json!({"file_path":"index.md"})),
                ("call_write", "write", json!({}))
            ]
        );
        let tool_ids: Vec<_> = messages
            .iter()
            .filter(|message| message["role"] == "tool")
            .map(|message| message["tool_call_id"].as_str().unwrap())
            .collect();
        assert_eq!(tool_ids, ["call_read", "call_write"]);
        Ok(())
    })
    .await
}

fn rejection_body(adapter: Adapter) -> String {
    match adapter {
        Adapter::Anthropic => json!({"type":"error","error":{"type":"invalid_request_error","message":"tools: unsupported for this model"}}),
        Adapter::OpenAiChat | Adapter::OpenAiResponses | Adapter::GenAi => json!({"error":{"message":"tools are not supported for this model","type":"invalid_request_error","param":"tools","code":null}}),
        Adapter::Gemini => json!({"error":{"code":400,"message":"Function calling is not enabled for this model","status":"INVALID_ARGUMENT"}}),
    }
    .to_string()
}

#[tokio::test]
async fn first_tool_request_http_400_is_typed_rejection_without_retry_on_every_adapter()
-> Result<()> {
    for adapter in Adapter::ALL {
        bounded(async {
            let (address, server) = serve(vec![Reply {
                status: 400,
                content_type: "application/json",
                body: rejection_body(adapter),
            }])
            .await;
            let model = wiki_model(adapter.provider(address)?);
            let error = model
                .complete_turn_observed(turn(true), 8192, None, None)
                .await
                .expect_err("a 400 tool rejection fails the turn");
            // anyhow context layers are found by downcast_ref; a context
            // object never matches `chain().any(|c| c.is::<C>())`.
            assert!(
                error.downcast_ref::<WikiToolsRejected>().is_some(),
                "{adapter:?}: {error:#}"
            );
            // finish_server also proves no retry connection was opened.
            let captured = finish_server(server).await;
            assert_eq!(captured.len(), 1, "{adapter:?} made exactly one request");
            adapter.assert_tool_definitions(&captured[0]);
            Ok(())
        })
        .await?;
    }
    Ok(())
}
