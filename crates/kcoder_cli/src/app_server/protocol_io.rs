use anyhow::{Context, Result};
use kcoder_app_protocol::JSONRPC_VERSION;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::mpsc;

pub(super) const MAX_JSONRPC_LINE_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_ERROR_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Eq, PartialEq)]
pub(super) enum JsonRpcLine {
    Line(String),
    TooLarge,
    InvalidUtf8,
}

#[cfg(test)]
pub(super) async fn read_bounded_jsonrpc_line<R>(reader: &mut R) -> Result<Option<JsonRpcLine>>
where
    R: AsyncBufRead + Unpin,
{
    JsonRpcLineState::default().read(reader).await
}

#[derive(Default)]
pub(super) struct JsonRpcLineState {
    bytes: Vec<u8>,
    too_large: bool,
}

impl JsonRpcLineState {
    pub(super) async fn read<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> Result<Option<JsonRpcLine>> {
        // State survives cancellation by the project scheduler's select branch.
        let bytes = &mut self.bytes;
        let too_large = &mut self.too_large;
        loop {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                if *too_large {
                    *too_large = false;
                    return Ok(Some(JsonRpcLine::TooLarge));
                }
                if bytes.is_empty() {
                    return Ok(None);
                }
                break;
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            let payload = newline.map_or(available, |index| &available[..index]);
            if !*too_large {
                if bytes.len().saturating_add(payload.len()) > MAX_JSONRPC_LINE_BYTES {
                    *too_large = true;
                    bytes.clear();
                } else {
                    bytes.extend_from_slice(payload);
                }
            }
            reader.consume(consumed);
            if newline.is_some() {
                if *too_large {
                    *too_large = false;
                    return Ok(Some(JsonRpcLine::TooLarge));
                }
                break;
            }
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        // An encoding error belongs only to the consumed frame and cannot interrupt other resident threads.
        Ok(Some(match String::from_utf8(std::mem::take(bytes)) {
            Ok(line) => JsonRpcLine::Line(line),
            Err(_) => JsonRpcLine::InvalidUtf8,
        }))
    }
}

pub(super) async fn send(tx: &mpsc::Sender<Value>, value: Value) -> Result<()> {
    tx.send(value)
        .await
        .context("app-server outbound queue closed")
}

pub(super) fn success_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": JSONRPC_VERSION, "id": id, "result": result})
}

pub(super) fn browser_success_response<T>(
    id: Value,
    result: T,
    max_result_bytes: usize,
) -> Result<Value>
where
    T: Serialize,
{
    let result = serde_json::to_value(result)?;
    if serde_json::to_vec(&result)?.len() > max_result_bytes {
        anyhow::bail!("browser result exceeds JSON transport limit")
    }
    Ok(success_response(id, result))
}

pub(super) fn error_response(id: Value, code: i64, message: &str) -> Value {
    let message = truncate_utf8(message, MAX_ERROR_MESSAGE_BYTES);
    json!({"jsonrpc": JSONRPC_VERSION, "id": id, "error": {"code": code, "message": message}})
}

pub(super) fn local_runtime_error_response(id: Value, message: &str) -> Value {
    let mut response = error_response(id, -32603, message);
    response["error"]["data"] = json!({"error_type": "local_runtime_error"});
    response
}

pub(super) fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

pub(super) fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": JSONRPC_VERSION, "method": method, "params": params})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_line_read_keeps_partial_frame_for_scheduler_ticks() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut reader = tokio::io::BufReader::new(reader);
        let mut state = JsonRpcLineState::default();
        writer.write_all(b"{\"id\":").await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                state.read(&mut reader)
            )
            .await
            .is_err()
        );
        writer.write_all(b"1}\n{}\n").await.unwrap();
        assert_eq!(
            state.read(&mut reader).await.unwrap(),
            Some(JsonRpcLine::Line("{\"id\":1}".into()))
        );
        assert_eq!(
            state.read(&mut reader).await.unwrap(),
            Some(JsonRpcLine::Line("{}".into()))
        );
    }

    #[tokio::test]
    async fn invalid_utf8_preserves_the_following_frame_and_eof() {
        let mut reader = tokio::io::BufReader::with_capacity(2, &b"\xff\r\n{}\n\xc3"[..]);
        assert_eq!(
            read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
            Some(JsonRpcLine::InvalidUtf8)
        );
        assert_eq!(
            read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
            Some(JsonRpcLine::Line("{}".into()))
        );
        assert_eq!(
            read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
            Some(JsonRpcLine::InvalidUtf8)
        );
        assert_eq!(read_bounded_jsonrpc_line(&mut reader).await.unwrap(), None);
    }
}
