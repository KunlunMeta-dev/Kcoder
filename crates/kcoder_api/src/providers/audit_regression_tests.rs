use super::*;
use crate::{ApiErrorKind, NonHttpErrorClass};
use futures::StreamExt;
use kcoder_types::{ContentDelta, Message, MessagesRequest, StreamEvent};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn fixture(
    status: u16,
    body: &str,
) -> (String, Arc<Mutex<Vec<u8>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let request = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&request);
    let response = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        *captured.lock().unwrap() = super::http_fixture::read_request(&mut socket).await;
        let _ = socket.write_all(response.as_bytes()).await;
    });
    (endpoint, request, server)
}
fn request() -> MessagesRequest {
    MessagesRequest::new("fixture", vec![Message::user_text("owned fixture")])
}
async fn collect(provider: &dyn Provider) -> Vec<Result<StreamEvent, ApiErrorKind>> {
    tokio::time::timeout(
        Duration::from_secs(3),
        provider.stream_messages(request()).unwrap().collect(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn gemini_authentication_and_trailing_slash_are_consistent() {
    for operation in ["prewarm", "discovery", "stream"] {
        let body = match operation {
            "discovery" => r#"{"models":[{"name":"models/fixture"}]}"#,
            "stream" => "data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n",
            _ => "",
        };
        let (url, captured, server) = fixture(200, body).await;
        let provider = GeminiProvider::new("owned-secret", "fixture")
            .unwrap()
            .with_base_url(format!("{url}/"))
            .with_no_proxy(true)
            .unwrap();
        match operation {
            "prewarm" => provider.prewarm().await,
            "discovery" => {
                provider
                    .discover_models(ModelDiscoveryOptions {
                        timeout: Duration::from_secs(2),
                        max_models: 2,
                    })
                    .await
                    .unwrap();
            }
            _ => {
                assert!(collect(&provider).await.iter().all(Result::is_ok));
            }
        }
        super::http_fixture::join(server).await;
        let raw = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        let line = raw.lines().next().unwrap();
        assert!(
            !line.contains("owned-secret"),
            "credential must not enter request target"
        );
        assert!(
            !line.contains("//v1beta"),
            "base slash must not change the API path"
        );
        assert!(
            raw.to_ascii_lowercase()
                .contains("x-goog-api-key: owned-secret")
        );
    }
}

#[tokio::test]
async fn gemini_eof_is_incomplete_and_messageless_errors_are_terminal() {
    for body in [
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\n",
        "data: {\"error\":{\"code\":503,\"status\":\"UNAVAILABLE\"}}\n\n",
    ] {
        let (url, _, server) = fixture(200, body).await;
        let provider = GeminiProvider::new("fixture", "fixture")
            .unwrap()
            .with_base_url(url)
            .with_no_proxy(true)
            .unwrap();
        let events = collect(&provider).await;
        super::http_fixture::join(server).await;
        assert!(
            matches!(events.last(),Some(Err(error)) if error.non_http_error_class()==Some(NonHttpErrorClass::Transient)),
            "{events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(StreamEvent::MessageStop)))
        );
    }
}

#[tokio::test]
async fn gemini_thought_summary_is_not_visible_answer_and_stop_reason_occurs_once() {
    let body = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"summary\",\"thought\":true},{\"text\":\"answer\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":3}}\n\n";
    let (url, _, server) = fixture(200, body).await;
    let provider = GeminiProvider::new("fixture", "fixture")
        .unwrap()
        .with_base_url(url)
        .with_no_proxy(true)
        .unwrap();
    let events = collect(&provider).await;
    super::http_fixture::join(server).await;
    let visible: String = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(visible, "answer");
    assert!(events.iter().any(|event|matches!(event,Ok(StreamEvent::ContentBlockDelta{delta:ContentDelta::ThinkingDelta{thinking},..})if thinking=="summary")));
    assert_eq!(events.iter().filter(|event|matches!(event,Ok(StreamEvent::MessageDelta{delta})if delta.stop_reason.is_some())).count(),1);
}

#[tokio::test]
async fn anthropic_parse_error_cannot_publish_later_buffered_success() {
    let body = "event: content_block_delta\ndata: {malformed}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    let (url, _, server) = fixture(200, body).await;
    let provider = AnthropicProvider::new("fixture")
        .unwrap()
        .with_base_url(url)
        .with_no_proxy(true)
        .unwrap();
    let events = collect(&provider).await;
    super::http_fixture::join(server).await;
    assert_eq!(
        events.len(),
        1,
        "parse failure must terminate the provider stream"
    );
    assert!(events[0].is_err());
}

#[tokio::test]
async fn anthropic_explicit_error_is_terminal_and_duplicate_stop_is_not_emitted() {
    for (body, error) in [
        (
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"PRIVATE_ERROR_CANARY\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            true,
        ),
        (
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            false,
        ),
    ] {
        let (url, _, server) = fixture(200, body).await;
        let provider = AnthropicProvider::new("owned-fixture")
            .unwrap()
            .with_base_url(url)
            .with_no_proxy(true)
            .unwrap();
        let events = collect(&provider).await;
        super::http_fixture::join(server).await;
        assert_eq!(events.len(), 1);
        if error {
            assert!(
                matches!(&events[0], Ok(StreamEvent::Error { error }) if error.error_type == "overloaded_error"
                && !error.safe_summary().contains("CANARY"))
            );
        } else {
            assert!(matches!(&events[0], Ok(StreamEvent::MessageStop)));
        }
    }
}

#[tokio::test]
async fn dropping_partial_native_and_sdk_streams_releases_only_their_owned_http_socket() {
    for kind in ["anthropic", "gemini", "sdk"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let prefix = match kind {
            "anthropic" => concat!(
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"owned\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"fixture\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
            ),
            "gemini" => {
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\n"
            }
            _ => {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n"
            }
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            super::http_fixture::read_request(&mut socket).await;
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            socket.write_all(header.as_bytes()).await.unwrap();
            socket
                .write_all(format!("{:x}\r\n{prefix}\r\n", prefix.len()).as_bytes())
                .await
                .unwrap();
            let mut byte = [0; 1];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let provider: Box<dyn Provider> = match kind {
            "anthropic" => Box::new(
                AnthropicProvider::new("fixture")
                    .unwrap()
                    .with_base_url(url)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
            "gemini" => Box::new(
                GeminiProvider::new("fixture", "gemini-fixture")
                    .unwrap()
                    .with_base_url(url)
                    .with_no_proxy(true)
                    .unwrap(),
            ),
            _ => Box::new(
                GenAiProvider::new("fixture")
                    .unwrap()
                    .with_base_url(format!("{url}/v1"))
                    .with_no_proxy(true)
                    .unwrap(),
            ),
        };
        let model = if kind == "sdk" { "gpt-4o" } else { "fixture" };
        let mut stream = provider
            .stream_messages(MessagesRequest::new(
                model,
                vec![Message::user_text("owned partial request")],
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = stream.next().await.expect("partial response").unwrap();
                assert!(!matches!(event, StreamEvent::MessageStop));
                if matches!(
                    event,
                    StreamEvent::ContentBlockDelta {
                        delta: ContentDelta::TextDelta { .. },
                        ..
                    }
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        drop(stream);
        super::http_fixture::join(server).await;
    }
}

#[tokio::test]
async fn send_path_connection_close_is_transient_without_string_matching() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/private?key=owned-secret",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        super::http_fixture::read_request(&mut socket).await;
    });
    let error = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(endpoint)
        .body("request")
        .send()
        .await
        .unwrap_err();
    super::http_fixture::join(server).await;
    assert!(error.is_request());
    let error = ApiErrorKind::Network(error);
    assert_eq!(
        error.non_http_error_class(),
        Some(NonHttpErrorClass::Transient)
    );
    assert!(!format!("{error:?} {error}").contains("owned-secret"));
}

#[tokio::test]
async fn sdk_send_path_connection_close_is_transient_without_exposing_its_url() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/PRIVATE_URL_CANARY/v1",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        super::http_fixture::read_request(&mut socket).await;
    });
    let provider = GenAiProvider::new("PRIVATE_KEY_CANARY")
        .unwrap()
        .with_base_url(url)
        .with_no_proxy(true)
        .unwrap();
    let events = tokio::time::timeout(
        Duration::from_secs(3),
        provider
            .stream_messages(MessagesRequest::new(
                "gpt-4o",
                vec![Message::user_text("owned request")],
            ))
            .unwrap()
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    super::http_fixture::join(server).await;
    assert_eq!(events.len(), 1);
    let error = events.into_iter().next().unwrap().unwrap_err();
    assert!(!format!("{error:?} {error}").contains("CANARY"));
    assert_eq!(
        error.non_http_error_class(),
        Some(NonHttpErrorClass::Transient)
    );
}

#[tokio::test]
async fn factory_default_sdk_usage_tail_updates_a_prior_cumulative_snapshot_and_explicit_cache_zero()
 {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":1}}}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6,\"total_tokens\":10,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\n",
        "data: [DONE]\n\n",
    );
    let (url, _, server) = fixture(200, body).await;
    let settings = kcoder_config::Settings {
        provider_no_proxy: true,
        request_timeout_secs: Some(3),
        ..Default::default()
    };
    assert!(
        settings.api_format.is_none(),
        "exercise the default standard OpenAI factory route"
    );
    let provider = crate::provider_factory::ProviderFactory::new(&settings)
        .with_overrides(crate::provider_factory::ProviderBuildOverrides {
            openai_api_key: Some("owned-fixture".into()),
            openai_base_url: Some(format!("{url}/v1")),
            ..Default::default()
        })
        .build(crate::provider_factory::ProviderKind::Openai, "gpt-4o")
        .unwrap();
    let events = tokio::time::timeout(
        Duration::from_secs(3),
        provider
            .stream_messages(MessagesRequest::new(
                "gpt-4o",
                vec![Message::user_text("owned request")],
            ))
            .unwrap()
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    super::http_fixture::join(server).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, Ok(StreamEvent::MessageStop)))
            .count(),
        1
    );
    let usage = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::MessageDelta { delta }) => delta.usage.as_ref(),
            _ => None,
        })
        .next_back()
        .unwrap();
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (4, 6, Some(10))
    );
    assert_eq!(usage.cache_read_input_tokens, Some(0));
}

