use crate::ApiErrorKind;
use crate::providers::{
    AnthropicProvider, GeminiProvider, GenAiProvider, OpenAiProvider, Provider,
};
use futures::StreamExt;
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, ProviderResponseLimits, StreamEvent,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Copy, Debug)]
enum Format {
    Anthropic,
    Chat,
    Responses,
    Gemini,
    Sdk,
}

async fn run(
    format: Format,
    body: String,
    limits: ProviderResponseLimits,
) -> Vec<Result<StreamEvent, ApiErrorKind>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 16384];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let endpoint = format!("http://{address}/v1");
    let provider: Box<dyn Provider> = match format {
        Format::Anthropic => Box::new(
            AnthropicProvider::new("fixture")
                .unwrap()
                .with_base_url(endpoint)
                .with_no_proxy(true)
                .unwrap(),
        ),
        Format::Chat => Box::new(
            OpenAiProvider::local_compatible()
                .unwrap()
                .with_base_url(endpoint),
        ),
        Format::Responses => Box::new(
            OpenAiProvider::local_compatible()
                .unwrap()
                .with_api_format(kcoder_config::ApiFormat::OpenaiResponses)
                .with_base_url(endpoint),
        ),
        Format::Gemini => Box::new(
            GeminiProvider::new("fixture", "gemini-fixture")
                .unwrap()
                .with_base_url(endpoint)
                .with_no_proxy(true)
                .unwrap(),
        ),
        Format::Sdk => Box::new(
            GenAiProvider::new("fixture")
                .unwrap()
                .with_base_url(endpoint)
                .with_no_proxy(true)
                .unwrap(),
        ),
    };
    let request = MessagesRequest::new("gpt-4o", vec![Message::user_text("文".repeat(1024))])
        .with_max_tokens(256000)
        .with_response_limits(limits);
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        provider
            .stream_messages(request)
            .unwrap()
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    server.await.unwrap();
    events
}

fn data(value: serde_json::Value) -> String {
    format!("data: {value}\n\n")
}

fn text_body(format: Format) -> String {
    match format {
        Format::Anthropic => {
            let mut body = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_string();
            for _ in 0..2 { body.push_str("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"文\"}}\n\n"); }
            body + "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        }
        Format::Responses => {
            let frame = "event: response.output_text.delta\ndata: {\"delta\":\"文\"}\n\n";
            frame.repeat(2) + "event: response.completed\ndata: {}\n\n"
        }
        Format::Gemini => data(serde_json::json!({"candidates":[{"content":{"parts":[{"text":"文"}]}}]})).repeat(2)
            + &data(serde_json::json!({"candidates":[{"finishReason":"STOP"}]})),
        Format::Chat | Format::Sdk => data(serde_json::json!({"choices":[{"index":0,"delta":{"content":"文"},"finish_reason":null}]})).repeat(2) + "data: [DONE]\n\n",
    }
}

fn limits(total: usize, args: usize, blocks: usize, active: usize) -> ProviderResponseLimits {
    ProviderResponseLimits {
        total_decoded_bytes: total,
        tool_arguments_bytes: args,
        content_blocks: blocks,
        active_tool_calls: active,
    }
}

fn assert_limit(events: &[Result<StreamEvent, ApiErrorKind>]) {
    let error = events
        .iter()
        .find_map(|event| event.as_ref().err())
        .expect("typed response limit error");
    assert!(matches!(error, ApiErrorKind::ResponseLimit { .. }));
    assert_eq!(
        error.non_http_error_class(),
        Some(crate::NonHttpErrorClass::Permanent)
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Ok(StreamEvent::MessageStop)))
    );
}

#[tokio::test]
async fn all_native_and_sdk_streams_enforce_exact_utf8_totals_without_context_token_changes() {
    for format in [
        Format::Anthropic,
        Format::Chat,
        Format::Responses,
        Format::Gemini,
        Format::Sdk,
    ] {
        let body = text_body(format);
        let accepted = run(format, body.clone(), limits(6, 6, 4, 1)).await;
        assert!(
            accepted.iter().all(Result::is_ok),
            "{format:?}: {accepted:?}"
        );
        let text: String = accepted
            .iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                }) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "文文");
        assert!(
            accepted
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::MessageStop)))
        );
        let rejected = run(format, body, limits(5, 5, 4, 1)).await;
        assert_limit(&rejected);
        let text: String = rejected
            .iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                }) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "文", "overflow fragment must not be published");
    }
}

#[tokio::test]
async fn tool_arguments_and_sparse_identity_maps_are_bounded_before_growth() {
    for format in [Format::Chat, Format::Sdk] {
        let first = data(
            serde_json::json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c","function":{"name":"read","arguments":"{"}}]},"finish_reason":null}]}),
        );
        let tail = data(
            serde_json::json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"a\":1}"}}]},"finish_reason":null}]}),
        );
        let events = run(
            format,
            first.clone() + &tail + "data: [DONE]\n\n",
            limits(64, 6, 4, 1),
        )
        .await;
        assert_limit(&events);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::ContentBlockStop { .. })))
        );
        let second = data(
            serde_json::json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":900000,"id":"d","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]}),
        );
        let events = run(
            format,
            first + &second + "data: [DONE]\n\n",
            limits(64, 32, 4, 1),
        )
        .await;
        assert_limit(&events);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::ContentBlockStop { .. })))
        );
    }
}

#[tokio::test]
async fn gemini_many_wire_fragments_share_a_block_and_tool_transitions_preserve_order() {
    let text = data(serde_json::json!({"candidates":[{"content":{"parts":[{"text":"x"}]}}]}));
    let body = text.repeat(1025)
        + &data(
            serde_json::json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"file"}}},{"text":"tail"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}),
        );
    let events = run(Format::Gemini, body, limits(2048, 128, 3, 1)).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let starts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                index,
                content_block,
            }) => Some((
                *index,
                matches!(content_block, ContentBlock::ToolUse { .. }),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(starts, [(0, false), (1, true), (2, false)]);
    let stops: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStop { index }) => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(stops, [0, 1, 2]);
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
    assert_eq!(text, "x".repeat(1025) + "tail");
    assert!(events.iter().any(|event| matches!(event, Ok(StreamEvent::MessageDelta { delta }) if delta.usage.as_ref().is_some_and(|usage| usage.total_tokens == Some(5)))));
}
