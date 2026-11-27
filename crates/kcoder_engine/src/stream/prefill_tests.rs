//! Actual local HTTP stream with a delayed first model token.
use super::*;
use futures::StreamExt;
use kcoder_api::providers::{OpenAiProvider, Provider};
use kcoder_types::{ContentDelta, Message, MessagesRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn delayed_first_token_uses_prefill_window_for_real_openai_transport() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0, "request ended before its body");
            request.extend_from_slice(&buffer[..count]);
            assert!(
                request.len() <= 1024 * 1024,
                "fixture request exceeds bound"
            );
            if let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().ok())
                            .flatten()
                    })
                    .expect("bounded request content length");
                assert!(length <= 1024 * 1024);
                if request.len() >= header_end + 4 + length {
                    break;
                }
            }
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
        let role = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n";
        socket
            .write_all(format!("{:x}\r\n{role}\r\n", role.len()).as_bytes())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let done = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"after prefill\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        socket
            .write_all(format!("{:x}\r\n{done}\r\n0\r\n\r\n", done.len()).as_bytes())
            .await
            .unwrap();
    });
    let provider = OpenAiProvider::local_compatible()
        .unwrap()
        .with_base_url(format!("http://{address}/v1"));
    let inner = provider
        .stream_messages(MessagesRequest::new(
            "fixture",
            vec![Message::user_text("owned request")],
        ))
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let events =
            timed_stream_with_prefill(inner, Duration::from_secs(2), Duration::from_millis(75))
                .collect::<Vec<_>>()
                .await;
        (&mut server).await.expect("owned HTTP server");
        events
    })
    .await;
    if result.is_err() {
        server.abort();
        let _ = server.await;
    }
    let events = result.expect("owned HTTP exchange timed out");
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert!(events.iter().any(|event| matches!(event, Ok(StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. }) if text == "after prefill")));
    assert!(matches!(events.last(), Some(Ok(StreamEvent::MessageStop))));
}