#[tokio::test]
async fn discovery_http_status_survives_an_oversized_error_body() {
    for status in [401, 429, 529] {
        for sdk in [false, true] {
            let (url, _, server) = fixture(
                status,
                &"x".repeat(super::bounded_body::MODEL_LIST_LIMIT + 1),
            )
            .await;
            let error = if sdk {
                GenAiProvider::new("fixture")
                    .unwrap()
                    .with_base_url(url)
                    .with_no_proxy(true)
                    .unwrap()
                    .discover_models(ModelDiscoveryOptions {
                        timeout: Duration::from_secs(3),
                        max_models: 2,
                    })
                    .await
                    .unwrap_err()
            } else {
                let response = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(url)
                    .send()
                    .await
                    .unwrap();
                super::parse_model_list_response(response, 2)
                    .await
                    .unwrap_err()
            };
            super::http_fixture::join(server).await;
            assert!(matches!(error,ApiErrorKind::Http{metadata,..}if metadata.status==status));
        }
    }
}

#[tokio::test]
async fn bounded_body_transport_read_failure_retains_a_transient_class() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        super::http_fixture::read_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort")
            .await
            .unwrap();
    });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    let error = super::bounded_body::read(response, 1024).await.unwrap_err();
    super::http_fixture::join(server).await;
    assert_eq!(
        error.non_http_error_class(),
        Some(NonHttpErrorClass::Transient)
    );
}

