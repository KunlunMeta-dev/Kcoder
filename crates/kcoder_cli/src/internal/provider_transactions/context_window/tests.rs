use super::*;
use kcoder_config::{ProviderConfig, Settings};
use serde_json::{Value, json};
use std::{collections::BTreeSet, io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};

const FIXTURE_TIMEOUT: Duration = Duration::from_secs(3);
const REDIRECT_OBSERVE_WINDOW: Duration = Duration::from_millis(250);

#[test]
fn runtime_url_preserves_v1_sibling_and_canonical_prefix() {
    assert_eq!(
        runtime_url("http://127.0.0.1:11434/v1").unwrap().as_str(),
        "http://127.0.0.1:11434/api/ps"
    );
    assert_eq!(
        runtime_url("https://ollama.example/prefix/ollama/v1/")
            .unwrap()
            .as_str(),
        "https://ollama.example/prefix/ollama/api/ps"
    );
}

#[test]
fn runtime_url_rejects_ambiguous_or_noncanonical_endpoints() {
    for endpoint in [
        "http://user@127.0.0.1:11434/v1",
        "http://user:pass@127.0.0.1:11434/v1",
        "http://127.0.0.1:11434/v1?token=ignored",
        "http://127.0.0.1:11434/v1#fragment",
        "http://127.0.0.1:11434/../v1",
        "http://127.0.0.1:11434/prefix/../v1",
        "http://127.0.0.1:11434/prefix%2Follama/v1",
        "http://127.0.0.1:11434/prefix%5collama/v1",
        "http://127.0.0.1:11434//v1",
        "http://127.0.0.1:11434/prefix//v1",
        "http://127.0.0.1:11434/v1//",
        "http://127.0.0.1:11434/v10",
        "http://127.0.0.1:11434/v1/chat/completions",
        "http://127.0.0.1:11434/ollama",
        "http://127.0.0.1:11434\\v1",
    ] {
        assert!(runtime_url(endpoint).is_none(), "accepted {endpoint}");
    }
}

#[test]
fn observed_window_matches_only_exact_unique_model_names() {
    let digest = digest();
    assert_eq!(
        observed_window(
            &ps(vec![row("qwen3.5:2b", "qwen3.5:2b", &digest, json!(4096))]),
            "qwen3.5:2b"
        ),
        Some(4096)
    );
    assert_eq!(
        observed_window(
            &ps(vec![row("qwen3.5:2b", "qwen3.5:2b", &digest, json!(4096))]),
            "qwen3.5:2b:latest"
        ),
        None
    );
    assert_eq!(
        observed_window(
            &ps(vec![row("qwen3.5:2b", "qwen3.5:2b", &digest, json!(4096))]),
            "Qwen3.5:2b"
        ),
        None
    );
    assert_eq!(
        observed_window(
            &ps(vec![row(
                "qwen:latest",
                "qwen:latest",
                &digest,
                json!(4096)
            )]),
            "qwen"
        ),
        Some(4096),
        "an omitted tag has only the documented :latest default"
    );
    assert_eq!(
        observed_window(
            &ps(vec![row(
                "library/qwen:latest",
                "library/qwen:latest",
                &digest,
                json!(4096)
            )]),
            "qwen"
        ),
        None,
        "do not infer namespace equivalence from a short model name"
    );
    assert_eq!(
        observed_window(
            &ps(vec![row(
                "qwen:latest",
                "qwen:latest",
                &digest,
                json!(4096)
            )]),
            "library/qwen"
        ),
        None
    );
    assert_eq!(
        observed_window(
            &ps(vec![
                row("qwen:latest", "qwen:latest", &digest, json!(4096)),
                row("qwen:latest", "qwen:latest", &digest, json!(8192)),
            ]),
            "qwen"
        ),
        None,
        "multiple candidate rows are ambiguous"
    );
}

#[test]
fn observed_window_requires_consistent_identity_digest_and_positive_integer_context() {
    let digest = digest();
    assert_eq!(
        observed_window(
            &ps(vec![row(
                "other:latest",
                "qwen:latest",
                &digest,
                json!(4096)
            )]),
            "qwen"
        ),
        None,
        "the response's name and model fields must not contradict each other"
    );

    let mut missing_digest = row("qwen:latest", "qwen:latest", &digest, json!(4096));
    missing_digest.as_object_mut().unwrap().remove("digest");
    let mut empty_digest = row("qwen:latest", "qwen:latest", &digest, json!(4096));
    empty_digest["digest"] = json!("");
    assert_eq!(observed_window(&ps(vec![missing_digest]), "qwen"), None);
    assert_eq!(observed_window(&ps(vec![empty_digest]), "qwen"), None);

    for context in [json!(0), json!(-1), json!(4096.5), json!("4096")] {
        assert_eq!(
            observed_window(
                &ps(vec![row("qwen:latest", "qwen:latest", &digest, context)]),
                "qwen"
            ),
            None
        );
    }

    assert_eq!(
        observed_window(
            &json!({"models": [], "model_info": {"qwen.context_length": 131072}}),
            "qwen"
        ),
        None,
        "training model_info is not a loaded-runtime observation"
    );
}

