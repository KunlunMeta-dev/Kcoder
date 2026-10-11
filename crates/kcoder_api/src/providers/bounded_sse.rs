//! Bound a single SSE frame before the event parser buffers upstream bytes.
use futures::{Stream, StreamExt};
use std::pin::Pin;

const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error(transparent)]
    Network(#[from] reqwest::Error),
    #[error("Provider SSE event exceeds the 8 MiB byte limit")]
    TooLarge,
}

impl From<eventsource_stream::EventStreamError<Error>> for crate::SseErrorKind {
    fn from(error: eventsource_stream::EventStreamError<Error>) -> Self {
        use eventsource_stream::EventStreamError;
        match error {
            EventStreamError::Transport(Error::Network(error)) => {
                EventStreamError::<reqwest::Error>::Transport(error).into()
            }
            EventStreamError::Transport(Error::TooLarge) | EventStreamError::Parser(_) => {
                Self::Parser
            }
            EventStreamError::Utf8(_) => Self::Utf8,
        }
    }
}

struct FrameBudget {
    bytes: usize,
    line_empty: bool,
    previous_cr: bool,
    completed_on_cr: bool,
    limit: usize,
}

impl FrameBudget {
    fn new(limit: usize) -> Self {
        Self {
            bytes: 0,
            line_empty: true,
            previous_cr: false,
            completed_on_cr: false,
            limit,
        }
    }

    fn accept(&mut self, bytes: &[u8]) -> Result<(), Error> {
        for byte in bytes {
            // CRLF is one line ending, even when split across transport chunks.
            if self.previous_cr && *byte == b'\n' {
                self.previous_cr = false;
                if !self.completed_on_cr {
                    self.bytes += 1;
                    if self.bytes > self.limit {
                        return Err(Error::TooLarge);
                    }
                }
                continue;
            }
            self.previous_cr = *byte == b'\r';
            self.completed_on_cr = false;
            self.bytes += 1;
            if self.bytes > self.limit {
                return Err(Error::TooLarge);
            }
            if matches!(byte, b'\n' | b'\r') {
                if self.line_empty {
                    self.bytes = 0;
                    self.completed_on_cr = self.previous_cr;
                }
                self.line_empty = true;
            } else {
                self.line_empty = false;
            }
        }
        Ok(())
    }
}

pub(super) fn chunks<S, B>(stream: S) -> Pin<Box<dyn Stream<Item = Result<B, Error>> + Send>>
where
    S: Stream<Item = Result<B, reqwest::Error>> + Send + 'static,
    B: AsRef<[u8]> + Send + 'static,
{
    chunks_with_limit(stream, MAX_EVENT_BYTES)
}

fn chunks_with_limit<S, B>(
    stream: S,
    limit: usize,
) -> Pin<Box<dyn Stream<Item = Result<B, Error>> + Send>>
where
    S: Stream<Item = Result<B, reqwest::Error>> + Send + 'static,
    B: AsRef<[u8]> + Send + 'static,
{
    Box::pin(async_stream::try_stream! {
        futures::pin_mut!(stream);
        let mut budget = FrameBudget::new(limit);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            budget.accept(chunk.as_ref())?;
            yield chunk;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use eventsource_stream::Eventsource;

    #[tokio::test]
    async fn oversized_unterminated_frame_fails_before_parser_or_eof() {
        let input = futures::stream::iter([
            Ok::<_, reqwest::Error>(b"data: secret".to_vec()),
            Ok(vec![b'x'; 64]),
        ]);
        let mut events = chunks_with_limit(input, 32).eventsource();
        let error = events.next().await.unwrap().unwrap_err();
        assert!(!error.to_string().contains("secret"));
        assert_eq!(
            crate::SseErrorKind::from(error),
            crate::SseErrorKind::Parser
        );
        assert!(events.next().await.is_none());
    }

    #[tokio::test]
    async fn long_stream_of_bounded_frames_and_split_crlf_remains_incremental() {
        let mut parts = vec![];
        for _ in 0..100 {
            parts.extend([
                Ok::<_, reqwest::Error>(b"data: hello\r".to_vec()),
                Ok(b"\n\r".to_vec()),
                Ok(b"\n".to_vec()),
            ]);
        }
        let mut events = chunks_with_limit(futures::stream::iter(parts), 32).eventsource();
        let mut count = 0;
        while let Some(event) = events.next().await {
            assert_eq!(event.unwrap().data, "hello");
            count += 1;
        }
        assert_eq!(count, 100);
    }

    #[test]
    fn multiline_frames_and_comments_share_the_bound() {
        let mut budget = FrameBudget::new(16);
        assert!(budget.accept(b":1234\ndata:12\n").is_ok());
        assert!(budget.accept(b"data:more").is_err());
        for delimiter in [b"\n\n".as_slice(), b"\r\r", b"\r\n\r\n"] {
            let mut budget = FrameBudget::new(16);
            for _ in 0..100 {
                budget.accept(b"data:x").unwrap();
                budget.accept(delimiter).unwrap();
            }
        }
    }
}
