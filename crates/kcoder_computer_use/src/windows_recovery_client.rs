//! Host-side recovery handoff. The launcher authenticates the peer before use.
use crate::{
    framing::{FrameReader, write_frame},
    windows_peer::VerifiedPeer,
    windows_process::JobChild,
    windows_recovery::{FRAME_LIMIT, RecoveryReply, RecoveryRequest, ReplyFrame, RequestFrame},
};
use anyhow::{Result, anyhow, ensure};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};

struct Exchange<S> {
    stream: Option<S>,
    reader: FrameReader,
    next_id: u64,
    writing: bool,
}
impl<S: AsyncRead + AsyncWrite + Unpin> Exchange<S> {
    fn new(stream: S) -> Self {
        Self {
            stream: Some(stream),
            reader: FrameReader::new(FRAME_LIMIT),
            next_id: 1,
            writing: false,
        }
    }
    fn close(&mut self) {
        self.stream.take();
    }
    async fn request(&mut self, request: RecoveryRequest) -> Result<RecoveryReply> {
        // Stop includes process reaping, input release, clipboard restoration and reply.
        let timeout = if matches!(&request, RecoveryRequest::Stop { .. }) {
            Duration::from_secs(20)
        } else {
            Duration::from_secs(10)
        };
        let result = tokio::time::timeout(timeout, self.request_inner(request))
            .await
            .map_err(anyhow::Error::from)
            .and_then(|value| value);
        if result.is_err() {
            self.close();
        }
        result
    }
    async fn request_inner(&mut self, request: RecoveryRequest) -> Result<RecoveryReply> {
        // Cancellation mid-write leaves an uncertain frame. Close instead of
        // concatenating another request onto that partial frame.
        ensure!(!self.writing, "recovery frame write was interrupted");
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| anyhow!("recovery request counter exhausted"))?;
        let bytes = serde_json::to_vec(&RequestFrame {
            request_id: id,
            request,
        })?;
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| anyhow!("recovery channel closed"))?;
        self.writing = true;
        write_frame(stream, &bytes, FRAME_LIMIT).await?;
        self.writing = false;
        // Partial replies survive request cancellation. A delayed preparation
        // receipt is consumed under its old ID, never accepted as a Stop receipt.
        for _ in 0..4 {
            let bytes = self.reader.read(stream).await?;
            let frame: ReplyFrame =
                serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid recovery reply"))?;
            ensure!(
                frame.request_id != 0 && frame.request_id <= id,
                "unexpected recovery reply ID"
            );
            if frame.request_id == id {
                return Ok(frame.reply);
            }
        }
        anyhow::bail!("too many stale recovery replies")
    }
}

