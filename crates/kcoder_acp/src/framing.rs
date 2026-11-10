use anyhow::Result;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(crate) const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

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
