//! Native recovery endpoint. Only an authenticated, registered host may hand off
//! its freshly duplicated Job/process handles. This is not a model tool surface.
use crate::{
    framing::{FrameReader, write_frame},
    windows_clipboard_actor::ClipboardActor,
    windows_input_observer::InputObserver,
    windows_input_release::terminate_guardian_job_and_release,
    windows_peer::VerifiedPeer,
    windows_process::CleanupJob,
};
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::{
    os::windows::io::{FromRawHandle, OwnedHandle},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};
use windows_sys::Win32::{
    Foundation::{GetHandleInformation, HANDLE},
    System::{
        JobObjects::{
            IsProcessInJob, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
        },
        Threading::GetProcessId,
    },
};

pub(crate) const FRAME_LIMIT: usize = 256 * 1024;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryRequest {
    Observe {
        version: u32,
        input_tag: u32,
    },
    Attach {
        version: u32,
        job_handle: u64,
        process_handle: u64,
    },
    PreparePaste {
        version: u32,
        text: String,
    },
    FinishPaste {
        version: u32,
    },
    Stop {
        version: u32,
    },
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryReply {
    Observing { version: u32 },
    Attached { version: u32 },
    PastePrepared { version: u32, clipboard: bool },
    PasteFinished { version: u32 },
    Cleaned { version: u32 },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestFrame {
    pub request_id: u64,
    pub request: RecoveryRequest,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplyFrame {
    pub request_id: u64,
    pub reply: RecoveryReply,
}

async fn receive<S: AsyncRead + Unpin>(
    reader: &mut FrameReader,
    stream: &mut S,
) -> Result<RequestFrame> {
    let frame = reader.read(stream).await?;
    serde_json::from_slice(&frame).map_err(|_| anyhow!("invalid recovery request"))
}
async fn reply<S: AsyncWrite + Unpin>(
    stream: &mut S,
    request_id: u64,
    value: RecoveryReply,
) -> Result<()> {
    let bytes = serde_json::to_vec(&ReplyFrame {
        request_id,
        reply: value,
    })?;
    tokio::time::timeout(
        Duration::from_secs(5),
        write_frame(stream, &bytes, FRAME_LIMIT),
    )
    .await??;
    Ok(())
}
async fn unavailable(peer: &VerifiedPeer, observer: &InputObserver) {
    tokio::select! {
        _ = peer.wait_for_exit() => {},
        _ = crate::desktop::wait_until_unavailable(peer.session_id) => {},
        _ = async { while observer.healthy() { tokio::time::sleep(Duration::from_millis(100)).await; } } => {},
    }
}
enum Operation<T> {
    Complete(T),
    Stop(Option<u64>),
}
async fn clipboard_operation<S, F, T>(
    operation: F,
    stream: &mut S,
    reader: &mut FrameReader,
    peer: &VerifiedPeer,
    observer: &InputObserver,
    last_id: &mut u64,
) -> Result<Operation<T>>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: std::future::Future<Output = Result<T>>,
{
    tokio::select! {
        biased;
        _ = unavailable(peer, observer) => Ok(Operation::Stop(None)),
        request = receive(reader, stream) => {
            let request = request?;
            ensure!(request.request_id > *last_id, "recovery request replay rejected");
            *last_id = request.request_id;
            match request.request {
                RecoveryRequest::Stop { version: 1 } => Ok(Operation::Stop(Some(request.request_id))),
                _ => Err(anyhow!("overlapping recovery clipboard operation")),
            }
        },
        value = operation => Ok(Operation::Complete(value?)),
    }
}

/// Authenticated host must send exclusively owned fresh DuplicateHandle values.
/// No input is allowed until Attached. This dedicated process must exit after
/// this service returns, including failure before attachment.
///
/// # Safety
/// Handle values must satisfy that ownership contract, not refer to an existing
/// resource in this process. Kernel type/session/membership are also verified.
pub async unsafe fn serve_authorized_recovery<S>(mut stream: S, peer: VerifiedPeer) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    ensure!(
        peer.process_id != std::process::id(),
        "independent recovery process required"
    );
    let mut reader = FrameReader::new(FRAME_LIMIT);
    let first = tokio::select! {
        biased;
        _ = peer.wait_for_exit() => return Err(anyhow!("recovery owner unavailable")),
        request = tokio::time::timeout(HANDOFF_TIMEOUT, receive(&mut reader, &mut stream)) => request??,
    };
    ensure!(first.request_id == 1, "invalid recovery handshake sequence");
    let RecoveryRequest::Observe {
        version: 1,
        input_tag,
    } = first.request
    else {
        anyhow::bail!("recovery observer handshake required");
    };
    let observer = InputObserver::start_with_authorized_tag(input_tag as usize)?;
    reply(&mut stream, 1, RecoveryReply::Observing { version: 1 }).await?;
    let attach = tokio::select! {
        biased;
        _ = unavailable(&peer, &observer) => return Err(anyhow!("recovery unavailable before attach")),
        request = tokio::time::timeout(HANDOFF_TIMEOUT, receive(&mut reader, &mut stream)) => request??,
    };
    ensure!(
        attach.request_id == 2,
        "invalid recovery attachment sequence"
    );
    let RecoveryRequest::Attach {
        version: 1,
        job_handle,
        process_handle,
    } = attach.request
    else {
        anyhow::bail!("recovery Job attachment required");
    };
    let mut job = unsafe { accept_handles(job_handle, process_handle, peer.session_id) }?;
    let retirement = job.retirement_barrier()?;
    let mut clipboard = None;
    let operation: Result<Option<u64>> = async {
        clipboard = Some(ClipboardActor::start().await?);
        let clipboard = clipboard.as_ref().unwrap();
        reply(&mut stream, 2, RecoveryReply::Attached { version: 1 }).await?;
        let mut last_id = 2;
        loop {
            let request = tokio::select! {
                biased;
                _ = unavailable(&peer, &observer) => return Ok(None),
                request = receive(&mut reader, &mut stream) => request?,
            };
            ensure!(
                request.request_id > last_id,
                "recovery request replay rejected"
            );
            last_id = request.request_id;
            let id = request.request_id;
            match request.request {
                RecoveryRequest::Stop { version: 1 } => return Ok(Some(id)),
                RecoveryRequest::PreparePaste { version: 1, text } => {
                    match clipboard_operation(
                        clipboard.begin(text),
                        &mut stream,
                        &mut reader,
                        &peer,
                        &observer,
                        &mut last_id,
                    )
                    .await?
                    {
                        Operation::Stop(id) => return Ok(id),
                        Operation::Complete(prepared) => {
                            reply(
                                &mut stream,
                                id,
                                RecoveryReply::PastePrepared {
                                    version: 1,
                                    clipboard: prepared,
                                },
                            )
                            .await?
                        }
                    }
                }
                RecoveryRequest::FinishPaste { version: 1 } => {
                    match clipboard_operation(
                        clipboard.finish(),
                        &mut stream,
                        &mut reader,
                        &peer,
                        &observer,
                        &mut last_id,
                    )
                    .await?
                    {
                        Operation::Stop(id) => return Ok(id),
                        Operation::Complete(()) => {
                            reply(&mut stream, id, RecoveryReply::PasteFinished { version: 1 })
                                .await?
                        }
                    }
                }
                _ => anyhow::bail!("unexpected recovery operation"),
            }
        }
    }
    .await;
    let session = peer.session_id;
    let cleanup_observer = observer.clone();
    let cleanup = tokio::task::spawn_blocking(move || {
        terminate_guardian_job_and_release(
            &mut job,
            cleanup_observer.ownership(),
            session,
            cleanup_observer.tag(),
            Duration::from_secs(5),
        )
    })
    .await;
    // No worker can paste after successful process cleanup. Even if input
    // release failed, still attempt clipboard restoration and preserve failure.
    let clipboard_cleanup = match clipboard {
        Some(clipboard) => clipboard.shutdown().await,
        None => Ok(()),
    };
    observer.shutdown();
    cleanup??;
    clipboard_cleanup?;
    retirement.release_after_cleanup();
    if let Some(id) = operation? {
        reply(&mut stream, id, RecoveryReply::Cleaned { version: 1 }).await?;
    }
    Ok(())
}

/// Validate kernel types before adopting ownership of handles from the trusted
/// host. Invalid numeric values are never passed to OwnedHandle/CloseHandle.
unsafe fn accept_handles(job: u64, process: u64, session: u32) -> Result<CleanupJob> {
    ensure!(
        job != 0 && process != 0 && job != process,
        "invalid recovery handles"
    );
    let job = usize::try_from(job).map_err(|_| anyhow!("invalid recovery Job handle"))? as HANDLE;
    let process =
        usize::try_from(process).map_err(|_| anyhow!("invalid recovery process handle"))? as HANDLE;
    for handle in [job, process] {
        let mut flags = 0;
        ensure!(
            unsafe { GetHandleInformation(handle, &mut flags) } != 0,
            "invalid transferred handle"
        );
    }
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    ensure!(
        unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        } != 0,
        "transferred object is not a queryable Job"
    );
    ensure!(
        unsafe { GetProcessId(process) } != 0,
        "transferred object is not a process"
    );
    let mut belongs = 0;
    ensure!(
        unsafe { IsProcessInJob(process, job, &mut belongs) } != 0 && belongs != 0,
        "transferred worker does not belong to Job"
    );
    CleanupJob::from_owned_handles(
        unsafe { OwnedHandle::from_raw_handle(job) },
        unsafe { OwnedHandle::from_raw_handle(process) },
        session,
    )
}
