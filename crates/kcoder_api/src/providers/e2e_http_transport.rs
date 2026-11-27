use crate::ApiErrorKind;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::{Client, Response, Url};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const ENDPOINT_ENV: &str = "KCODER_E2E_MODEL_TRANSPORT_URL";
const TOKEN_ENV: &str = "KCODER_E2E_MODEL_TRANSPORT_TOKEN";
static TEST_DRIVER_ENABLED: AtomicBool = AtomicBool::new(false);

pub(crate) struct E2eHttpTransport {
    endpoint: Url,
    authorization: HeaderValue,
    client: Client,
}

impl E2eHttpTransport {
    pub(crate) fn enable_for_test_driver() {
        TEST_DRIVER_ENABLED.store(true, Ordering::Release);
    }

    pub(crate) fn is_configured() -> bool {
        TEST_DRIVER_ENABLED.load(Ordering::Acquire)
            || std::env::var_os(ENDPOINT_ENV).is_some()
            || std::env::var_os(TOKEN_ENV).is_some()
    }

    pub(crate) fn unavailable_for_discovery() -> ApiErrorKind {
        configuration_error("model discovery is unavailable with the test transport enabled")
    }

    pub(crate) fn from_environment(timeout_secs: u64) -> Result<Option<Self>, ApiErrorKind> {
        let endpoint = std::env::var(ENDPOINT_ENV).ok();
        let token = std::env::var(TOKEN_ENV).ok();
        if !TEST_DRIVER_ENABLED.load(Ordering::Acquire) {
            return match (endpoint, token) {
                (None, None) => Ok(None),
                _ => Err(configuration_error(
                    "private model transport is available only in the dedicated test driver",
                )),
            };
        }
        match (endpoint, token) {
            (None, None) => Err(configuration_error(
                "dedicated model transport driver requires its private control URL and token",
            )),
            (Some(endpoint), Some(token)) => Self::new(&endpoint, &token, timeout_secs).map(Some),
            _ => Err(configuration_error(
                "both private model transport URL and token are required",
            )),
        }
    }

    fn new(endpoint: &str, token: &str, timeout_secs: u64) -> Result<Self, ApiErrorKind> {
        let endpoint = endpoint
            .parse::<Url>()
            .map_err(|_| configuration_error("private model transport URL is invalid"))?;
        if endpoint.scheme() != "http"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !is_loopback(&endpoint)
            || !endpoint.path().starts_with("/__control/")
            || !endpoint.path().ends_with("/transport")
        {
            return Err(configuration_error(
                "private model transport must use an authenticated loopback control URL",
            ));
        }

        if token.is_empty() {
            return Err(configuration_error(
                "private model transport token is empty",
            ));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| configuration_error("private model transport token is invalid"))?;
        authorization.set_sensitive(true);

        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(timeout_secs.max(1)))
            .build()?;

        Ok(Self {
            endpoint,
            authorization,
            client,
        })
    }

    pub(crate) async fn send(&self, body: Vec<u8>) -> Result<Response, ApiErrorKind> {
        self.client
            .post(self.endpoint.clone())
            .header(AUTHORIZATION, self.authorization.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(ApiErrorKind::Network)
    }
}

fn is_loopback(endpoint: &Url) -> bool {
    endpoint
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|address| address.is_loopback())
}

fn configuration_error(message: &str) -> ApiErrorKind {
    ApiErrorKind::SseStream {
        error_type: "e2e_transport_configuration".into(),
        message: message.into(),
        kind: crate::SseErrorKind::Parser,
    }
}

#[cfg(test)]
mod tests {
    use super::{E2eHttpTransport, is_loopback};
    use crate::ApiErrorKind;
    use std::io::{Read, Write};

    #[test]
    fn accepts_only_private_authenticated_loopback_control_urls() {
        let accepted = E2eHttpTransport::new(
            "http://127.0.0.1:49152/__control/scenario/operation/transport",
            "private-test-token",
            10,
        );
        assert!(accepted.is_ok());

        for endpoint in [
            "http://example.test/__control/scenario/operation/transport",
            "https://127.0.0.1/__control/scenario/operation/transport",
            "http://127.0.0.1/__control/scenario/operation/transport?token=secret",
            "http://127.0.0.1/v1/chat/completions",
        ] {
            assert!(
                E2eHttpTransport::new(endpoint, "private-test-token", 10).is_err(),
                "unexpectedly accepted {endpoint}"
            );
        }
    }

    #[test]
    fn rejects_missing_or_invalid_private_credentials() {
        let result = E2eHttpTransport::new(
            "http://127.0.0.1:49152/__control/scenario/operation/transport",
            "",
            10,
        );
        assert!(matches!(result, Err(ApiErrorKind::SseStream { .. })));
    }

    #[test]
    fn recognizes_only_literal_loopback_addresses() {
        for url in ["http://127.0.0.1:1/path", "http://[::1]:1/path"] {
            assert!(is_loopback(&url.parse().unwrap()));
        }
        assert!(!is_loopback(&"http://localhost:1/path".parse().unwrap()));
        assert!(!is_loopback(&"http://192.0.2.1:1/path".parse().unwrap()));
    }

    #[tokio::test]
    async fn sends_only_the_model_body_and_private_control_token() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 16 * 1024);
            }
            let header = String::from_utf8_lossy(&request);
            let content_length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|length| length.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let body_offset = request.len();
            request.resize(body_offset + content_length, 0);
            stream.read_exact(&mut request[body_offset..]).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            request
        });

        let transport = E2eHttpTransport::new(
            &format!("http://{address}/__control/scenario/operation/transport"),
            "private-control-token",
            5,
        )
        .unwrap();
        let body =
            br#"{"model":"fixture-model","messages":[{"role":"user","content":"fixture input"}]}"#
                .to_vec();
        let response = transport.send(body.clone()).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, actual_body) = request.split_once("\r\n\r\n").unwrap();
        let lowercase_headers = headers.to_ascii_lowercase();
        assert!(lowercase_headers.contains("authorization: bearer private-control-token"));
        assert!(!lowercase_headers.contains("provider-api-key"));
        assert_eq!(actual_body.as_bytes(), body);
    }
}
