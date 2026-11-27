use super::*;
use futures::StreamExt;
use kcoder_types::{ContentDelta, Message, MessagesRequest, StreamEvent};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn kunlunmeta_protocol_selection_keeps_its_endpoint_credentials_and_stream_decoder() {
    for (format, chat_protocol, path, credential_header, response) in [
        (
            ApiFormat::AnthropicMessages,
            "auto",
            "/v1/messages",
            "x-api-key: kunlunmeta-fixture",
            concat!(
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"fixture\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"fixture-model\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
            ),
        ),
        (
            ApiFormat::OpenaiChatCompletions,
            "minimax",
            "/v1/chat/completions",
            "authorization: bearer kunlunmeta-fixture",
            CHAT_RESPONSE,
        ),
        (
            ApiFormat::OpenaiChatCompletions,
            "standard",
            "/v1/chat/completions",
            "authorization: bearer kunlunmeta-fixture",
            CHAT_RESPONSE,
        ),
        (
            ApiFormat::OpenaiResponses,
            "auto",
            "/v1/responses",
            "authorization: bearer kunlunmeta-fixture",
            concat!(
                "event: response.output_text.delta\ndata: {\"delta\":\"OK\"}\n\n",
                "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n"
            ),
        ),
        (
            ApiFormat::GeminiGenerateContent,
            "auto",
            "/v1beta/models/fixture-model:streamGenerateContent?alt=sse",
            "x-goog-api-key: kunlunmeta-fixture",
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1,\"totalTokenCount\":4}}\n\n",
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        assert!(
                            headers.starts_with(&format!(
                                "post {} http/1.1",
                                path.to_ascii_lowercase()
                            )),
                            "{headers}"
                        );
                        assert!(headers.contains(credential_header), "{format:?}");
                        assert!(!headers.contains("unrelated-fixture"));
                        let body: serde_json::Value =
                            serde_json::from_slice(&bytes[end + 4..]).unwrap();
                        if format != ApiFormat::GeminiGenerateContent {
                            assert_eq!(body["model"], "fixture-model");
                            assert_eq!(body["stream"], true);
                        }
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        let endpoint = if matches!(
            format,
            ApiFormat::AnthropicMessages | ApiFormat::GeminiGenerateContent
        ) {
            origin.clone()
        } else {
            format!("{origin}/v1")
        };
        let mut settings = Settings::default();
        settings.providers.insert(
            "kunlunmeta".into(),
            serde_json::from_value(json!({
                "api_format":format,"endpoint":endpoint,"default_model":"fixture-model",
                "chat_protocol":chat_protocol,"no_proxy":true,
                "context_window_tokens":32000,"output_headroom_tokens":1024,"max_output_tokens":1024
            }))
            .unwrap(),
        );
        settings
            .stored_provider_credentials
            .insert("kunlunmeta".into(), "kunlunmeta-fixture".into());
        settings
            .stored_provider_credentials
            .insert("openai".into(), "unrelated-fixture".into());
        settings
            .stored_provider_credentials
            .insert("gemini".into(), "unrelated-fixture".into());
        settings.apply_provider(Some("kunlunmeta")).unwrap();
        let factory = ProviderFactory::new(&settings).with_overrides(ProviderBuildOverrides {
            base_url: Some(endpoint),
            openai_api_key: Some("unrelated-fixture".into()),
            gemini_api_key: Some("unrelated-fixture".into()),
            ..Default::default()
        });
        let (selector, credential) = factory
            .credential_resolution(ProviderKind::Kunlunmeta)
            .unwrap();
        assert_eq!(selector, "kunlunmeta");
        assert_eq!(credential.into_key(), "kunlunmeta-fixture");
        let provider = factory
            .build(ProviderKind::Kunlunmeta, "fixture-model")
            .unwrap();
        let events = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            provider
                .stream_messages(MessagesRequest::new(
                    "fixture-model",
                    vec![Message::user_text("Say OK")],
                ))
                .unwrap()
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(events.iter().all(Result::is_ok), "{format:?}: {events:?}");
        assert!(
            matches!(events.last(), Some(Ok(StreamEvent::MessageStop))),
            "{format:?}: {events:?}"
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                Ok(StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. })
                    if text == "OK"
            )),
            "{format:?}: {events:?}"
        );
    }
}

#[test]
fn kunlunmeta_protocol_changes_never_borrow_another_provider_key() {
    for format in [
        ApiFormat::AnthropicMessages,
        ApiFormat::OpenaiChatCompletions,
        ApiFormat::OpenaiResponses,
        ApiFormat::GeminiGenerateContent,
    ] {
        let settings = Settings {
            provider: Some("kunlunmeta".into()),
            api_format: Some(format),
            base_url: Some("http://127.0.0.1:1".into()),
            openai_api_key: Some("unrelated-fixture".into()),
            gemini_api_key: Some("unrelated-fixture".into()),
            ..Default::default()
        };
        let error = ProviderFactory::new(&settings)
            .build(ProviderKind::Kunlunmeta, "fixture-model")
            .err()
            .expect("kunlunmeta requires its own credential");
        assert!(error.downcast_ref::<MissingApiKeyError>().is_some());
        assert!(
            error
                .to_string()
                .contains("kcoder auth login --provider kunlunmeta")
        );
        assert!(!error.to_string().contains("unrelated-fixture"));
    }
}

const CHAT_RESPONSE: &str = concat!(
    "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"OK\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\n",
    "data: [DONE]\n\n"
);
