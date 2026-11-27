use anyhow::Result;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(crate) const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn is_request_id(id: &serde_json::Value) -> bool {
    id.is_null() || id.is_string() || id.is_i64()
}

pub(crate) fn is_native_request_id(id: &serde_json::Value) -> bool {
    id.is_string() || id.is_i64() || id.is_u64()
}

pub(crate) enum Frame {
    Json(serde_json::Value),
    Invalid,
    TooLarge,
}

/// Retain partial input when `next` loses a select race to cancellation or output.
pub(crate) struct FrameReader<R> {
    reader: R,
    bytes: Vec<u8>,
    oversized: bool,
}

impl<R: AsyncBufRead + Unpin> FrameReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            bytes: Vec::new(),
            oversized: false,
        }
    }

    /// Drain an invalid frame through its newline without losing the next frame.
    pub(crate) async fn next(&mut self) -> Result<Option<Frame>> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                if self.bytes.is_empty() && !self.oversized {
                    return Ok(None);
                }
                break;
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let size = newline.unwrap_or(available.len());
            if !self.oversized {
                if self.bytes.len().saturating_add(size) > MAX_FRAME_BYTES {
                    self.oversized = true;
                    self.bytes.clear();
                } else {
                    self.bytes.extend_from_slice(&available[..size]);
                }
            }
            self.reader.consume(size + usize::from(newline.is_some()));
            if newline.is_some() {
                break;
            }
        }
        if std::mem::take(&mut self.oversized) {
            return Ok(Some(Frame::TooLarge));
        }
        let parsed = serde_json::from_slice(&self.bytes);
        self.bytes.clear();
        Ok(Some(match parsed {
            Ok(value) => Frame::Json(value),
            Err(_) => Frame::Invalid,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn standard_request_id_shape_matches_the_locked_acp_schema() {
        for id in [
            serde_json::Value::Null,
            serde_json::json!("request"),
            serde_json::json!(i64::MIN),
            serde_json::json!(i64::MAX),
            serde_json::json!(u64::MAX),
            serde_json::json!(1.0),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::json!({"id": 1}),
        ] {
            assert_eq!(
                is_request_id(&id),
                serde_json::from_value::<agent_client_protocol_schema::rpc::RequestId>(id.clone())
                    .is_ok(),
                "{id}"
            );
        }
        assert!(!is_native_request_id(&serde_json::Value::Null));
        assert!(is_native_request_id(&serde_json::json!(u64::MAX)));
    }

    #[tokio::test]
    async fn malformed_and_oversized_frames_do_not_destroy_the_next_request() {
        let mut bytes = vec![b'x'; MAX_FRAME_BYTES + 1];
        bytes.extend_from_slice(b"\n\xff\n{\"id\":\"next\"}\n");
        let mut reader = FrameReader::new(BufReader::with_capacity(31, bytes.as_slice()));
        assert!(matches!(
            reader.next().await.unwrap(),
            Some(Frame::TooLarge)
        ));
        assert!(matches!(reader.next().await.unwrap(), Some(Frame::Invalid)));
        let Some(Frame::Json(value)) = reader.next().await.unwrap() else {
            panic!("missing recovered frame")
        };
        assert_eq!(value["id"], "next");
        assert!(reader.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cancelled_read_preserves_a_partial_utf8_frame() {
        use tokio::io::AsyncWriteExt;
        let (mut input, output) = tokio::io::duplex(1024);
        let mut reader = FrameReader::new(BufReader::with_capacity(3, output));
        input.write_all(b"{\"text\":\"").await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), reader.next())
                .await
                .is_err()
        );
        input.write_all("中文🙂\"}\n".as_bytes()).await.unwrap();
        let Some(Frame::Json(frame)) = reader.next().await.unwrap() else {
            panic!("lost partial frame")
        };
        assert_eq!(frame["text"], "中文🙂");
    }
}
