//! Bound non-streaming provider payloads before allocating or parsing upstream text.
use crate::ApiErrorKind;

pub(super) const ERROR_BODY_LIMIT: usize = 64 * 1024;
pub(super) const MODEL_LIST_LIMIT: usize = 2 * 1024 * 1024;

macro_rules! reader {
    ($name:ident, $response:ty) => {
        pub(super) async fn $name(
            mut response: $response,
            limit: usize,
        ) -> Result<String, ApiErrorKind> {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ApiErrorKind::Api {
                error_type: "provider_body_read_failed".into(),
                message: "Provider response body could not be read".into(),
            })? {
                if chunk.len() > limit.saturating_sub(bytes.len()) {
                    return Err(ApiErrorKind::Api {
                        error_type: "provider_body_limit".into(),
                        message: "Provider response body exceeds the configured byte limit".into(),
                    });
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    };
}
reader!(read, reqwest::Response);
reader!(read_genai, reqwest_genai::Response);

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn oversized_real_http_body_is_rejected_without_exposing_payload() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).await.unwrap();
                let body = "SYNTHETIC_PRIVATE_ERROR".repeat(ERROR_BODY_LIMIT / 10);
                let header = format!(
                    "HTTP/1.1 500 Failure\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                let _ = socket.write_all(body.as_bytes()).await;
            }
        });
        let url = format!("http://{address}/fixture");
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap();
        let error = read(response, ERROR_BODY_LIMIT).await.unwrap_err();
        assert!(
            matches!(&error, ApiErrorKind::Api { error_type, .. } if error_type == "provider_body_limit")
        );
        assert!(!format!("{error:?} {error}").contains("SYNTHETIC_PRIVATE_ERROR"));
        let response = reqwest_genai::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap();
        assert!(read_genai(response, ERROR_BODY_LIMIT).await.is_err());
        server.await.unwrap();
    }
}
