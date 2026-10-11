//! Attachment requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    attachment_directories: &mut AttachmentDirectories,
) -> Result<DispatchControl> {
    match method {
        method::WORKSPACE_IMPORT_ATTACHMENT => {
            let result = match serde_json::from_value::<
                kcoder_app_protocol::WorkspaceImportAttachmentParams,
            >(params)
            {
                Ok(params) => {
                    super::workspace_upload::import_attachment(
                        &workspace_engine.cwd,
                        params,
                        attachment_directories,
                    )
                    .await
                }
                Err(error) => Err(error.into()),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }

        method::ATTACHMENT_SAVE => match serde_json::from_value::<AttachmentSaveParams>(params)
            .context("invalid attachment/save params")
            .and_then(|params| {
                attachment_save(
                    &workspace_engine.session_id(),
                    &params,
                    attachment_directories,
                )
            }) {
            Ok(result) => {
                send(
                    outbound_tx,
                    success_response(id, serde_json::to_value(result)?),
                )
                .await?
            }
            Err(error) => send(outbound_tx, error_response(id, -32602, &error.to_string())).await?,
        },
        method::ATTACHMENT_UPLOAD_START => {
            match serde_json::from_value::<AttachmentUploadStartParams>(params)
                .context("invalid attachment/upload/start params")
                .and_then(|params| {
                    attachment_upload_start(
                        &workspace_engine.session_id(),
                        &params,
                        attachment_directories,
                    )
                }) {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::ATTACHMENT_UPLOAD_CHUNK => {
            match serde_json::from_value::<AttachmentUploadChunkParams>(params)
                .context("invalid attachment/upload/chunk params")
                .and_then(|params| attachment_upload_chunk(&params, attachment_directories))
            {
                Ok(()) => {
                    send(outbound_tx, success_response(id, json!({"accepted": true}))).await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::ATTACHMENT_UPLOAD_FINISH => {
            match serde_json::from_value::<AttachmentUploadFinishParams>(params)
                .context("invalid attachment/upload/finish params")
                .and_then(|params| attachment_upload_finish(&params, attachment_directories))
            {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::ATTACHMENT_UPLOAD_CANCEL => {
            match serde_json::from_value::<AttachmentUploadCancelParams>(params)
                .context("invalid attachment/upload/cancel params")
                .and_then(|params| {
                    attachment_upload_cancel(&params.upload_id, attachment_directories)
                }) {
                Ok(()) => {
                    send(
                        outbound_tx,
                        success_response(id, json!({"cancelled": true})),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::ATTACHMENT_DELETE => {
            match serde_json::from_value::<AttachmentDeleteParams>(params)
                .context("invalid attachment/delete params")
                .and_then(|params| {
                    let path = PathBuf::from(params.path);
                    attachment_directories.delete(&path)
                }) {
                Ok(()) => send(outbound_tx, success_response(id, json!({"removed": true}))).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::ATTACHMENT_READ => match serde_json::from_value::<AttachmentReadParams>(params)
            .context("invalid attachment/read params")
            .and_then(|params| {
                let target_engine = thread_manager
                    .engine(&params.thread_id)
                    .context("thread/start or thread/resume is required")?;
                ensure_active_thread(
                    &target_engine,
                    thread_manager.lease(&params.thread_id),
                    &params.thread_id,
                )?;
                attachment_read(&target_engine, &params, attachment_directories)
            }) {
            Ok(result) => {
                send(
                    outbound_tx,
                    success_response(id, serde_json::to_value(result)?),
                )
                .await?
            }
            Err(error) => send(outbound_tx, error_response(id, -32038, &error.to_string())).await?,
        },
        method::ATTACHMENT_READ_CHUNK => {
            match serde_json::from_value::<AttachmentReadChunkParams>(params)
                .context("invalid attachment/read/chunk params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .engine(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    attachment_read_chunk(&target_engine, &params, attachment_directories)
                }) {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32038, &error.to_string())).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