pub struct PreparedRecovery<S> {
    io: Exchange<S>,
    peer: Arc<VerifiedPeer>,
}
pub struct RecoveryControl<S> {
    io: Exchange<S>,
    peer: Arc<VerifiedPeer>,
    cleaned: bool,
}
impl<S: AsyncRead + AsyncWrite + Unpin> PreparedRecovery<S> {
    pub fn process_id(&self) -> u32 {
        self.peer.process_id
    }
    /// Requires a one-use authenticated peer with recovery transfer rights.
    pub async fn observe(stream: S, peer: VerifiedPeer, input_tag: u32) -> Result<Self> {
        ensure!(
            (1..=0x7fff_ffff).contains(&input_tag),
            "invalid recovery input marker"
        );
        ensure!(
            peer.is_alive().unwrap_or(false),
            "recovery process unavailable"
        );
        let mut io = Exchange::new(stream);
        let value = io
            .request(RecoveryRequest::Observe {
                version: 1,
                input_tag,
            })
            .await?;
        ensure!(
            matches!(value, RecoveryReply::Observing { version: 1 }),
            "recovery observer was not confirmed"
        );
        Ok(Self {
            io,
            peer: Arc::new(peer),
        })
    }
    /// Consumes preparation; an ambiguous transfer cannot be replayed. The
    /// dedicated recipient exits on channel loss, closing any unsent duplicates.
    pub async fn attach(mut self, worker: &JobChild) -> Result<RecoveryControl<S>> {
        let (job_handle, process_handle) = worker.transfer_cleanup_to(&self.peer)?;
        let value = self
            .io
            .request(RecoveryRequest::Attach {
                version: 1,
                job_handle,
                process_handle,
            })
            .await?;
        ensure!(
            matches!(value, RecoveryReply::Attached { version: 1 }),
            "recovery attachment was not confirmed"
        );
        Ok(RecoveryControl {
            io: self.io,
            peer: self.peer,
            cleaned: false,
        })
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> RecoveryControl<S> {
    pub fn peer(&self) -> Arc<VerifiedPeer> {
        self.peer.clone()
    }
    pub fn healthy(&self) -> bool {
        self.io.stream.is_some() && !self.io.writing && self.peer.is_alive().unwrap_or(false)
    }
    pub async fn prepare_paste(&mut self, text: String) -> Result<bool> {
        match self
            .io
            .request(RecoveryRequest::PreparePaste { version: 1, text })
            .await?
        {
            RecoveryReply::PastePrepared {
                version: 1,
                clipboard,
            } => Ok(clipboard),
            _ => {
                self.io.close();
                Err(anyhow!("clipboard preparation was not confirmed"))
            }
        }
    }
    pub async fn finish_paste(&mut self) -> Result<()> {
        let value = self
            .io
            .request(RecoveryRequest::FinishPaste { version: 1 })
            .await?;
        if !matches!(value, RecoveryReply::PasteFinished { version: 1 }) {
            self.io.close();
            anyhow::bail!("clipboard restoration was not confirmed");
        }
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        let result = tokio::time::timeout(
            Duration::from_secs(22),
            self.io.request(RecoveryRequest::Stop { version: 1 }),
        )
        .await;
        self.io.close();
        ensure!(
            matches!(result??, RecoveryReply::Cleaned { version: 1 }),
            "recovery cleanup was not confirmed"
        );
        self.cleaned = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::read_frame;
    #[tokio::test]
    async fn cancelled_prepare_reply_cannot_satisfy_stop() {
        let (client, mut server) = tokio::io::duplex(4096);
        let received = Arc::new(tokio::sync::Notify::new());
        let notified = received.clone();
        let fixture = tokio::spawn(async move {
            let first: RequestFrame =
                serde_json::from_slice(&read_frame(&mut server, FRAME_LIMIT).await.unwrap())
                    .unwrap();
            assert_eq!(first.request_id, 1);
            notified.notify_one();
            let stop: RequestFrame =
                serde_json::from_slice(&read_frame(&mut server, FRAME_LIMIT).await.unwrap())
                    .unwrap();
            assert_eq!(stop.request_id, 2);
            assert!(matches!(stop.request, RecoveryRequest::Stop { version: 1 }));
            for frame in [
                ReplyFrame {
                    request_id: 1,
                    reply: RecoveryReply::PastePrepared {
                        version: 1,
                        clipboard: true,
                    },
                },
                ReplyFrame {
                    request_id: 2,
                    reply: RecoveryReply::Cleaned { version: 1 },
                },
            ] {
                write_frame(
                    &mut server,
                    &serde_json::to_vec(&frame).unwrap(),
                    FRAME_LIMIT,
                )
                .await
                .unwrap();
            }
        });
        let mut io = Exchange::new(client);
        {
            let prepare = io.request(RecoveryRequest::PreparePaste {
                version: 1,
                text: "fixture".into(),
            });
            tokio::pin!(prepare);
            tokio::select! {
                _ = received.notified() => {},
                _ = &mut prepare => panic!("fixture replied before cancellation"),
            }
        }
        assert!(matches!(
            io.request(RecoveryRequest::Stop { version: 1 })
                .await
                .unwrap(),
            RecoveryReply::Cleaned { version: 1 }
        ));
        fixture.await.unwrap();
    }
}
