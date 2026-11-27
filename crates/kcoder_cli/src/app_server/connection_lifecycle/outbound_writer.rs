//! Write line-delimited RPC output. Batch only already queued child output.
use kcoder_app_protocol::method;
use serde_json::Value;
use tokio::{
    io::{AsyncWrite, AsyncWriteExt, BufWriter},
    sync::mpsc,
};

const MAX_BATCHABLE_DELTA_BYTES: usize = 4 * 1024;
const MAX_READY_BYTES: usize = 64 * 1024;
const MAX_READY_FRAMES: usize = 128;

fn is_batchable_child_output(message: &Value) -> bool {
    if message["method"] != method::AGENT_STREAM_EVENT || message.get("id").is_some() {
        return false;
    }
    let params = &message["params"];
    let payload = &params["params"];
    let text = match params["method"].as_str() {
        Some("item/delta") => payload["delta"]["text"].as_str(),
        Some("item/event") if payload["event"]["type"] == "assistant_thinking_delta" => {
            payload["event"]["text"].as_str()
        }
        _ => None,
    };
    text.is_some_and(|text| text.len() <= MAX_BATCHABLE_DELTA_BYTES)
        && params["subscriptionId"].is_string()
        && params["runId"].is_string()
}

pub(super) async fn write_frames(
    output: impl AsyncWrite + Unpin,
    mut outbound: mpsc::Receiver<Value>,
    mut prepare: impl FnMut(Value) -> Option<Vec<u8>>,
) -> std::io::Result<()> {
    let mut output = BufWriter::with_capacity(MAX_READY_BYTES, output);
    let mut next = None;
    loop {
        let frame = match next.take() {
            Some(frame) => frame,
            None => match outbound.recv().await {
                Some(frame) => frame,
                None => return Ok(()),
            },
        };
        let batchable = is_batchable_child_output(&frame);
        let Some(mut line) = prepare(frame) else {
            continue;
        };
        line.push(b'\n');
        if !batchable {
            // Control messages and responses retain their own writes and flush.
            output.get_mut().write_all(&line).await?;
            output.get_mut().flush().await?;
            continue;
        }

        let mut bytes = line.len();
        output.write_all(&line).await?;
        for _ in 1..MAX_READY_FRAMES {
            if bytes >= MAX_READY_BYTES {
                break;
            }
            let Ok(frame) = outbound.try_recv() else {
                break;
            };
            // Each frame was authorized for this connection before queuing.
            // Different subscriptions can share a write in original order.
            if !is_batchable_child_output(&frame) {
                next = Some(frame);
                break;
            }
            if let Some(mut line) = prepare(frame) {
                line.push(b'\n');
                bytes += line.len();
                output.write_all(&line).await?;
            }
        }
        output.flush().await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        pin::Pin,
        task::{Context, Poll},
        time::Duration,
    };
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[derive(Default)]
    struct Writes {
        bytes: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl AsyncWrite for Writes {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.bytes.push(bytes.to_vec());
            Poll::Ready(Ok(bytes.len()))
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn stream(subscription: &str, sequence: u64) -> Value {
        json!({"method":method::AGENT_STREAM_EVENT,"params":{
            "subscriptionId":subscription,"runId":format!("run-{subscription}"),"sequence":sequence,
            "method":"item/delta","params":{"delta":{"text":"片段"}}
        }})
    }

    fn encode(frame: Value) -> Option<Vec<u8>> {
        serde_json::to_vec(&frame).ok()
    }

    #[tokio::test]
    async fn interleaved_ready_child_frames_share_writes_without_crossing_controls() {
        let (sender, receiver) = mpsc::channel(8);
        let control = json!({"id":1,"result":{}});
        let frames = [
            stream("one", 1),
            stream("one", 2),
            control,
            stream("one", 3),
            stream("two", 1),
            stream("two", 2),
        ];
        for frame in frames.iter().cloned() {
            sender.send(frame).await.unwrap();
        }
        drop(sender);
        let mut output = Writes::default();
        write_frames(&mut output, receiver, encode).await.unwrap();

        let frame_counts: Vec<_> = output
            .bytes
            .iter()
            .map(|bytes| bytes.iter().filter(|&&byte| byte == b'\n').count())
            .collect();
        assert_eq!(frame_counts, [2, 1, 3]);
        assert_eq!(output.flushes, 3);
        let bytes = output.bytes.concat();
        let decoded: Vec<Value> = bytes
            .split_inclusive(|&byte| byte == b'\n')
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(decoded, frames);
    }

    #[tokio::test(start_paused = true)]
    async fn a_single_delta_flushes_while_the_sender_is_still_open() {
        let (sender, receiver) = mpsc::channel(2);
        let (reader, output) = tokio::io::duplex(4096);
        let writer = tokio::spawn(write_frames(output, receiver, encode));
        let frame = stream("one", 1);
        sender.send(frame.clone()).await.unwrap();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_millis(1), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), frame);
        drop(sender);
        writer.await.unwrap().unwrap();
    }
}
