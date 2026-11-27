//! The manager captures native facts; its existing owned job set drains disk/IPC admission.
use super::super::service::{
    LivePeerSource, LocalPeerSourceAuthorization, LocalTargetSnapshot, local_send_error,
};
use super::*;
use anyhow::{Result as AnyResult, ensure};
use kcoder_engine::QueryEngine;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use tokio_util::sync::CancellationToken;

type SendReply = oneshot::Sender<Result<Reply, SessionMessageSendError>>;
struct Prepared {
    call: SessionMessageCall,
    engine: QueryEngine,
    source: Arc<dyn LivePeerSource>,
    service: Arc<PeerMessageService>,
    target: Option<LocalTargetSnapshot>,
    intent: AgentMessageIntent,
    input: Value,
}
enum Action {
    Immediate(Reply),
    Local(Box<Prepared>),
}
struct CurrentSource<'a> {
    prepared: &'a Prepared,
    reply: &'a SendReply,
    cancel: &'a CancellationToken,
}
impl LocalPeerSourceAuthorization for CurrentSource<'_> {
    fn check_current(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> AnyResult<()> {
        ensure!(
            !self.cancel.is_cancelled() && !self.reply.is_closed(),
            "peer_message_source_cancelled"
        );
        let prepared = self.prepared;
        let call = &prepared.call;
        ensure!(
            call.is_current()
                && prepared.engine.state.shares_state_with(state)
                && prepared.engine.is_independent_discovery_session()
                && prepared.service.workspace_matches(&state.cwd())
                && call.owner().same_lifecycle(owner)
                && prepared
                    .engine
                    .active_tool_registry()
                    .get(call.tool_name())
                    .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
                && prepared
                    .engine
                    .permissions
                    .try_read()
                    .is_ok_and(|permissions| !permissions
                        .is_explicitly_denied(call.tool_name(), &prepared.input)),
            "peer_message_source_changed"
        );
        verify_captured_attempt(
            &prepared.engine,
            call.state(),
            call.owner(),
            call.captured_attempt(),
            "peer_message_source_attempt_unavailable",
            "peer_message_source_attempt_changed",
        )
        .map_err(|_| anyhow::anyhow!("peer_message_source_attempt_changed"))?;
        prepared.source.check_current(state, owner, intent)
    }
    fn check_before_queue_commit(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> AnyResult<()> {
        ensure!(
            !self.cancel.is_cancelled() && !self.reply.is_closed(),
            "peer_message_source_cancelled"
        );
        let prepared = self.prepared;
        let call = &prepared.call;
        ensure!(
            call.is_current()
                && prepared.engine.state.shares_state_with(state)
                && prepared.engine.is_independent_discovery_session()
                && prepared.service.workspace_matches(&state.cwd())
                && call.owner().same_lifecycle(owner)
                && prepared
                    .engine
                    .active_tool_registry()
                    .get(call.tool_name())
                    .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
                && prepared
                    .engine
                    .permissions
                    .try_read()
                    .is_ok_and(|permissions| !permissions
                        .is_explicitly_denied(call.tool_name(), &prepared.input)),
            "peer_message_source_changed"
        );
        verify_captured_attempt(
            &prepared.engine,
            call.state(),
            call.owner(),
            call.captured_attempt(),
            "peer_message_source_attempt_unavailable",
            "peer_message_source_attempt_changed",
        )
        .map_err(|_| anyhow::anyhow!("peer_message_source_attempt_changed"))?;
        prepared
            .source
            .check_before_queue_commit(state, owner, intent)
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The destructured send request and the host's separately borrowed owners stay explicit"
)]
pub(super) fn dispatch(
    call: SessionMessageCall,
    intent: AgentMessageIntent,
    reply: SendReply,
    manager: &ThreadManager,
    service: Option<&Arc<PeerMessageService>>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
    jobs: &mut tokio::task::JoinSet<()>,
    cancel: &CancellationToken,
) {
    if reply.is_closed() {
        return;
    }
    let prepared = (|| -> Result<Action, SessionMessageSendError> {
        let service = service.ok_or(SessionMessageSendError::Rejected {
            code: "peer_message_host_unavailable",
        })?;
        let input =
            serde_json::to_value(&intent).map_err(|_| SessionMessageSendError::Rejected {
                code: "peer_message_invalid_intent",
            })?;
        let engine = verify_source(&call, manager, service, &input).map_err(|_| {
            SessionMessageSendError::Rejected {
                code: "peer_message_source_changed",
            }
        })?;
        let attempt = verify_captured_attempt(
            &engine,
            call.state(),
            call.owner(),
            call.captured_attempt(),
            "peer_message_source_attempt_unavailable",
            "peer_message_source_attempt_changed",
        )
        .map_err(|_| SessionMessageSendError::Rejected {
            code: "peer_message_source_attempt_changed",
        })?;
        let source = service
            .local_source(&service.address(&engine.session_id()).map_err(|_| {
                SessionMessageSendError::Rejected {
                    code: "peer_message_source_changed",
                }
            })?)
            .map_err(|_| SessionMessageSendError::Rejected {
                code: "peer_message_source_unavailable",
            })?
            .ok_or(SessionMessageSendError::Rejected {
                code: "peer_message_source_unavailable",
            })?;
        source
            .admit_original(&intent)
            .map_err(|_| SessionMessageSendError::Rejected {
                code: "peer_message_source_policy_denied",
            })?;
        if intent.target_address.as_ref().is_some_and(|target| {
            service
                .identity()
                .is_ok_and(|identity| !identity.contains(target))
        }) {
            if !service.has_private_parent() || !bridge.is_some_and(|bridge| bridge.available()) {
                return Err(SessionMessageSendError::Rejected {
                    code: "peer_message_authenticated_route_unavailable",
                });
            }
            if intent.reply_to_message_id.is_some()
                && !bridge.is_some_and(|bridge| bridge.supports_message_replies())
            {
                return Err(SessionMessageSendError::Rejected {
                    code: "peer_message_reply_unsupported",
                });
            }
            return Ok(Action::Immediate(Reply::Gateway {
                kind: if intent.reply_to_message_id.is_some()
                    && bridge.is_some_and(|bridge| bridge.supports_background_replies())
                {
                    "sendReply"
                } else {
                    "send"
                },
                attempt,
                payload: input,
            }));
        }
        let target = LocalTargetSnapshot::capture(
            manager,
            &engine.client_storage_root(),
            &intent.target_thread_id,
        );
        Ok(Action::Local(Box::new(Prepared {
            call,
            engine,
            source,
            service: service.clone(),
            target: Some(target),
            intent,
            input,
        })))
    })();
    match prepared {
        Err(error) => {
            let _ = reply.send(Err(error));
        }
        Ok(Action::Immediate(value)) => {
            let _ = reply.send(Ok(value));
        }
        Ok(Action::Local(prepared)) => {
            if jobs.len() >= 32 || cancel.is_cancelled() {
                let _ = reply.send(Err(SessionMessageSendError::Rejected {
                    code: "peer_message_host_busy",
                }));
                return;
            }
            let cancel = cancel.clone();
            jobs.spawn_blocking(move || {
                let mut prepared = *prepared;
                let target = prepared
                    .target
                    .take()
                    .expect("captured actual manager target");
                let authorization = CurrentSource {
                    prepared: &prepared,
                    reply: &reply,
                    cancel: &cancel,
                };
                let result = prepared
                    .service
                    .prepare_local_with_snapshot(
                        &prepared.engine.state,
                        prepared.call.owner(),
                        &authorization,
                        &prepared.engine.client_storage_root(),
                        prepared.intent.clone(),
                        target,
                    )
                    .map_err(local_send_error)
                    .and_then(|receipt| {
                        serde_json::to_value(receipt)
                            .map(Reply::Local)
                            .map_err(|_| SessionMessageSendError::Unconfirmed {
                                code: "peer_message_receipt_unconfirmed",
                            })
                    });
                let _ = reply.send(result);
            });
        }
    }
}
