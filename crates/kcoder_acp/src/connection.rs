use crate::framing::Frame;
use crate::input::{Controls, ReceivedFrame};
use crate::native_binding::PreparedNative;
use crate::queue::{WireSender, wire_queue};
use crate::sessions::Session;
use crate::upstream::AppServerConfig;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, Implementation, InitializeRequest, InitializeResponse, NewSessionRequest,
    PromptRequest,
};
use anyhow::Result;
use kcoder_types::integrations::core::{NATIVE_REMOTE_CONTROL_METHOD, NativeRemoteControlFrameV1};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

mod native_close;

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// Executable identity and a private launch specification supplied by the CLI.
pub struct AgentInfo {
    pub version: String,
    pub app_server: Option<AppServerConfig>,
}

struct Slot {
    backend: Option<Session>,
    cancel: Option<CancellationToken>,
}

enum Completion {
    NativeClosed {
        id: Value,
        backend: Session,
        result: Result<Value>,
    },
    NativeControl {
        id: Value,
        result: Result<Value>,
    },
    NativeBound {
        id: Value,
        prepared: Option<PreparedNative>,
        result: Result<Value>,
    },
    Created {
        id: Value,
        session: String,
        result: Result<Session>,
    },
    Prompt {
        id: Value,
        backend: Session,
        result: Result<Value>,
    },
}

/// Read requests concurrently with bounded output and owned session tasks.
pub async fn serve<R, W>(reader: R, mut writer: W, info: AgentInfo) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (output, mut queue) = wire_queue();
    let write = async move {
        while let Some(frame) = queue.recv().await {
            writer.write_all(&frame.bytes).await?;
            writer.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    };
    let mut write = Box::pin(write);
    let cancellation = CancellationToken::new();
    let controls = Controls::default();
    let lifecycle = controls.lifecycle.clone();
    lifecycle.record("connection", "client_input", "started");
    let permissions = crate::permissions::Permissions::new(output.clone());
    let (incoming, receiver) = crate::input::channel();
    let receive = crate::input::receive(
        reader,
        incoming,
        controls.clone(),
        permissions.clone(),
        cancellation.clone(),
    );
    let dispatch = run(
        receiver,
        info,
        output,
        cancellation.clone(),
        controls,
        permissions,
    );
    let run = async {
        tokio::pin!(receive, dispatch);
        tokio::select! {
            biased;
            result = &mut dispatch => result,
            input_result = &mut receive => {
                let cleanup = dispatch.await;
                input_result.and(cleanup)
            }
        }
    };
    tokio::pin!(run);
    let result = tokio::select! {
        result = &mut run => {
            let flushed = tokio::time::timeout(Duration::from_secs(10), write).await
                .map_err(|_| anyhow::anyhow!("ACP output did not flush within 10s; delivery is unconfirmed"))
                .and_then(|result| result);
            // Preserve the initiating input/dispatch failure even if final delivery
            // also times out. Neither outcome proves that side effects did not run.
            result.and(flushed)
        },
        result = &mut write => {
            // Release the failed writer's receiver so blocked senders can settle.
            drop(write);
            lifecycle.record("cancel", "output_closed", "parent_cancellation");
            cancellation.cancel();
            let cleanup = run.await;
            result.and(cleanup)
        },
        signal = host_stop() => {
            lifecycle.record("cancel", signal.unwrap_or("host_monitor_failure"), "parent_cancellation");
            cancellation.cancel();
            let result = run.await;
            let flushed = tokio::time::timeout(Duration::from_secs(10), write).await
                .map_err(|_| anyhow::anyhow!("ACP output did not flush after host stop; delivery is unconfirmed"))
                .and_then(|result| result);
            result.and(flushed)
        },
    };
    lifecycle.record(
        "connection",
        "owner",
        if result.is_ok() {
            "closed"
        } else {
            "failed_or_delivery_unconfirmed"
        },
    );
    result
}