#[tokio::test]
async fn gemini_messageless_error_preserves_business_classification() {
    let body = "data: {\"error\":{\"code\":503,\"status\":\"UNAVAILABLE\"}}\n\ndata: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n";
    let (url, _, server) = fixture(200, body).await;
    let provider = GeminiProvider::new("fixture", "fixture")
        .unwrap()
        .with_base_url(url)
        .with_no_proxy(true)
        .unwrap();
    let events = collect(&provider).await;
    super::http_fixture::join(server).await;
    assert_eq!(
        events.len(),
        1,
        "provider error is terminal before any later success"
    );
    assert!(
        matches!(&events[0],Err(ApiErrorKind::Api{error_type,..})if error_type=="overloaded_error")
    );
}

#[tokio::test]
async fn duplicate_wire_tool_index_terminates_without_completing_the_tool() {
    let body = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"first\",\"name\":\"read\",\"input\":{}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"second\",\"name\":\"read\",\"input\":{}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    let (url, _, server) = fixture(200, body).await;
    let provider = AnthropicProvider::new("fixture")
        .unwrap()
        .with_base_url(url)
        .with_no_proxy(true)
        .unwrap();
    let events = collect(&provider).await;
    super::http_fixture::join(server).await;
    assert!(
        matches!(events.last(),Some(Err(ApiErrorKind::Api{error_type,..}))if error_type=="provider_protocol_error")
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::MessageStop | StreamEvent::ContentBlockStop { .. })
    )));
}
