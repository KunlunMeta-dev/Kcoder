//! Configured model routes cannot forward request bodies to a redirect destination.
use super::*;
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn provider_transports_do_not_follow_cross_origin_307_with_private_request_body() {
    for adapter in 0..4 {
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", source.local_addr().unwrap());
        let location = format!("http://{}/unapproved", destination.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                assert!(bytes.len() < 128 * 1024);
                if let Some(header_end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers =
                        String::from_utf8_lossy(&bytes[..header_end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            assert!(String::from_utf8_lossy(&bytes).contains("OWNED_PRIVATE_MODEL_BODY"));
            stream.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        let provider: Box<dyn Provider> = match adapter {
            0 => Box::new(
                OpenAiProvider::local_compatible()
                    .unwrap()
                    .with_base_url(base)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
            1 => Box::new(
                AnthropicProvider::new("synthetic-key")
                    .unwrap()
                    .with_base_url(base)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
            2 => Box::new(
                GeminiProvider::new("synthetic-key", "owned-model")
                    .unwrap()
                    .with_base_url(base)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
            _ => Box::new(
                GenAiProvider::new("synthetic-key")
                    .unwrap()
                    .with_base_url(base)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
        };
        let stream = provider.stream_messages(MessagesRequest::new(
            "owned-model",
            vec![kcoder_types::Message::user_text("OWNED_PRIVATE_MODEL_BODY")],
        ));
        if let Ok(stream) = stream {
            let result = tokio::time::timeout(Duration::from_secs(3), stream.collect::<Vec<_>>())
                .await
                .unwrap();
            assert!(
                result.iter().any(Result::is_err),
                "adapter {adapter} must reject the redirect response"
            );
        }
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err(),
            "adapter {adapter} forwarded body outside its configured origin"
        );
    }
}
