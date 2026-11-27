//! Observe EOF independently of a request waiting on an external MCP handshake.
use super::protocol_io::{JsonRpcLine, JsonRpcLineState};
use anyhow::{Context, Result};
use tokio::io::{AsyncBufRead, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct ConnectionInput {
    receiver: mpsc::Receiver<Result<JsonRpcLine>>,
    ended: CancellationToken,
    worker: tokio::task::JoinHandle<()>,
}

impl ConnectionInput {
    pub fn stdin() -> Self {
        Self::new(BufReader::new(tokio::io::stdin()))
    }

    pub fn new<R: AsyncBufRead + Unpin + Send + 'static>(reader: R) -> Self {
        Self::spawn(Box::new(reader))
    }

    fn spawn(mut reader: Box<dyn AsyncBufRead + Unpin + Send>) -> Self {
        let (sender, receiver) = mpsc::channel(4);
        let ended = CancellationToken::new();
        let owner = ended.clone().drop_guard();
        let worker = tokio::spawn(async move {
            let _owner = owner;
            let mut state = JsonRpcLineState::default();
            loop {
                match state
                    .read(&mut reader)
                    .await
                    .context("failed to read app-server stdin")
                {
                    Ok(Some(frame)) => {
                        if sender.send(Ok(frame)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error)).await;
                        break;
                    }
                }
            }
        });
        Self {
            receiver,
            ended,
            worker,
        }
    }

    pub fn ended(&self) -> CancellationToken {
        self.ended.clone()
    }
    pub async fn read(&mut self) -> Result<Option<JsonRpcLine>> {
        self.receiver.recv().await.transpose()
    }
}

impl Drop for ConnectionInput {
    fn drop(&mut self) {
        self.ended.cancel();
        self.worker.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    #[tokio::test]
    async fn eof_is_observed_while_the_dispatcher_has_not_requested_another_frame() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let mut input = ConnectionInput::new(BufReader::new(reader));
        writer.write_all(b"{}\n").await.unwrap();
        assert!(input.read().await.unwrap().is_some());
        writer.shutdown().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), input.ended().cancelled())
            .await
            .unwrap();
        assert!(input.read().await.unwrap().is_none());
    }
}