#[tokio::test]
async fn observe_gets_api_ps_without_credentials_and_preserves_settings() {
    let response_body = valid_ps_body(4096);
    let fixture = start_fixture(TestResponse::json(200, response_body), None).await;
    let mut settings = settings(&format!("{}/prefix/v1", fixture.base_url), "qwen:latest");
    settings
        .providers
        .get_mut("owned_ollama_test")
        .unwrap()
        .authentication = serde_json::from_value(json!({"mode":"api_key"})).unwrap();
    settings.stored_provider_credentials.insert(
        "owned_ollama_test".into(),
        "PRIVATE_PROVIDER_KEY_MUST_NOT_REACH_METADATA".into(),
    );
    settings.apply_provider(Some("owned_ollama_test")).unwrap();
    settings.context_window_tokens = Some(32768);
    settings.provider_no_proxy = true;
    let before = serde_json::to_value(&settings).unwrap();
    let before_proxy_url = settings.provider_proxy_url.clone();

    let observed = observe(&settings).await;
    let requests = fixture.finish().await;

    assert_eq!(observed, Some(4096));
    assert_eq!(settings.context_window_tokens, Some(32768));
    assert_eq!(settings.provider_proxy_url, before_proxy_url);
    assert_eq!(serde_json::to_value(&settings).unwrap(), before);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].target, "/prefix/api/ps");
    assert_no_provider_auth_headers(&requests[0]);
}

#[tokio::test]
async fn observe_uses_the_configured_provider_proxy() {
    let fixture = start_fixture(TestResponse::json(200, valid_ps_body(4096)), None).await;
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_address = target.local_addr().unwrap();

    let mut settings = settings(&format!("http://{target_address}/v1"), "qwen:latest");
    settings.provider_no_proxy = false;
    settings.provider_proxy_url = Some(fixture.base_url.clone());

    let observed = observe(&settings).await;
    let requests = fixture.finish().await;

    assert_eq!(observed, Some(4096));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    let target_url = reqwest::Url::parse(&requests[0].target).unwrap();
    assert_eq!(target_url.host_str(), Some("127.0.0.1"));
    assert_eq!(target_url.port(), Some(target_address.port()));
    assert_eq!(target_url.path(), "/api/ps");
    assert_no_provider_auth_headers(&requests[0]);
}

#[tokio::test]
async fn observe_does_not_follow_redirects() {
    let first = TestResponse {
        status: 302,
        headers: vec![("Location".into(), "/followed".into())],
        body: Vec::new(),
        chunked: false,
    };
    let fixture = start_fixture(first, Some(TestResponse::json(200, valid_ps_body(4096)))).await;
    let settings = settings(&format!("{}/v1", fixture.base_url), "qwen:latest");

    assert_eq!(observe(&settings).await, None);
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].target, "/api/ps");
}

#[tokio::test]
async fn observe_rejects_http_errors_invalid_json_and_responses_over_64kib() {
    let cases = [
        TestResponse::json(404, valid_ps_body(4096)),
        TestResponse::json(200, b"not-json".to_vec()),
        TestResponse::chunked(200, vec![b'x'; MAX_RESPONSE_BYTES + 1]),
    ];
    for response in cases {
        let fixture = start_fixture(response, None).await;
        let settings = settings(&format!("{}/v1", fixture.base_url), "qwen:latest");
        assert_eq!(observe(&settings).await, None);
        let requests = fixture.finish().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].target, "/api/ps");
        assert_no_provider_auth_headers(&requests[0]);
    }
}

fn settings(endpoint: &str, model: &str) -> Settings {
    let profile: ProviderConfig = serde_json::from_value(json!({
        "api_format": "openai_chat_completions",
        "endpoint": endpoint,
        "default_model": model,
        "authentication": {"mode": "none"},
        "context_window_tokens": 32768,
        "output_headroom_tokens": 4096,
        "max_output_tokens": 4096,
        "no_proxy": true
    }))
    .unwrap();
    let mut settings = Settings::default();
    settings
        .providers
        .insert("owned_ollama_test".into(), profile);
    settings.apply_provider(Some("owned_ollama_test")).unwrap();
    settings
}

