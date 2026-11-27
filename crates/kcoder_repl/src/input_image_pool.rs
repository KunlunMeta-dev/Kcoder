//! Bounded process-owned read workers for submitted local images.
//!
//! File reads can remain in a kernel call after cancellation. They never write
//! authority and must not keep Tokio runtime shutdown waiting indefinitely.
use crate::attachments::SubmittedMessage;
use kcoder_types::Message;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const WORKERS: usize = 2;
const QUEUED: usize = 2;

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Pool {
    sender: Option<mpsc::SyncSender<Job>>,
    // These are process-owned even after a TUI session or observer ends.
    workers: Vec<JoinHandle<()>>,
}

impl Pool {
    fn start(workers: usize, queued: usize) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(queued);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut handles = Vec::with_capacity(workers);
        for index in 0..workers {
            let receiver = receiver.clone();
            match thread::Builder::new()
                .name(format!("kcoder-image-reader-{index}"))
                .spawn(move || {
                    loop {
                        let job = {
                            let receiver =
                                receiver.lock().unwrap_or_else(|error| error.into_inner());
                            receiver.recv()
                        };
                        let Ok(job) = job else { break };
                        let _ = catch_unwind(AssertUnwindSafe(job));
                    }
                }) {
                Ok(handle) => handles.push(handle),
                Err(error) => {
                    drop(sender);
                    for handle in handles {
                        let _ = handle.join();
                    }
                    return Err(error.to_string());
                }
            }
        }
        Ok(Self {
            sender: Some(sender),
            workers: handles,
        })
    }

    fn global() -> Result<&'static Self, String> {
        static POOL: OnceLock<Result<Pool, String>> = OnceLock::new();
        POOL.get_or_init(|| Self::start(WORKERS, QUEUED))
            .as_ref()
            .map_err(Clone::clone)
    }

    fn try_submit(&self, job: Job) -> Result<(), String> {
        self.sender
            .as_ref()
            .expect("live worker pool")
            .try_send(job)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    "Image preparation is busy; try again when an earlier read finishes."
                        .to_string()
                }
                mpsc::TrySendError::Disconnected(_) => {
                    "Image preparation is unavailable.".to_string()
                }
            })
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        // Only local test pools are dropped; the global pool lives for the process.
        self.sender.take();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

pub(super) async fn prepare(
    submitted: SubmittedMessage,
    text: String,
    cancel: CancellationToken,
) -> Result<Message, String> {
    if cancel.is_cancelled() {
        return Err("Input preparation cancelled.".into());
    }
    let (send, receive) = oneshot::channel();
    let worker_cancel = cancel.clone();
    Pool::global()?.try_submit(Box::new(move || {
        let result = submitted
            .to_model_message_cancellable(text, &worker_cancel)
            .map_err(|error| error.to_string());
        let _ = send.send(result);
    }))?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Input preparation cancelled.".into()),
        result = receive => result.map_err(|_| "Image preparation stopped unexpectedly.".to_string())?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TrySendError;

    #[test]
    fn bounded_worker_keeps_owned_job_and_rejects_extra_work() {
        let pool = Pool::start(1, 1).unwrap();
        let (started, ready) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        let (finished, done) = mpsc::channel();
        pool.try_submit(Box::new(move || {
            started.send(()).unwrap();
            let _ = blocked.recv();
            finished.send(()).unwrap();
        }))
        .unwrap();
        ready
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        pool.try_submit(Box::new(|| {})).unwrap();
        assert!(matches!(
            pool.sender.as_ref().unwrap().try_send(Box::new(|| {})),
            Err(TrySendError::Full(_))
        ));
        release.send(()).unwrap();
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_observer_does_not_abandon_the_owned_worker() {
        let pool = Pool::start(1, 1).unwrap();
        let (started, ready) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        let (finished, done) = mpsc::channel();
        let (send, receive) = oneshot::channel::<()>();
        pool.try_submit(Box::new(move || {
            started.send(()).unwrap();
            let _ = blocked.recv();
            let _ = send.send(());
            finished.send(()).unwrap();
        }))
        .unwrap();
        ready
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {},
            _ = receive => panic!("blocked job unexpectedly finished"),
        }
        assert!(matches!(done.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release.send(()).unwrap();
        done.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
    }

    #[tokio::test]
    async fn real_image_keeps_the_original_path_media_type_and_bytes() {
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("owned.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        let mut submitted = SubmittedMessage::text("look [image]".into());
        submitted
            .images
            .push(crate::attachments::LocalImageAttachment {
                path: image,
                placeholder: "[image]".into(),
                media_type: "image/png".into(),
                clipboard_image: None,
            });
        let result = prepare(submitted, "look [image]".into(), CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(result, Message::User { content, .. }
            if matches!(content.as_slice(), [kcoder_types::ContentBlock::Text { text }, kcoder_types::ContentBlock::Image { source }]
                if text == "look [image]" && source.media_type == "image/png" && source.data == "iVBORw0KGgo=")));
    }
}
