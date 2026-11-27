//! Model calls return to their original manager; callers cannot select another source.
use super::backchannel::PeerRouterBackchannel;
use super::service::PeerMessageService;
use crate::app_server::ThreadManager;
use kcoder_tools::{
    ToolError,
    session_messages::{SessionMessageCall, SessionMessageSendError, SessionMessagesHost},
};
use kcoder_types::cross_session_messages::AgentMessageIntent;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

#[path = "host/local_send.rs"]
mod local_send;
#[path = "host/receipt_get.rs"]
mod receipt_get;
#[path = "host/receipt_list.rs"]
mod receipt_list;
#[path = "host/routed_read.rs"]
mod routed_read;
use kcoder_types::cross_session_messages::{
    CrossSessionMessageReceiptListParams, CrossSessionMessageReceiptListResult,
};

pub(crate) enum Request {
    Send {
        call: SessionMessageCall,
        intent: AgentMessageIntent,
        reply: oneshot::Sender<Result<Reply, SessionMessageSendError>>,
    },
    Receipt {
        call: SessionMessageCall,
        query: Value,
        reply: oneshot::Sender<Result<receipt_get::Source, ToolError>>,
    },
    ListReceipts {
        call: SessionMessageCall,
        query: CrossSessionMessageReceiptListParams,
        reply: oneshot::Sender<Result<receipt_list::Source, ToolError>>,
    },
    Discovery {
        call: kcoder_tools::session_discovery::SessionDiscoveryCall,
        input: Value,
        reply: oneshot::Sender<Result<kcoder_types::TurnAttemptIdentity, ToolError>>,
    },
    /// Resolve whether a read address is this host (capturing the owner's current read
    /// policy) or another runtime target reachable through the authenticated router
    /// (capturing the verified source attempt). Each read job still verifies both ends.
    ReadRoute {
        call: kcoder_tools::session_discovery::SessionDiscoveryCall,
        params: kcoder_tools::session_read::SessionReadParams,
        reply: oneshot::Sender<
            Result<routed_read::ReadPlan, kcoder_tools::session_read::SessionReadError>,
        >,
    },
}
pub(crate) enum Reply {
    Local(Value),
    Gateway {
        kind: &'static str,
        attempt: kcoder_types::TurnAttemptIdentity,
        payload: Value,
    },
}
struct Client {
    sender: mpsc::Sender<Request>,
    receipt_readers: Arc<tokio::sync::Semaphore>,
    /// Bounds owned blocking workers for single receipt reads; waiting here never
    /// blocks the dispatcher or an inbound delivery.
    receipt_getters: Arc<tokio::sync::Semaphore>,
    bridge: Arc<PeerRouterBackchannel>,
    local: Arc<dyn kcoder_tools::session_discovery::SessionDiscoveryHost>,
}
impl Client {
    async fn partial_local_discovery(
        &self,
        call: kcoder_tools::session_discovery::SessionDiscoveryCall,
        cursor: Option<String>,
    ) -> Result<Value, ToolError> {
        let mut page = self.local.list(call, cursor).await?;
        if let Some(object) = page.as_object_mut() {
            object.insert("completeness".into(), json!("partial"));
            if let Some(Value::String(cursor)) = object.get_mut("nextCursor") {
                cursor.insert_str(0, "local:");
            }
        }
        Ok(page)
    }
    async fn finish(&self, reply: Reply) -> anyhow::Result<Value> {
        match reply {
            Reply::Local(value) => Ok(value),
            Reply::Gateway {
                kind,
                attempt,
                payload,
            } => self.bridge.request(kind, &attempt, payload).await,
        }
    }
}
#[async_trait::async_trait]
impl SessionMessagesHost for Client {
    async fn send(
        &self,
        call: SessionMessageCall,
        intent: AgentMessageIntent,
    ) -> Result<Value, SessionMessageSendError> {
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::Send {
                call,
                intent,
                reply,
            })
            .map_err(|_| SessionMessageSendError::Rejected {
                code: "peer_message_host_busy",
            })?;
        let reply = result
            .await
            .map_err(|_| SessionMessageSendError::Unconfirmed {
                code: "peer_message_host_disconnected",
            })??;
        self.finish(reply)
            .await
            .map_err(|_| SessionMessageSendError::Unconfirmed {
                code: "peer_message_router_outcome_unknown",
            })
    }
    async fn list_receipts(
        &self,
        call: SessionMessageCall,
        query: CrossSessionMessageReceiptListParams,
    ) -> Result<CrossSessionMessageReceiptListResult, ToolError> {
        let permit = self
            .receipt_readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| ToolError::Execution("peer_message_host_busy".into()))?;
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::ListReceipts { call, query, reply })
            .map_err(|_| ToolError::Execution("peer_message_host_busy".into()))?;
        let source = result
            .await
            .map_err(|_| ToolError::Execution("peer_message_host_disconnected".into()))??;
        source.read(self.bridge.clone(), permit).await
    }
    async fn receipt(&self, call: SessionMessageCall, query: Value) -> Result<Value, ToolError> {
        let _permit = self
            .receipt_getters
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ToolError::Execution("peer_message_host_disconnected".into()))?;
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::Receipt { call, query, reply })
            .map_err(|_| ToolError::Execution("peer_message_host_busy".into()))?;
        let source = result
            .await
            .map_err(|_| ToolError::Execution("peer_message_host_disconnected".into()))??;
        source.read(self.bridge.clone()).await
    }
}
#[async_trait::async_trait]
impl kcoder_tools::session_discovery::SessionDiscoveryHost for Client {
    fn supports_read(&self) -> bool {
        self.local.supports_read()
    }
    async fn read(
        &self,
        call: kcoder_tools::session_discovery::SessionDiscoveryCall,
        params: kcoder_tools::session_read::SessionReadParams,
    ) -> Result<
        kcoder_tools::session_read::SessionReadResult,
        kcoder_tools::session_read::SessionReadError,
    > {
        use kcoder_tools::session_read::SessionReadError;
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::ReadRoute {
                call: call.clone(),
                params: params.clone(),
                reply,
            })
            .map_err(|_| SessionReadError::UNAVAILABLE)?;
        let route = match result.await.map_err(|_| SessionReadError::UNAVAILABLE)?? {
            routed_read::ReadPlan::Local(route) => route,
            routed_read::ReadPlan::Routed { attempt, own } => {
                return routed_read::request(&self.bridge, &attempt, params, &own).await;
            }
        };
        let mut params = params;
        // The address was proven local; the local job reads by thread ID only.
        params.target_address = None;
        self.local.read_routed(call, params, route).await
    }
    async fn list(
        &self,
        call: kcoder_tools::session_discovery::SessionDiscoveryCall,
        cursor: Option<String>,
    ) -> Result<Value, ToolError> {
        let routed = self.bridge.available();
        if let Some(cursor) = cursor
            .as_deref()
            .and_then(|cursor| partial_discovery_cursor(cursor, routed))
        {
            return self
                .partial_local_discovery(call, Some(cursor.to_owned()))
                .await;
        }
        if !routed {
            return self.local.list(call, cursor).await;
        }
        let fallback = (call.clone(), cursor.clone());
        let (reply, result) = oneshot::channel();
        let input = call.input(cursor.as_deref());
        self.sender
            .try_send(Request::Discovery {
                call,
                input: input.clone(),
                reply,
            })
            .map_err(|_| ToolError::Execution("session_discovery_host_busy".into()))?;
        let attempt = result
            .await
            .map_err(|_| ToolError::Execution("session_discovery_source_unavailable".into()))??;
        let input = super::super::session_discovery::gateway_search_input(
            input,
            self.bridge.supports_discovery_search(),
        )?;
        let error = match self.bridge.request("targets", &attempt, input).await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if let Some(rejection) =
            super::super::session_discovery::router_read_rejection(&error.to_string())
        {
            return Err(ToolError::Execution(rejection.into()));
        }
        // The parent route could not serve this attempt (for example a Native
        // peer-driven turn has no client owner there). This host's own sessions
        // remain readable through the ordinary local, independently authorized
        // reader; the page is marked partial because other targets are missing.
        let (call, cursor) = fallback;
        self.partial_local_discovery(call, cursor)
            .await
            .map_err(|_| ToolError::Execution("session_discovery_global_result_unconfirmed".into()))
    }
}
// Previous releases returned the Native directory's UUID:offset[:limit] directly on fallback.
// Selecting that reader still requires its actual owner-bound cursor and all current permissions.
fn partial_discovery_cursor(cursor: &str, routed: bool) -> Option<&str> {
    cursor.strip_prefix("local:").or_else(|| {
        let (id, _) = cursor.split_once(':')?;
        (routed && id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(cursor)
    })
}
#[cfg(test)]
mod partial_cursor_tests {
    use super::*;
    #[test]
    fn keeps_partial_cursors_with_their_reader_even_after_the_gateway_returns() {
        let native = "abcdef0123456789abcdef0123456789:12:5";
        assert_eq!(partial_discovery_cursor(native, true), Some(native));
        assert_eq!(partial_discovery_cursor(native, false), None);
        let marked = format!("local:{native}");
        for routed in [true, false] {
            assert_eq!(partial_discovery_cursor(&marked, routed), Some(native));
            assert_eq!(partial_discovery_cursor("gateway-opaque", routed), None);
        }
    }
}
pub(crate) fn channel(
    bridge: Arc<PeerRouterBackchannel>,
    local: Arc<dyn kcoder_tools::session_discovery::SessionDiscoveryHost>,
) -> (
    Arc<dyn SessionMessagesHost>,
    Arc<dyn kcoder_tools::session_discovery::SessionDiscoveryHost>,
    mpsc::Receiver<Request>,
) {
    let (sender, receiver) = mpsc::channel(32);
    let client = Arc::new(Client {
        sender,
        receipt_readers: Arc::new(tokio::sync::Semaphore::new(2)),
        receipt_getters: Arc::new(tokio::sync::Semaphore::new(4)),
        bridge,
        local,
    });
    (client.clone(), client, receiver)
}
fn capture_source(
    call: &SessionMessageCall,
    manager: &ThreadManager,
    service: &PeerMessageService,
    input: &Value,
) -> Result<
    (
        kcoder_engine::QueryEngine,
        kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness,
    ),
    ToolError,
> {
    let id = call.state().session_id();
    let engine = manager
        .engine(&id)
        .ok_or_else(|| ToolError::Execution("peer_message_source_unavailable".into()))?;
    let valid = call.is_current()
        && engine.state.shares_state_with(call.state())
        && !manager.is_ephemeral(&id)
        && engine.is_independent_discovery_session()
        && service.workspace_matches(&engine.state.cwd())
        && engine
            .active_tool_registry()
            .get(call.tool_name())
            .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
        && engine
            .permissions
            .try_read()
            .is_ok_and(|permissions| !permissions.is_explicitly_denied(call.tool_name(), input));
    if !valid {
        return Err(ToolError::Execution("peer_message_source_changed".into()));
    }
    let lease = manager
        .lease(&id)
        .and_then(|l| l.deferred_witness(&engine.session_lease_target()))
        .ok_or_else(|| ToolError::Execution("peer_message_source_changed".into()))?;
    Ok((engine, lease))
}

fn verify_source(
    call: &SessionMessageCall,
    manager: &ThreadManager,
    service: &PeerMessageService,
    input: &Value,
) -> Result<kcoder_engine::QueryEngine, ToolError> {
    let (engine, lease) = capture_source(call, manager, service, input)?;
    lease
        .verify_target(&engine.session_lease_target())
        .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
    Ok(engine)
}

/// Conversations of this host are read locally. Another runtime target's address is
/// routed through the Gateway peer router only when both the router and this host
/// negotiated `sessionReadV1`; otherwise it is refused as unsupported.
fn read_route(
    call: &kcoder_tools::session_discovery::SessionDiscoveryCall,
    params: &kcoder_tools::session_read::SessionReadParams,
    manager: &ThreadManager,
    service: Option<&Arc<PeerMessageService>>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
) -> Result<routed_read::ReadPlan, kcoder_tools::session_read::SessionReadError> {
    use kcoder_tools::session_read::{SessionReadError, SessionReadRoute};
    let Some(service) = service else {
        return match params.target_address {
            Some(_) => Err(SessionReadError::UNSUPPORTED_TARGET),
            None => Ok(routed_read::ReadPlan::Local(SessionReadRoute::default())),
        };
    };
    let identity = service
        .identity()
        .map_err(|_| SessionReadError::UNAVAILABLE)?;
    if let Some(address) = &params.target_address
        && !identity.contains(address)
    {
        return routed_read::plan(call, params, manager, service, bridge, identity);
    }
    // The target owner's account policy, read now; never a saved verdict.
    let read_access = service
        .admission_settings()
        .map_err(|_| SessionReadError::UNAVAILABLE)?
        .read_access;
    Ok(routed_read::ReadPlan::Local(SessionReadRoute {
        read_access: Some(read_access),
        address: service.address(&params.thread_id).ok(),
    }))
}

pub(crate) fn verify_captured_attempt(
    engine: &kcoder_engine::QueryEngine,
    state: &kcoder_state::AppState,
    owner: &kcoder_state::AppStateLifecycleIdentity,
    captured: Option<&kcoder_types::TurnAttemptIdentity>,
    unavailable: &'static str,
    changed: &'static str,
) -> Result<kcoder_types::TurnAttemptIdentity, ToolError> {
    if !engine.state.shares_state_with(state) || owner.try_matches(&engine.state) != Some(true) {
        return Err(ToolError::Execution(changed.into()));
    }
    let captured = captured.ok_or_else(|| ToolError::Execution(unavailable.into()))?;
    let current = engine
        .owned_turn_observer()
        .current_identity()
        .map_err(|_| ToolError::Execution(unavailable.into()))?;
    if current.as_ref() != Some(captured) {
        return Err(ToolError::Execution(changed.into()));
    }
    Ok(captured.clone())
}
pub(in crate::app_server) fn dispatch(
    request: Request,
    manager: &ThreadManager,
    service: Option<&Arc<PeerMessageService>>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
    jobs: &mut tokio::task::JoinSet<()>,
    cancel: &tokio_util::sync::CancellationToken,
) {
    match request {
        Request::Send {
            call,
            intent,
            reply,
        } => {
            local_send::dispatch(call, intent, reply, manager, service, bridge, jobs, cancel);
        }
        Request::Receipt { call, query, reply } => {
            // Capture identities only; the mailbox/router reads run on the
            // caller's owned blocking worker, never on this dispatch loop.
            if !reply.is_closed() {
                let _ = reply.send(receipt_get::capture(call, query, manager, service, bridge));
            }
        }
        Request::ListReceipts { call, query, reply } => {
            if !reply.is_closed() {
                let _ = reply.send(receipt_list::capture(call, query, manager, service, bridge));
            }
        }
        Request::ReadRoute {
            call,
            params,
            reply,
        } => {
            if !reply.is_closed() {
                let _ = reply.send(read_route(&call, &params, manager, service, bridge));
            }
        }
        Request::Discovery { call, input, reply } => {
            if reply.is_closed() {
                return;
            }
            let result = (|| -> Result<kcoder_types::TurnAttemptIdentity, ToolError> {
                let service = service.ok_or_else(|| {
                    ToolError::Execution("session_discovery_host_unavailable".into())
                })?;
                let id = call.state().session_id();
                let engine = manager.engine(&id).ok_or_else(|| {
                    ToolError::Execution("session_discovery_source_unavailable".into())
                })?;
                if !service.has_private_parent()
                    || !call.matches(&engine.state)
                    || manager.is_ephemeral(&id)
                    || !engine.is_independent_discovery_session()
                    || !service.workspace_matches(&engine.state.cwd())
                    || !engine
                        .active_tool_registry()
                        .get("ListSessions")
                        .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
                    || !manager.lease(&id).is_some_and(|lease| {
                        lease.matches_target(&engine.session_lease_target())
                            && lease.native_witness().is_ok()
                    })
                    || !engine.permissions.try_read().is_ok_and(|permissions| {
                        !permissions.is_explicitly_denied("ListSessions", &input)
                            && !permissions.is_explicitly_denied("ListSessions", &json!({}))
                    })
                {
                    return Err(ToolError::Execution(
                        "session_discovery_source_changed".into(),
                    ));
                }
                verify_captured_attempt(
                    &engine,
                    call.state(),
                    call.lifecycle(),
                    call.captured_attempt(),
                    "session_discovery_source_attempt_unavailable",
                    "session_discovery_source_attempt_changed",
                )
            })();
            let _ = reply.send(result);
        }
    }
}
