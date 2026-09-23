//! SSE line parsing and stream-consumption utilities shared by legacy dual-endpoint
//! HTTP+SSE `SseTransport` and single-endpoint `StreamableHttpTransport`.

use futures::StreamExt;
use tracing::warn;

/// Internal transport failure marker, never a JSON-RPC frame.
pub(crate) const FRAME_LIMIT_ERROR: &str = "\0kcoder.mcp.frame_limit";

pub(crate) const MAX_MCP_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Capacity of the transport message queue; existing overflow policy is unchanged.
pub(crate) const SSE_MESSAGE_QUEUE_CAPACITY: usize = 1024;

pub(crate) enum SseEvent {
    Endpoint(String),
    Message(String),
    Comment,
    Empty,
    LimitExceeded,
}

#[derive(Default)]
pub(crate) struct SseParser {
    event_type: Option<String>,
    data_lines: Vec<String>,
    data_bytes: usize,
    exceeded: bool,
}

impl SseParser {
    /// Consume one decoded SSE line. Events are dispatched only on the blank
    /// separator, and multiple `data:` fields are joined with `\n` as
    /// required by the EventSource format.
    pub(crate) fn push_line(&mut self, line: &str) -> Option<SseEvent> {
        if self.exceeded {
            return Some(SseEvent::LimitExceeded);
        }
        self.data_bytes = self.data_bytes.saturating_add(line.len() + 1);
        if self.data_bytes > MAX_MCP_FRAME_BYTES {
            self.data_lines.clear();
            self.exceeded = true;
            return Some(SseEvent::LimitExceeded);
        }
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        if let Some(value) = line.strip_prefix("event:") {
            self.event_type = Some(strip_optional_sse_space(value).to_string());
            return None;
        }
        if let Some(value) = line.strip_prefix("data:") {
            self.data_lines
                .push(strip_optional_sse_space(value).to_string());
            return None;
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        self.data_bytes = 0;
        let event_type = self.event_type.take();
        if self.data_lines.is_empty() {
            return Some(SseEvent::Empty);
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        match event_type.as_deref() {
            Some("endpoint") => Some(SseEvent::Endpoint(data)),
            Some("message") | None => {
                // Some legacy MCP SSE servers omit `event: endpoint`. Keep
                // compatibility only for the default event type; an explicit
                // `event: message` containing URL-shaped data is still a
                // message.
                if event_type.is_none()
                    && (data.starts_with('/')
                        || data.starts_with("http://")
                        || data.starts_with("https://"))
                {
                    Some(SseEvent::Endpoint(data))
                } else {
                    Some(SseEvent::Message(data))
                }
            }
            Some(_) => Some(SseEvent::Comment),
        }
    }
}

fn strip_optional_sse_space(value: &str) -> &str {
    value.strip_prefix(' ').unwrap_or(value)
}

pub(crate) async fn drain_sse_stream(
    mut stream: impl futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
    mut buffer: Vec<u8>,
    mut parser: SseParser,
    tx: tokio::sync::mpsc::Sender<String>,
) {
    // The handshake can stop in the middle of a chunk as soon as it sees the
    // endpoint. Deliver any complete events already buffered before waiting
    // for another network chunk, which might not arrive for a long time.
    drain_sse_buffer(&mut buffer, &mut parser, &tx);
    if parser.exceeded {
        return;
    }
    while let Some(chunk) = stream.next().await {
        if let Ok(chunk) = chunk {
            if buffer.len().saturating_add(chunk.len()) > MAX_MCP_FRAME_BYTES {
                enqueue_sse_message(&tx, FRAME_LIMIT_ERROR.into());
                return;
            }
            // Keep raw bytes until a full line is available. Decoding each
            // network chunk separately corrupts UTF-8 code points split at a
            // chunk boundary.
            buffer.extend_from_slice(&chunk);
            if chunk.contains(&b'\n') {
                drain_sse_buffer(&mut buffer, &mut parser, &tx);
            }
            if parser.exceeded {
                return;
            }
        }
    }
}

pub(crate) fn drain_sse_buffer(
    buffer: &mut Vec<u8>,
    parser: &mut SseParser,
    tx: &tokio::sync::mpsc::Sender<String>,
) {
    while let Some(line) = pop_line(buffer) {
        match parser.push_line(&line) {
            Some(SseEvent::Message(data)) => enqueue_sse_message(tx, data),
            Some(SseEvent::LimitExceeded) => {
                enqueue_sse_message(tx, FRAME_LIMIT_ERROR.into());
                buffer.clear();
                return;
            }
            _ => {}
        }
    }
}

pub(crate) fn enqueue_sse_message(tx: &tokio::sync::mpsc::Sender<String>, data: String) {
    match tx.try_send(data) {
        Ok(()) => {}
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            warn!("MCP SSE message queue is full; dropping message");
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            warn!("MCP SSE message queue is closed; dropping message");
        }
    }
}

pub(crate) fn pop_line(buffer: &mut Vec<u8>) -> Option<String> {
    let idx = buffer.iter().position(|byte| *byte == b'\n')?;
    let mut line = buffer.drain(..=idx).collect::<Vec<_>>();
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Some(String::from_utf8_lossy(&line).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_endpoint_event() {
        let mut parser = SseParser::default();
        assert!(parser.push_line("event: endpoint").is_none());
        assert!(parser.push_line("data: /messages").is_none());
        assert!(matches!(
            parser.push_line(""),
            Some(SseEvent::Endpoint(path)) if path == "/messages"
        ));
    }

    #[test]
    fn parse_sse_message_event() {
        let mut parser = SseParser::default();
        assert!(parser.push_line("event: message").is_none());
        assert!(parser.push_line("data: {\"jsonrpc\":\"2.0\"}").is_none());
        assert!(matches!(
            parser.push_line(""),
            Some(SseEvent::Message(payload)) if payload == "{\"jsonrpc\":\"2.0\"}"
        ));
    }

    #[test]
    fn parse_sse_comment_and_empty() {
        let mut parser = SseParser::default();
        assert!(parser.push_line(":comment").is_none());
        assert!(matches!(parser.push_line(""), Some(SseEvent::Empty)));
    }

    #[test]
    fn parse_sse_joins_multiline_data_at_event_boundary() {
        let mut parser = SseParser::default();
        assert!(parser.push_line("event: message").is_none());
        assert!(parser.push_line("data: {\"jsonrpc\":").is_none());
        assert!(parser.push_line("data: \"2.0\"}").is_none());
        assert!(matches!(
            parser.push_line(""),
            Some(SseEvent::Message(payload)) if payload == "{\"jsonrpc\":\n\"2.0\"}"
        ));
    }

    #[test]
    fn explicit_message_event_cannot_be_reclassified_as_endpoint() {
        let mut parser = SseParser::default();
        parser.push_line("event: message");
        parser.push_line("data: https://example.test/payload");
        assert!(matches!(
            parser.push_line(""),
            Some(SseEvent::Message(payload)) if payload == "https://example.test/payload"
        ));
    }

    #[test]
    fn drain_delivers_message_already_buffered_after_handshake_endpoint() {
        let mut parser = SseParser::default();
        parser.push_line("event: endpoint");
        parser.push_line("data: /messages");
        assert!(matches!(parser.push_line(""), Some(SseEvent::Endpoint(_))));
        let mut buffer = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n".to_vec();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);

        drain_sse_buffer(&mut buffer, &mut parser, &tx);

        assert_eq!(rx.try_recv().unwrap(), "{\"jsonrpc\":\"2.0\",\"id\":1}");
        assert!(buffer.is_empty());
    }

    #[test]
    fn raw_line_buffer_preserves_utf8_split_across_network_chunks() {
        let payload = "data: {\"text\":\"昆仑\"}\n\n".as_bytes();
        let split = payload
            .windows(3)
            .position(|window| window == "昆".as_bytes())
            .unwrap()
            + 1;
        let mut buffer = payload[..split].to_vec();
        assert!(pop_line(&mut buffer).is_none());
        buffer.extend_from_slice(&payload[split..]);

        let mut parser = SseParser::default();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        drain_sse_buffer(&mut buffer, &mut parser, &tx);

        assert_eq!(rx.try_recv().unwrap(), "{\"text\":\"昆仑\"}");
    }

    #[test]
    fn enqueue_sse_message_drops_when_queue_is_full() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);

        enqueue_sse_message(&tx, "first".to_string());
        enqueue_sse_message(&tx, "second".to_string());

        assert_eq!(rx.try_recv().unwrap(), "first");
        assert!(rx.try_recv().is_err());
    }
}
