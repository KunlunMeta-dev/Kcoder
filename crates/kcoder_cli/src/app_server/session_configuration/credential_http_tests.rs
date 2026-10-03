//! Deterministic HTTP evidence; no external endpoint or real credential is used.
use super::*;
use clap::Parser;
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn assert_http_rotation(kind: ProviderKind, format: kcoder_config::ApiFormat) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut received = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (header_end, content_length) = loop {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0 && bytes.len() + n <= 65536);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < header_end + content_length {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0 && bytes.len() + n <= 65536);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap();
            received.push((headers, body));
            // A deliberate HTTP error terminates the call after request capture.
            // This test proves transport credentials, not model response parsing.
            let body = r#"{"error":{"type":"invalid_request_error","message":"fixture response"}}"#;
            socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
        }
        (listener, received)
    });
    let temp = tempfile::tempdir().unwrap();
    let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
    let paths = loader.paths().unwrap();
    let mut settings = Settings::default();
    settings.providers.clear();
    let mut profile = kcoder_config::default_active_provider_config();
    profile.api_format = format;
    profile.endpoint = format!("http://{address}/v1");
    profile.default_model = "fixture-model".into();
    profile.models.clear();
    profile.no_proxy = true;
    profile.extra_body = serde_json::from_value(serde_json::json!({"temperature":0.2})).unwrap();
    settings.providers.insert("fixture".into(), profile);
    settings
        .apply_discovered_model("fixture", "fixture-model")
        .unwrap();
    settings.credential_store = kcoder_config::CredentialStoreMode::File;
    let write_key = |key: &str| {
        std::fs::write(
            &paths.credentials,
            serde_json::json!({"fixture":{"type":"api","key":key}}).to_string(),
        )
        .unwrap();
    };
    write_key("fixture-old");
    loader
        .refresh_stored_provider_credentials(&mut settings)
        .unwrap();
    let config = SessionConfiguration::new(loader, crate::Cli::parse_from(["kcoder"]));
    let provider = config.provider_for_kind(&settings, kind).unwrap();
    let request = kcoder_types::MessagesRequest::new("fixture-model", vec![]).with_max_tokens(1234);
    for index in 0..2 {
        if index == 1 {
            write_key("fixture-new");
            // Credentials can refresh even while an unrelated settings edit is invalid.
            std::fs::write(&paths.user_settings, "invalid settings").unwrap();
        }
        let events = provider
            .stream_messages(request.clone())
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().any(Result::is_err));
    }
    let (listener, received) = server.await.unwrap();
    for ((headers, body), key) in received.iter().zip(["fixture-old", "fixture-new"]) {
        let expected = if kind == ProviderKind::Openai {
            format!("authorization: bearer {key}")
        } else {
            format!("x-api-key: {key}")
        };
        assert!(headers.to_ascii_lowercase().contains(&expected));
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["model"], "fixture-model");
    }
    assert_eq!(received[0].1, received[1].1);
    std::fs::write(&paths.credentials, "{}").unwrap();
    let mut denied = provider.stream_messages(request).unwrap();
    assert!(
        matches!(denied.next().await.unwrap(), Err(kcoder_api::ApiErrorKind::Api { error_type, .. }) if error_type == "authentication_error")
    );
    assert!(denied.next().await.is_none());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn openai_http_key_rotates_without_changing_body_and_revocation_sends_nothing() {
    tokio::time::timeout(
        Duration::from_secs(10),
        assert_http_rotation(
            ProviderKind::Openai,
            kcoder_config::ApiFormat::OpenaiChatCompletions,
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn anthropic_http_key_rotates_without_changing_body_and_revocation_sends_nothing() {
    tokio::time::timeout(
        Duration::from_secs(10),
        assert_http_rotation(
            ProviderKind::Anthropic,
            kcoder_config::ApiFormat::AnthropicMessages,
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn responses_http_key_rotates_without_changing_body_and_revocation_sends_nothing() {
    tokio::time::timeout(
        Duration::from_secs(10),
        assert_http_rotation(
            ProviderKind::Openai,
            kcoder_config::ApiFormat::OpenaiResponses,
        ),
    )
    .await
    .unwrap();
}