fn digest() -> String {
    "a".repeat(64)
}

fn row(name: &str, model: &str, digest: &str, context_length: Value) -> Value {
    json!({
        "name": name,
        "model": model,
        "digest": digest,
        "runner": "llama",
        "context_length": context_length
    })
}

fn ps(models: Vec<Value>) -> Value {
    json!({ "models": models })
}

fn valid_ps_body(context_length: u64) -> Vec<u8> {
    serde_json::to_vec(&ps(vec![row(
        "qwen:latest",
        "qwen:latest",
        &digest(),
        json!(context_length),
    )]))
    .unwrap()
}

struct TestResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    chunked: bool,
}

impl TestResponse {
    fn json(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body,
            chunked: false,
        }
    }

    fn chunked(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body,
            chunked: true,
        }
    }
}

#[derive(Debug)]
struct RecordedRequest {
    method: String,
    target: String,
    header_names: BTreeSet<String>,
}

struct Fixture {
    base_url: String,
    task: Option<JoinHandle<Vec<RecordedRequest>>>,
}

impl Fixture {
    async fn finish(mut self) -> Vec<RecordedRequest> {
        let mut task = self.task.take().unwrap();
        match timeout(FIXTURE_TIMEOUT, &mut task).await {
            Ok(Ok(requests)) => requests,
            Ok(Err(error)) => panic!("owned HTTP fixture failed: {error}"),
            Err(_) => {
                task.abort();
                let _ = task.await;
                panic!("owned HTTP fixture did not finish within its bound");
            }
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn start_fixture(first: TestResponse, follow: Option<TestResponse>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        let (mut stream, _) = timeout(FIXTURE_TIMEOUT, listener.accept())
            .await
            .expect("fixture accept timed out")
            .expect("fixture accept failed");
        requests.push(read_request(&mut stream).await);
        write_response(&mut stream, &first).await.unwrap();

        if let Some(follow_response) = follow
            && let Ok(Ok((mut stream, _))) =
                timeout(REDIRECT_OBSERVE_WINDOW, listener.accept()).await
        {
            requests.push(read_request(&mut stream).await);
            write_response(&mut stream, &follow_response).await.unwrap();
        }
        requests
    });
    Fixture {
        base_url: format!("http://{address}"),
        task: Some(task),
    }
}

async fn read_request(stream: &mut TcpStream) -> RecordedRequest {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0_u8; 2048];
        let count = timeout(FIXTURE_TIMEOUT, stream.read(&mut chunk))
            .await
            .expect("fixture request read timed out")
            .expect("fixture request read failed");
        assert_ne!(count, 0, "fixture connection closed before request headers");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(
            bytes.len() <= 16 * 1024,
            "fixture request headers exceeded bound"
        );
        let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = head.lines();
        let mut request_line = lines.next().unwrap_or_default().split_whitespace();
        let method = request_line.next().unwrap_or_default().to_owned();
        let target = request_line.next().unwrap_or_default().to_owned();
        let header_names = lines
            .filter_map(|line| {
                line.split_once(':')
                    .map(|(name, _)| name.trim().to_ascii_lowercase())
            })
            .collect();
        return RecordedRequest {
            method,
            target,
            header_names,
        };
    }
}

async fn write_response(stream: &mut TcpStream, response: &TestResponse) -> io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        302 => "Found",
        404 => "Not Found",
        _ => "Fixture",
    };
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        response.status, reason
    );
    for (name, value) in &response.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    if response.chunked {
        head.push_str("Transfer-Encoding: chunked\r\n\r\n");
        stream.write_all(head.as_bytes()).await?;
        stream
            .write_all(format!("{:X}\r\n", response.body.len()).as_bytes())
            .await?;
        stream.write_all(&response.body).await?;
        stream.write_all(b"\r\n0\r\n\r\n").await
    } else {
        head.push_str(&format!("Content-Length: {}\r\n\r\n", response.body.len()));
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&response.body).await
    }
}

fn assert_no_provider_auth_headers(request: &RecordedRequest) {
    for name in ["authorization", "api-key", "x-api-key"] {
        assert!(
            !request.header_names.contains(name),
            "unexpected {name} header"
        );
    }
}