async fn host_stop() -> Result<&'static str> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => { result?; Ok("host_interrupt") },
            _ = terminate.recv() => Ok("host_sigterm"),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok("host_interrupt")
    }
}

// Keep the dispatch future's protocol state machine compiled in the ACP crate.
fn run(
    reader: tokio::sync::mpsc::Receiver<ReceivedFrame>,
    info: AgentInfo,
    output: WireSender,
    cancellation: CancellationToken,
    controls: Controls,
    permissions: crate::permissions::Permissions,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(run_inner(
        reader,
        info,
        output,
        cancellation,
        controls,
        permissions,
    ))
}

async fn run_inner(
    mut reader: tokio::sync::mpsc::Receiver<ReceivedFrame>,
    info: AgentInfo,
    output: WireSender,
    cancellation: CancellationToken,
    controls: Controls,
    permissions: crate::permissions::Permissions,
) -> Result<()> {
    let mut sessions = BTreeMap::<String, Slot>::new();
    let mut active_ids = BTreeSet::new();
    let mut tasks = JoinSet::new();
    let mut initialized = false;
    let mut native_prepared: Option<PreparedNative> = None;
    let mut native_reserved = false;
    let mut native_control: Option<crate::native_binding::NativeConnectionControl> = None;
    let mut pending_native_close: Option<native_close::PendingClose> = None;
    let mut native_close_intent: Option<NativeRemoteControlFrameV1> = None;
    let dispatch = async {
        loop {
            native_close::start_ready(&mut pending_native_close, &mut sessions, &mut tasks);
            let close_deadline = pending_native_close
                .as_ref()
                .map(|pending| pending.deadline);
            let frame = tokio::select! {
                _ = async {
                    match close_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some(pending) = pending_native_close.take() {
                        active_ids.remove(&pending.id.to_string());
                        output.send(error(pending.id, -32086, "REMOTE_OWNER_CLOSE_RECEIPT_UNKNOWN")).await?;
                    }
                    continue;
                }
                done = tasks.join_next(), if !tasks.is_empty() => {
                    let done = done.expect("nonempty task set")?;
                    complete(done, &mut sessions, &mut active_ids, &controls, &mut native_prepared, &mut native_control, Some(&output)).await?;
                    continue;
                }
                frame = reader.recv() => match frame {Some(frame) => frame, None => break},
            };
            let frame = match frame.frame {
                Frame::TooLarge => {
                    output
                        .send(error(Value::Null, -32600, "ACP frame exceeds 2 MiB"))
                        .await?;
                    continue;
                }
                Frame::Invalid => {
                    output
                        .send(error(Value::Null, -32700, "Invalid ACP JSON frame"))
                        .await?;
                    continue;
                }
                Frame::Json(frame) => frame,
            };
            let id = frame.get("id").cloned().unwrap_or(Value::Null);
            if frame["jsonrpc"] != "2.0" || !frame.is_object() {
                output
                    .send(error(Value::Null, -32600, "Expected a JSON-RPC 2.0 object"))
                    .await?;
                continue;
            }
            let Some(method) = frame["method"].as_str() else {
                if frame.get("result").is_none() && frame.get("error").is_none() {
                    output
                        .send(error(id, -32600, "Expected a JSON-RPC method or response"))
                        .await?;
                }
                permissions.receive(&frame);
                continue;
            };
            if frame.get("id").is_none() {
                if initialized
                    && method == "session/cancel"
                    && let Ok(cancel) =
                        serde_json::from_value::<CancelNotification>(frame["params"].clone())
                {
                    controls.cancel(&cancel.session_id.to_string(), "client_cancel");
                }
                continue;
            }
            if !(id.is_string() || id.as_i64().is_some() || id.as_u64().is_some()) {
                output
                    .send(error(
                        Value::Null,
                        -32600,
                        "Expected a string or integer request ID",
                    ))
                    .await?;
                continue;
            }
            if active_ids.contains(&id.to_string()) {
                output
                    .send(error(id, -32600, "Request ID is already active"))
                    .await?;
                continue;
            }
            let reply = if method == "initialize" {
                if initialized {
                    error(id, -32600, "ACP connection is already initialized")
                } else {
                    match serde_json::from_value::<InitializeRequest>(frame["params"].clone()) {
                        Ok(request) if request.protocol_version == ProtocolVersion::V1 => {
                            initialized = true;
                            let response = InitializeResponse::new(ProtocolVersion::V1)
                                .agent_info(Implementation::new("kcoder", &info.version));
                            json!({"jsonrpc":"2.0", "id":id, "result":response})
                        }
                        Ok(_) => error(id, -32602, "Only ACP protocolVersion 1 is supported"),
                        Err(_) => error(id, -32602, "Invalid ACP initialize parameters"),
                    }
                }
            } else if !initialized {
                error(id, -32600, "ACP connection must be initialized first")
            } else if method == NATIVE_REMOTE_CONTROL_METHOD {
                if let Ok(control) =
                    serde_json::from_value::<NativeRemoteControlFrameV1>(frame["params"].clone())
                    && !matches!(
                        control.message,
                        kcoder_types::integrations::core::NativeRemoteControlDataV1::BindOriginal(
                            _
                        )
                    )
                {
                    if matches!(
                        control.message,
                        kcoder_types::integrations::core::NativeRemoteControlDataV1::CloseOriginal(
                            _
                        )
                    ) {
                        let Some(link) = native_control
                            .as_ref()
                            .filter(|link| link.matches_close(&control))
                        else {
                            output
                                .send(error(id, -32086, "REMOTE_ORIGINAL_ACCEPTED_REQUIRED"))
                                .await?;
                            continue;
                        };
                        match link.close_receipt(&control) {
                            Ok(Some(result)) => {
                                output
                                    .send(json!({"jsonrpc":"2.0","id":id,"result":result}))
                                    .await?;
                                continue;
                            }
                            Err(_) => {
                                output
                                    .send(error(
                                        id,
                                        -32086,
                                        "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL",
                                    ))
                                    .await?;
                                continue;
                            }
                            Ok(None) => {}
                        }
                        if native_close_intent.is_some() {
                            output
                                .send(error(id, -32086, "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"))
                                .await?;
                            continue;
                        }
                        if link.request_original_close(&control).is_err() {
                            output
                                .send(error(id, -32086, "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"))
                                .await?;
                            continue;
                        }
                        active_ids.insert(id.to_string());
                        native_close_intent = Some(control.clone());
                        pending_native_close = Some(native_close::PendingClose::new(id, control));
                        // This connection has one original Native binding. Stop
                        // only its held prompt while its same backend is returned.
                        for slot in sessions.values() {
                            if let Some(cancel) = &slot.cancel {
                                cancel.cancel();
                            }
                        }
                        continue;
                    }
                    if let Some(link) = native_control
                        .as_ref()
                        .filter(|link| link.matches(&control))
                    {
                        let link = link.clone();
                        let cancel = cancellation.clone();
                        active_ids.insert(id.to_string());
                        tasks.spawn(async move {
                            Completion::NativeControl {
                                id,
                                result: link.request(control, &cancel).await,
                            }
                        });
                        continue;
                    } else {
                        error(id, -32086, "REMOTE_CONTROL_BINDING_MISMATCH")
                    }
                } else {
                    if !sessions.is_empty() {
                        error(id, -32086, "REMOTE_ORIGINAL_BIND_BEFORE_SESSION_REQUIRED")
                    } else if let Ok(frame) = serde_json::from_value::<NativeRemoteControlFrameV1>(
                        frame["params"].clone(),
                    ) {
                        if crate::native_binding::validate_original(&frame).is_err() {
                            error(id, -32086, "REMOTE_ORIGINAL_BINDING_INVALID")
                        } else if native_prepared
                            .as_ref()
                            .is_some_and(|prepared| !prepared.matches(&frame))
                        {
                            error(id, -32086, "REMOTE_ORIGINAL_BINDING_IMMUTABLE")
                        } else if native_reserved && native_prepared.is_none() {
                            error(id, -32086, "REMOTE_ORIGINAL_BINDING_PENDING_OR_UNAVAILABLE")
                        } else if let Some(config) = info.app_server.as_ref() {
                            native_reserved = true;
                            let prepared = native_prepared.take();
                            let config = config.clone();
                            let permissions = permissions.clone();
                            let cancel = cancellation.clone();
                            let lifecycle = controls.lifecycle.clone();
                            active_ids.insert(id.to_string());
                            tasks.spawn(async move {
                                let started = match prepared {
                                    Some(prepared) => Ok(prepared),
                                    None => {
                                        PreparedNative::start(
                                            &config,
                                            frame,
                                            permissions,
                                            &cancel,
                                            lifecycle,
                                        )
                                        .await
                                    }
                                };
                                match started {
                                    Ok(mut prepared) => {
                                        let result = prepared.reconcile(&cancel).await;
                                        Completion::NativeBound {
                                            id,
                                            prepared: Some(prepared),
                                            result,
                                        }
                                    }
                                    Err(error) => Completion::NativeBound {
                                        id,
                                        prepared: None,
                                        result: Err(error),
                                    },
                                }
                            });
                            continue;
                        } else {
                            error(id, -32086, "REMOTE_ORIGINAL_BINDING_UNAVAILABLE")
                        }
                    } else {
                        error(id, -32086, "REMOTE_ORIGINAL_BINDING_INVALID")
                    }
                }
            } else if method == "session/new" {
                if native_reserved {
                    let parsed =
                        serde_json::from_value::<NewSessionRequest>(frame["params"].clone());
                    match (parsed, native_prepared.as_ref()) {
                        (Ok(request), Some(prepared))
                            if sessions.is_empty()
                                && prepared.validate_session(&request).is_ok() =>
                        {
                            let prepared = native_prepared.take().expect("original native backend");
                            let session = format!(
                                "acp-{}-{}",
                                std::process::id(),
                                NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
                            );
                            let cancel = CancellationToken::new();
                            controls.register(&session, cancel.clone());
                            sessions.insert(
                                session.clone(),
                                Slot {
                                    backend: None,
                                    cancel: Some(cancel.clone()),
                                },
                            );
                            active_ids.insert(id.to_string());
                            tasks.spawn(async move {
                                let result = Session::create_from_native(
                                    session.clone(),
                                    request,
                                    prepared,
                                    &cancel,
                                )
                                .await;
                                Completion::Created {
                                    id,
                                    session,
                                    result,
                                }
                            });
                            continue;
                        }
                        _ => error(id, -32086, "REMOTE_ORIGINAL_SESSION_DISPATCH_REQUIRED"),
                    }
                } else {
                    match (
                        serde_json::from_value::<NewSessionRequest>(frame["params"].clone()),
                        info.app_server.as_ref(),
                    ) {
                        (Ok(request), Some(config)) if sessions.len() < 4 => {
                            let session = format!(
                                "acp-{}-{}",
                                std::process::id(),
                                NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
                            );
                            let cancel = CancellationToken::new();
                            controls.register(&session, cancel.clone());
                            sessions.insert(
                                session.clone(),
                                Slot {
                                    backend: None,
                                    cancel: Some(cancel.clone()),
                                },
                            );
                            active_ids.insert(id.to_string());
                            let config = config.clone();
                            let lifecycle = controls.lifecycle.session(&session);
                            tasks.spawn(async move {
                                let result = Session::create_traced(
                                    session.clone(),
                                    request,
                                    &config,
                                    &cancel,
                                    lifecycle,
                                )
                                .await;
                                Completion::Created {
                                    id,
                                    session,
                                    result,
                                }
                            });
                            continue;
                        }
                        (Ok(_), Some(_)) => error(id, -32060, "ACP connection session limit is 4"),
                        (Ok(_), None) => error(id, -32601, "ACP session backend is not configured"),
                        (Err(_), _) => error(id, -32602, "Invalid ACP session/new parameters"),
                    }
                }
            } else if method == "session/prompt" {
                match serde_json::from_value::<PromptRequest>(frame["params"].clone()) {
                    Ok(request) => match sessions.get_mut(&request.session_id.to_string()) {
                        Some(slot) if slot.backend.is_some() => {
                            let mut backend = slot.backend.take().expect("available session");
                            let cancel = CancellationToken::new();
                            controls.register(&backend.id, cancel.clone());
                            slot.cancel = Some(cancel.clone());
                            let sender = output.clone();
                            let permission_requests = permissions.clone();
                            active_ids.insert(id.to_string());
                            tasks.spawn(async move {
                                let result = backend
                                    .prompt(request, &cancel, &sender, &permission_requests)
                                    .await;
                                Completion::Prompt {
                                    id,
                                    backend,
                                    result,
                                }
                            });
                            continue;
                        }
                        Some(_) => error(
                            id,
                            -32061,
                            "ACP session is busy; the active prompt was not cancelled",
                        ),
                        None => error(
                            id,
                            -32002,
                            "Unknown or closed ACP sessionId; create a new session",
                        ),
                    },
                    Err(_) => error(id, -32602, "Invalid ACP session/prompt parameters"),
                }
            } else {
                error(
                    id,
                    -32601,
                    "ACP method is not implemented in this development adapter",
                )
            };
            output.send(reply).await?;
        }
        Ok::<(), anyhow::Error>(())
    };
    let result = tokio::select! {
        biased;
        result = dispatch => result,
        _ = cancellation.cancelled() => Ok(()),
    };
    output.close();
    permissions.close();
    if !active_ids.is_empty() {
        controls.lifecycle.record(
            "connection_cleanup",
            "parent_task",
            "pending_receipts_unconfirmed",
        );
    }
    for (session, slot) in &sessions {
        if let Some(backend) = &slot.backend {
            backend.begin_shutdown();
        }
        if let Some(cancel) = &slot.cancel {
            controls
                .lifecycle
                .session(session)
                .record("cancel", "parent_task", "propagated");
            cancel.cancel();
        }
    }
    while let Some(done) = tasks.join_next().await {
        if let Ok(done) = done {
            complete(
                done,
                &mut sessions,
                &mut active_ids,
                &controls,
                &mut native_prepared,
                &mut native_control,
                None,
            )
            .await?;
        }
    }
    for slot in sessions.values_mut() {
        if let Some(backend) = &mut slot.backend {
            backend.shutdown().await;
        }
    }
    if let Some(prepared) = &mut native_prepared {
        prepared.shutdown().await;
    }
    controls.lifecycle.record(
        "connection",
        if result.is_err() {
            "dispatch_failure"
        } else {
            "parent_task"
        },
        "settled",
    );
    result
}

