//! Dedicated clipboard/window thread. Blocking Win32 clipboard calls never run
//! on the recovery pipe reader; cancellation invalidates late publications.
use crate::windows_clipboard::ClipboardTransaction;
use anyhow::{Result, anyhow};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

type Receipt<T> = std::result::Result<T, String>;
enum Request {
    Begin {
        text: String,
        cancelled: Arc<AtomicBool>,
        reply: oneshot::Sender<Receipt<bool>>,
    },
    Finish(oneshot::Sender<Receipt<()>>),
}
pub struct ClipboardActor {
    sender: mpsc::SyncSender<Request>,
    stop: Arc<AtomicBool>,
    completion: watch::Receiver<Option<Receipt<()>>>,
}
struct CancelOnDrop {
    flag: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, Ordering::Release);
        }
    }
}
impl ClipboardActor {
    pub async fn start() -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(2);
        let stop = Arc::new(AtomicBool::new(false));
        let (completed, completion) = watch::channel(None);
        let (ready, startup) = oneshot::channel();
        let stopped = stop.clone();
        std::thread::spawn(move || {
            let result = run(receiver, &stopped, ready).map_err(|error| error.to_string());
            let _ = completed.send(Some(result));
        });
        let actor = Self {
            sender,
            stop,
            completion,
        };
        tokio::time::timeout(Duration::from_secs(5), startup)
            .await?
            .map_err(|_| anyhow!("clipboard thread startup failed"))?
            .map_err(anyhow::Error::msg)?;
        Ok(actor)
    }
    pub async fn begin(&self, text: String) -> Result<bool> {
        let (reply, response) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut guard = CancelOnDrop {
            flag: cancelled.clone(),
            armed: true,
        };
        self.sender
            .try_send(Request::Begin {
                text,
                cancelled,
                reply,
            })
            .map_err(|_| anyhow!("clipboard thread unavailable or busy"))?;
        let result = response
            .await
            .map_err(|_| anyhow!("clipboard preparation was not confirmed"))?;
        guard.armed = false;
        result.map_err(anyhow::Error::msg)
    }
    pub async fn finish(&self) -> Result<()> {
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Request::Finish(reply))
            .map_err(|_| anyhow!("clipboard thread unavailable or busy"))?;
        response
            .await
            .map_err(|_| anyhow!("clipboard restoration was not confirmed"))?
            .map_err(anyhow::Error::msg)
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        let mut receipt = self.completion.clone();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(value) = receipt.borrow().clone() {
                    return value.map_err(anyhow::Error::msg);
                }
                receipt
                    .changed()
                    .await
                    .map_err(|_| anyhow!("clipboard thread exited without cleanup receipt"))?;
            }
        })
        .await?
    }
}
impl Drop for ClipboardActor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn run(
    receiver: mpsc::Receiver<Request>,
    stopped: &AtomicBool,
    ready: oneshot::Sender<Receipt<()>>,
) -> Result<()> {
    let mut clipboard = match ClipboardTransaction::new() {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return Err(error);
        }
    };
    let _ = ready.send(Ok(()));
    let mut active_cancel: Option<Arc<AtomicBool>> = None;
    loop {
        // Clipboard owner windows must dispatch WM_DESTROYCLIPBOARD and other
        // system messages even while waiting for the next pipe operation.
        let mut message = MSG::default();
        for _ in 0..32 {
            if unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } == 0 {
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if stopped.load(Ordering::Acquire) {
            break;
        }
        if active_cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            clipboard.finish()?;
            active_cancel = None;
        }
        match receiver.try_recv() {
            Ok(Request::Begin {
                text,
                cancelled,
                reply,
            }) => {
                let current =
                    || !cancelled.load(Ordering::Acquire) && !stopped.load(Ordering::Acquire);
                let result = clipboard
                    .begin_if_current(&text, current)
                    .map_err(|error| error.to_string());
                if result.as_ref().is_ok_and(|prepared| *prepared) {
                    active_cancel = Some(cancelled.clone());
                }
                if !current() {
                    clipboard.finish()?;
                    active_cancel = None;
                    let _ = reply.send(Err("clipboard publication cancelled".into()));
                } else if reply.send(result).is_err() {
                    // Receiver cancellation after publication still rolls back.
                    clipboard.finish()?;
                    active_cancel = None;
                }
            }
            Ok(Request::Finish(reply)) => {
                let result = clipboard.finish().map_err(|error| error.to_string());
                if result.is_ok() {
                    active_cancel = None;
                }
                let _ = reply.send(result);
            }
            Err(mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
            Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }
    clipboard.finish()?;
    drop(clipboard); // Completion is published only after the owner window closes.
    Ok(())
}
