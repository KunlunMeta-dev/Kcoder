use super::*;
use kcoder_api::providers::{GenAiProvider, Provider};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn genai_parameter_fragments_outlive_the_idle_window_without_snapshots() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 16384];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut frames = vec![
            json!({"index":0,"id":"call-real","function":{"name":"read","arguments":"{\"text\":\""}}),
        ];
        frames.extend((0..40).map(|_| json!({"index":0,"function":{"arguments":"x"}})));
        frames.push(json!({"index":0,"function":{"arguments":"\"}"}}));
        let mut sent = 0;
        for call in frames {
            let frame = format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[call]},"finish_reason":null}]})
            );
            let chunk = format!("{:x}\r\n{frame}\r\n", frame.len());
            if socket.write_all(chunk.as_bytes()).await.is_err() {
                return sent;
            }
            sent += 1;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let frame = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        let chunk = format!("{:x}\r\n{frame}\r\n0\r\n\r\n", frame.len());
        let _ = socket.write_all(chunk.as_bytes()).await;
        sent
    });
    let provider = GenAiProvider::new("local-fixture")
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_no_proxy(true)
        .unwrap();
    let stream = provider
        .stream_messages(MessagesRequest::new(
            "gpt-4o",
            vec![Message::user_text("fixture")],
        ))
        .unwrap();
    let events = timed_stream(stream, Duration::from_millis(250))
        .collect::<Vec<_>>()
        .await;
    let sent = server.await.unwrap();
    assert!(
        events.iter().all(Result::is_ok),
        "active parameter stream failed after {sent} frames: {events:?}"
    );
    assert!(matches!(events.last(), Some(Ok(StreamEvent::MessageStop))));
    let inputs: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json),
            _ => None,
        })
        .collect();
    assert_eq!(inputs, [&json!({"text":"x".repeat(40)}).to_string()]);
    assert_eq!(events.iter().filter(|event| matches!(event, Ok(StreamEvent::ContentBlockStart { content_block: ContentBlock::ToolUse { id, name, .. }, .. }) if id == "call-real" && name == "read")).count(), 1);
}

#[test]
fn tool_progress_updates_model_timing_without_treating_pings_as_progress() {
    assert!(crate::context_injection::stream_event_is_model_progress(
        &StreamEvent::ToolCallProgress
    ));
    assert!(!crate::context_injection::stream_event_is_model_progress(
        &StreamEvent::Ping
    ));
}
