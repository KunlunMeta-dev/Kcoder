use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn multiline_json_with_split_crlf_reaches_the_real_provider_adapter() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        let mut input = [0; 16384];
        assert!(socket.read(&mut input).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
        let chunks = [
            "data: {\"choices\": [\r",
            "\ndata: {\"index\":0,\"delta\":{\"content\":\"完整文本\"},\"finish_reason\":null}]}\r\n\r\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n",
        ];
        for (index, chunk) in chunks.iter().enumerate() {
            let frame = format!("{:x}\r\n{}\r\n", chunk.len(), chunk);
            if socket.write_all(frame.as_bytes()).await.is_err() {
                return;
            }
            if index == 0 {
                // A real transport chunk boundary is the behavior under test.
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            }
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    let provider = GenAiProvider::new("owned-fixture")
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_no_proxy(true)
        .unwrap();
    let events = provider
        .stream_messages(MessagesRequest::new(
            "gpt-4o",
            vec![Message::user_text("Owned fixture")],
        ))
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    server.await.unwrap();
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let text: String = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "完整文本");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Ok(StreamEvent::MessageStop)))
    );
}

async fn stream_fixture(deltas: Vec<Value>) -> Vec<Result<StreamEvent, ApiErrorKind>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 16384];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        let mut body = String::new();
        for delta in deltas {
            body.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]})
            ));
        }
        body.push_str("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let provider = GenAiProvider::new("local-fixture")
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_no_proxy(true)
        .unwrap();
    let events = provider
        .stream_messages(MessagesRequest::new(
            "gpt-4o",
            vec![Message::user_text("fixture")],
        ))
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    server.await.unwrap();
    events
}

#[tokio::test]
async fn tool_identity_fields_arriving_separately_preserve_wire_identity() {
    let cases = [
        (
            "together",
            vec![json!({"index":0,"id":"call-real","function":{"name":"read","arguments":"{}"}})],
        ),
        (
            "id_then_name",
            vec![
                json!({"index":0,"id":"call-real","function":{"arguments":"{"}}),
                json!({"index":0,"function":{"name":"read","arguments":"}"}}),
            ],
        ),
        (
            "name_then_id",
            vec![
                json!({"index":0,"function":{"name":"read","arguments":"{"}}),
                json!({"index":0,"id":"call-real","function":{"arguments":"}"}}),
            ],
        ),
        (
            "id_without_function",
            vec![
                json!({"index":0,"id":"call-real"}),
                json!({"index":0,"function":{"name":"read","arguments":"{}"}}),
            ],
        ),
    ];
    for (case, fragments) in cases {
        let events = stream_fixture(
            fragments
                .into_iter()
                .map(|call| json!({"tool_calls":[call]}))
                .collect(),
        )
        .await;
        assert!(events.iter().all(Result::is_ok), "{case}: {events:?}");
        let calls: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockStart {
                    content_block: ContentBlock::ToolUse { id, name, .. },
                    ..
                }) => Some((id.as_str(), name.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(calls, [("call-real", "read")], "{case}");
    }
}

#[tokio::test]
async fn conflicting_tool_identity_fails_without_completing_a_tool() {
    for conflict in [
        json!({"index":0,"id":"different","function":{"arguments":"}"}}),
        json!({"index":0,"function":{"name":"different","arguments":"}"}}),
    ] {
        let events = stream_fixture(vec![
            json!({"tool_calls":[{"index":0,"id":"call-real","function":{"name":"read","arguments":"{"}}]}),
            json!({"tool_calls":[conflict]}),
        ]).await;
        assert!(
            events.iter().any(|event| matches!(event, Err(ApiErrorKind::Api { error_type, .. }) if error_type == "provider_protocol_error")),
            "conflicting identity must return a permanent protocol error: {events:?}"
        );
        // A streamed start is display metadata, never permission to execute.
        // Conflicting identity must prevent completion and the tool loop boundary.
        assert!(!events.iter().any(|event| matches!(
            event,
            Ok(StreamEvent::ContentBlockStop { .. }) | Ok(StreamEvent::MessageStop)
        )));
    }
}

#[tokio::test]
async fn multiple_tools_in_one_wire_delta_preserve_each_index_and_argument_fragment() {
    let events = stream_fixture(vec![
        json!({"tool_calls":[
            {"index":900000,"id":"writer-a","function":{"name":"write","arguments":"{\"content\":\"a"}},
            {"index":0,"id":"writer-b","function":{"name":"write","arguments":"{\"content\":\"b"}}
        ]}),
        json!({"tool_calls":[
            {"index":900000,"function":{"arguments":"\\na2\"}"}},
            {"index":0,"function":{"arguments":"\\nb2\"}"}}
        ]}),
    ]).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let calls = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                index,
                content_block: ContentBlock::ToolUse { id, .. },
            }) => Some((*index, id.as_str())),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(calls, [(0, "writer-a"), (1, "writer-b")]);
    for (index, expected) in [(0, "a\na2"), (1, "b\nb2")] {
        let fragments = events
            .iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockDelta {
                    index: owner,
                    delta: ContentDelta::InputJsonDelta { partial_json },
                }) if *owner == index => Some(partial_json.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(fragments.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&fragments.concat()).unwrap(),
            json!({"content":expected})
        );
    }
}

#[tokio::test]
async fn unfinished_tool_identity_fails_instead_of_inventing_an_id() {
    for call in [
        json!({"index":0,"function":{"name":"read","arguments":"{}"}}),
        json!({"index":0,"id":"call-real","function":{"arguments":"{}"}}),
    ] {
        let events = stream_fixture(vec![json!({"tool_calls":[call]})]).await;
        assert!(
            events.iter().any(|event| matches!(event, Err(ApiErrorKind::Api { error_type, .. }) if error_type == "provider_protocol_error")),
            "missing identity must return a permanent protocol error: {events:?}"
        );
        assert!(!events.iter().any(|event| matches!(
            event,
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { .. },
                ..
            }) | Ok(StreamEvent::MessageStop)
        )));
    }
}

#[tokio::test]
async fn discovery_and_inference_use_the_explicit_proxy_even_with_no_proxy() {
    for no_proxy in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 16384];
                let size = socket.read(&mut buffer).await.unwrap();
                let head = String::from_utf8_lossy(&buffer[..size]);
                let path = head.lines().next().unwrap().to_string();
                let (content_type, body) = if path.starts_with("GET ") {
                    (
                        "application/json",
                        "{\"data\":[{\"id\":\"fixture-model\"}]}".to_string(),
                    )
                } else {
                    ("text/event-stream", "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_string())
                };
                paths.push(path);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            paths
        });
        let provider = GenAiProvider::new("local-fixture")
            .unwrap()
            .with_base_url("http://127.0.0.1:1/v1")
            .with_no_proxy(no_proxy)
            .unwrap()
            .with_proxy_url(Some(format!("http://{address}")))
            .unwrap();
        let models = provider
            .discover_models(ModelDiscoveryOptions {
                timeout: Duration::from_secs(1),
                max_models: 10,
            })
            .await;
        assert_eq!(models.unwrap(), ["fixture-model"], "no_proxy={no_proxy}");
        let events = provider
            .stream_messages(MessagesRequest::new(
                "gpt-4o",
                vec![Message::user_text("fixture")],
            ))
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().all(Result::is_ok), "{events:?}");
        let paths = proxy.await.unwrap();
        assert_eq!(paths[0], "GET http://127.0.0.1:1/v1/models HTTP/1.1");
        assert_eq!(
            paths[1],
            "POST http://127.0.0.1:1/v1/chat/completions HTTP/1.1"
        );
    }
}