async fn complete(
    done: Completion,
    sessions: &mut BTreeMap<String, Slot>,
    ids: &mut BTreeSet<String>,
    controls: &Controls,
    native_prepared: &mut Option<PreparedNative>,
    native_control: &mut Option<crate::native_binding::NativeConnectionControl>,
    output: Option<&WireSender>,
) -> Result<()> {
    let (id, result) = match done {
        Completion::NativeClosed {
            id,
            mut backend,
            result,
        } => {
            controls.remove(&backend.id);
            sessions.remove(&backend.id);
            // On an error before the actual close, stop only this original owner.
            // No failure can restore an ordinary session or create a new backend.
            if result.is_err() {
                backend.shutdown().await;
            }
            (
                id,
                result.map_err(|_| anyhow::anyhow!("REMOTE_OWNER_CLOSE_RECEIPT_UNKNOWN")),
            )
        }
        Completion::NativeControl { id, result } => (
            id,
            result.map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_RECEIVER_UNAVAILABLE")),
        ),
        Completion::NativeBound {
            id,
            mut prepared,
            result,
        } => {
            if output.is_some() {
                if result.is_ok()
                    && let Some(prepared) = &prepared
                {
                    *native_control = Some(prepared.control());
                }
                *native_prepared = prepared;
            } else if let Some(prepared) = &mut prepared {
                prepared.shutdown().await;
            }
            let result = result
                .map_err(|error| anyhow::anyhow!(crate::native_receiver_bind_diagnostic(&error)));
            (id, result)
        }
        Completion::Created {
            id,
            session,
            result,
        } => match result {
            Ok(backend) => {
                controls.remove(&session);
                sessions.insert(
                    session.clone(),
                    Slot {
                        backend: Some(backend),
                        cancel: None,
                    },
                );
                (id, Ok(json!({"sessionId":session})))
            }
            Err(error) => {
                controls.remove(&session);
                sessions.remove(&session);
                (id, Err(error))
            }
        },
        Completion::Prompt {
            id,
            backend,
            result,
        } => {
            controls.remove(&backend.id);
            if backend.is_closed() {
                sessions.remove(&backend.id);
            } else {
                sessions.insert(
                    backend.id.clone(),
                    Slot {
                        backend: Some(backend),
                        cancel: None,
                    },
                );
            }
            (id, result)
        }
    };
    ids.remove(&id.to_string());
    if let Some(output) = output {
        let reply = match result {
            Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
            Err(failure) => {
                match failure.downcast_ref::<agent_client_protocol::schema::v1::Error>() {
                    Some(failure) => json!({"jsonrpc":"2.0","id":id,"error":failure}),
                    None => error(id, -32603, &failure.to_string()),
                }
            }
        };
        output.send(reply).await?;
    }
    Ok(())
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, BufReader};

    #[tokio::test]
    async fn initialize_is_versioned_and_stdout_contains_only_wire_messages() {
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":\"early\",\"method\":\"session/new\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}\n";
        let (writer, mut output) = tokio::io::duplex(8192);
        serve(
            BufReader::new(input.as_slice()),
            writer,
            AgentInfo {
                version: "test".into(),
                app_server: None,
            },
        )
        .await
        .unwrap();
        let mut text = String::new();
        output.read_to_string(&mut text).await.unwrap();
        let frames = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0]["error"]["code"], -32600);
        assert_eq!(frames[1]["result"]["protocolVersion"], 1);
        assert_eq!(frames[1]["result"]["agentInfo"]["name"], "kcoder");
        assert_ne!(
            frames[1]["result"]["agentCapabilities"]["loadSession"],
            true
        );
        assert_eq!(frames[2]["error"]["code"], -32600);
    }

    #[tokio::test(start_paused = true)]
    async fn eof_unblocks_dispatch_even_when_the_client_never_reads_queued_replies() {
        let (mut input, server_input) = tokio::io::duplex(128 * 1024);
        let (server_output, _unread_output) = tokio::io::duplex(64);
        let server = tokio::spawn(serve(
            BufReader::new(server_input),
            server_output,
            AgentInfo {
                version: "test".into(),
                app_server: None,
            },
        ));
        let mut bytes = Vec::new();
        for id in 0..400 {
            serde_json::to_writer(
                &mut bytes,
                &json!({"jsonrpc":"2.0","id":id,"method":"unhandled"}),
            )
            .unwrap();
            bytes.push(b'\n');
        }
        input.write_all(&bytes).await.unwrap();
        input.shutdown().await.unwrap();
        // Transport output cannot be delivered, but EOF must still trigger cleanup
        // and the bounded final flush, not leave dispatch stuck in output.send().
        let result = tokio::time::timeout(Duration::from_secs(11), server)
            .await
            .expect("EOF stranded behind output backpressure")
            .expect("connection task panicked");
        assert!(
            result.is_err(),
            "unread output cannot be reported as delivered"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("delivery is unconfirmed")
        );
    }
}
