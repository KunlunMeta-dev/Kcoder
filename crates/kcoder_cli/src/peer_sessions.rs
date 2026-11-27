//! Actual source owners for independent TUI/Studio peers. Locators never authorize a source.
use crate::app_server::session_messages::service::{
    LocalPeerSourceAuthorization, PeerMessageService,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::cross_session_router::PeerRouterOperationV1;
use kcoder_cli_storage::session_lease::NativeSessionLeaseWitness;
use kcoder_config::{Settings, ToolProfile};
use kcoder_engine::QueryEngine;
use kcoder_permissions::PermissionEngine;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use kcoder_tools::{
    ToolRegistry,
    session_discovery::{ListSessionsTool, SessionDiscoveryCall, SessionDiscoveryContribution},
    session_messages::{
        GetSessionMessageReceiptTool, ListSessionMessageReceiptsTool, SendSessionMessageTool,
        SessionMessageCall, SessionMessageContribution,
    },
};
use kcoder_types::{cross_session_messages::*, session_address::SessionAddressV1};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

#[path = "peer_sessions/cold_source.rs"]
pub(crate) mod cold_source;
#[path = "peer_sessions/credential_lock.rs"]
mod credential_lock;
#[path = "peer_sessions/gateway_auth.rs"]
mod gateway_auth;
#[path = "peer_sessions/gateway_channel.rs"]
mod gateway_channel;
#[path = "peer_sessions/gateway_cli.rs"]
mod gateway_cli;
#[path = "peer_sessions/gateway_native.rs"]
mod gateway_native;
#[path = "peer_sessions/gateway_renewal.rs"]
mod gateway_renewal;
#[path = "peer_sessions/gateway_runtime.rs"]
mod gateway_runtime;
#[path = "peer_sessions/ssh_admin.rs"]
mod ssh_admin;
pub(crate) use gateway_cli::run as run_gateway_command;
pub(crate) use gateway_runtime::attach as attach_gateway;
pub(crate) use ssh_admin::run as run_ssh_command;

#[path = "peer_sessions/endpoint.rs"]
pub(crate) mod endpoint;
pub(crate) use endpoint::{
    OriginalSourceUnavailable, PeerSourceEndpoint, check_original_source, read_peer_status,
};
#[path = "peer_sessions/host.rs"]
mod host;
#[path = "peer_sessions/interactive.rs"]
mod interactive;
#[path = "peer_sessions/maintenance.rs"]
mod maintenance;
#[path = "peer_sessions/target_admission.rs"]
mod target_admission;
#[path = "peer_sessions/turn_retirement.rs"]
pub(crate) mod turn_retirement;
pub(crate) use interactive::InteractivePeerRuntime;
#[path = "peer_sessions/registry.rs"]
mod registry;
pub(crate) use host::attach_with_factory;
pub(crate) use host::destination_host;
pub(crate) use host::install_local_target_hosts;
pub(crate) use host::local_delivery_resolver;
pub(crate) use registry::live_candidates;

#[derive(Default)]
struct Contributions {
    discovery: Option<SessionDiscoveryContribution>,
    send: Option<SessionMessageContribution>,
    receipt: Option<SessionMessageContribution>,
    list_receipts: Option<SessionMessageContribution>,
}
#[derive(Clone)]
struct AdmittedIntent {
    canonical: AgentMessageIntent,
    original: AgentMessageIntent,
    reply: Option<kcoder_state::peer_agent_history::PeerReplyReferenceWitness>,
}

/// Contains the real State and weak native witnesses, never a QueryEngine.
pub(crate) struct BoundPeerSource {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    lease: NativeSessionLeaseWitness,
    history: PathBuf,
    settings: Arc<RwLock<Settings>>,
    permissions: Arc<RwLock<PermissionEngine>>,
    service: Arc<PeerMessageService>,
    contributions: Mutex<Contributions>,
    admitted: Mutex<BTreeMap<String, AdmittedIntent>>,
    active: AtomicBool,
    address_identity: SessionAddressV1,
    lease_id: String,
    activity: Arc<dyn Fn() -> bool + Send + Sync>,
    turns: kcoder_engine::owned_turn::OwnedTurnObserver,
    target_verifier: Mutex<
        Option<
            std::sync::Weak<
                dyn crate::app_server::session_messages::remote_delivery::OriginalSourceVerifier,
            >,
        >,
    >,
    artifacts: PathBuf,
    storage: PathBuf,
}

/// A bounded immutable operation selector. It carries no source identity grant or plaintext body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OriginalSourceCheck {
    pub client_message_id: String,
    pub destination: SessionAddressV1,
    pub mode: AgentMessageMode,
    pub expected_turn_id: Option<String>,
    pub body_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
}
impl OriginalSourceCheck {
    pub(crate) fn for_intent(intent: &AgentMessageIntent) -> Result<Self> {
        intent.validate().map_err(anyhow::Error::msg)?;
        Ok(Self {
            client_message_id: intent.client_message_id.clone(),
            destination: intent
                .target_address
                .clone()
                .context("peer_source_address_required")?,
            mode: intent.mode,
            expected_turn_id: intent.expected_turn_id.clone(),
            body_sha256: format!("{:x}", Sha256::digest(intent.text.as_bytes())),
            reply_to_message_id: intent.reply_to_message_id.clone(),
        })
    }
    fn validate(&self) -> Result<()> {
        self.destination.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            valid_agent_message_id(&self.client_message_id)
                && self
                    .reply_to_message_id
                    .as_deref()
                    .is_none_or(valid_agent_message_id)
                && self
                    .expected_turn_id
                    .as_deref()
                    .is_none_or(kcoder_types::valid_turn_attempt_component)
                && !(self.expected_turn_id.is_some() && self.mode == AgentMessageMode::WakeIfIdle)
                && self.body_sha256.len() == 64
                && self
                    .body_sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "peer_source_invalid_operation_selector"
        );
        Ok(())
    }
}
fn latest_turn(
    records: &[kcoder_state::turn_attempt_store::TurnAttemptRecord],
) -> Option<kcoder_app_protocol::cross_session_messages::AgentMessageLastTurn> {
    // Wall-clock timestamps do not prove the order of multiple attempts.
    let [record] = records else { return None };
    let done = record.completion.as_ref()?;
    if done.status != record.status {
        return None;
    }
    let status = match done.status {
        kcoder_types::TurnAttemptStatus::Completed => kcoder_app_protocol::TurnStatus::Completed,
        kcoder_types::TurnAttemptStatus::Failed => kcoder_app_protocol::TurnStatus::Failed,
        kcoder_types::TurnAttemptStatus::Interrupted => {
            kcoder_app_protocol::TurnStatus::Interrupted
        }
        _ => return None,
    };
    Some(
        kcoder_app_protocol::cross_session_messages::AgentMessageLastTurn {
            status,
            turn_id: Some(record.identity.turn_id.clone()),
            ended_at_ms: Some(done.finished_at_ms),
        },
    )
}
impl BoundPeerSource {
    pub(crate) fn capture(
        engine: &QueryEngine,
        service: Arc<PeerMessageService>,
        lease: NativeSessionLeaseWitness,
    ) -> Result<Arc<Self>> {
        ensure!(
            engine.is_independent_discovery_session(),
            "peer_source_independent_owner_required"
        );
        service.require_enabled(false)?;
        ensure!(
            service.workspace_matches(&engine.state.cwd()),
            "peer_source_workspace_changed"
        );
        let history = engine
            .state
            .history_path()
            .context("peer_source_original_history_required")?;
        lease.verify_target(&history)?;
        let bound = Arc::new(Self {
            lease_id: uuid::Uuid::new_v4().to_string(),
            activity: engine.turn_driver_activity_observer(),
            turns: engine.owned_turn_observer(),
            target_verifier: Mutex::new(None),
            artifacts: engine.session_storage_dir_for(&engine.session_id()),
            storage: engine.client_storage_root(),
            address_identity: service.address(&engine.session_id())?,
            state: engine.state.clone(),
            owner: engine.state.inspection_lifecycle_identity(),
            lease,
            history,
            settings: engine.settings.clone(),
            permissions: engine.permissions.clone(),
            service,
            contributions: Mutex::new(Contributions::default()),
            admitted: Mutex::new(BTreeMap::new()),
            active: AtomicBool::new(true),
        });
        bound.arm_tools(&engine.active_tool_registry())?;
        Ok(bound)
    }
    pub(crate) fn arm_tools(&self, tools: &ToolRegistry) -> Result<()> {
        let mut contributions = self
            .contributions
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        contributions.discovery = tools.get("ListSessions").and_then(|tool| {
            let any: &dyn std::any::Any = tool.as_ref();
            any.downcast_ref::<ListSessionsTool>()
                .map(ListSessionsTool::weak_contribution)
        });
        contributions.send = tools.get("SendSessionMessage").and_then(|tool| {
            let any: &dyn std::any::Any = tool.as_ref();
            any.downcast_ref::<SendSessionMessageTool>()
                .map(SendSessionMessageTool::weak_contribution)
        });
        contributions.list_receipts = tools.get("ListSessionMessageReceipts").and_then(|tool| {
            let any: &dyn std::any::Any = tool.as_ref();
            any.downcast_ref::<ListSessionMessageReceiptsTool>()
                .map(ListSessionMessageReceiptsTool::weak_contribution)
        });
        contributions.receipt = tools.get("GetSessionMessageReceipt").and_then(|tool| {
            let any: &dyn std::any::Any = tool.as_ref();
            any.downcast_ref::<GetSessionMessageReceiptTool>()
                .map(GetSessionMessageReceiptTool::weak_contribution)
        });
        Ok(())
    }
    fn check_owner(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire),
            "peer_source_owner_closed"
        );
        match self.state.try_check_lifecycle_identity(&self.owner)? {
            Some(true) => {}
            Some(false) => anyhow::bail!("peer_source_owner_changed"),
            None => {
                return Err(anyhow::anyhow!("PEER_HISTORY_STATE_BUSY").context("peer_source_busy"));
            }
        }
        ensure!(
            self.state.history_path().as_ref() == Some(&self.history)
                && self.state.session_mode() == kcoder_state::SessionMode::Default,
            "peer_source_owner_changed"
        );
        self.lease.verify_target(&self.history)?;
        ensure!(
            self.service.workspace_matches(&self.state.cwd()),
            "peer_source_workspace_changed"
        );
        self.service.require_enabled(false)
    }
    pub(crate) fn address(&self) -> Result<SessionAddressV1> {
        self.check_owner()?;
        self.service.address(&self.state.session_id())
    }
    /// Only the authenticated device channel asks for this fresh nonce-bound
    /// presence fact. It grants neither a send nor a destination permission.
    pub(crate) fn sign_presence(
        &self,
        nonce: &str,
    ) -> Result<kcoder_app_protocol::cross_session_router::SignedPeerSourcePresenceV1> {
        use kcoder_app_protocol::cross_session_router::{
            PEER_SOURCE_PRESENCE_PURPOSE, PeerSourcePresenceClaimsV1,
        };
        self.check_owner()?;
        let identity = self.service.identity()?;
        let claims = PeerSourcePresenceClaimsV1 {
            version: 1,
            purpose: PEER_SOURCE_PRESENCE_PURPOSE.into(),
            nonce: nonce.into(),
            source: self.address()?,
            identity_epoch: identity.identity_epoch,
            lease_id: self.lease_id.clone(),
        };
        let proof = self
            .service
            .authority()?
            .store()?
            .sign_source_presence(&claims)?;
        self.check_owner()?;
        Ok(proof)
    }
    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        if let Ok(mut admitted) = self.admitted.lock() {
            admitted.clear();
        }
    }
    pub(crate) fn communication_revoked(&self) -> bool {
        !self.active.load(Ordering::Acquire)
    }
    fn transfer_facts(&self, new: &Self) -> Result<()> {
        ensure!(
            self.address_identity == new.address_identity
                && self.state.shares_state_with(&new.state)
                && self.owner.same_lifecycle(&new.owner)
                && self.history == new.history
                && self.storage == new.storage,
            "peer_source_handoff_owner_changed"
        );
        self.lease.verify_target(&self.history)?;
        new.lease.verify_target(&new.history)?;
        let facts = self
            .admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
            .clone();
        *new.admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))? = facts;
        Ok(())
    }
    pub(crate) fn state(&self) -> &AppState {
        &self.state
    }
    pub(crate) fn storage_root(&self) -> &std::path::Path {
        &self.storage
    }
    pub(crate) fn owner(&self) -> &AppStateLifecycleIdentity {
        &self.owner
    }
    pub(crate) fn service(&self) -> &Arc<PeerMessageService> {
        &self.service
    }
    fn current_archived_at(&self) -> Result<Option<String>> {
        use std::ffi::OsStr;
        let root = match kcoder_config::PrivateDirectory::open_existing(&self.storage) {
            Ok(root) => root,
            // Session storage is created lazily. Without the root no archive metadata
            // can exist. Links, non-directories and permission errors still fail closed.
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        root.verify_trusted_config_directory()?;
        let id = self.state.session_id();
        let child = match root.open_child(OsStr::new(&id), false) {
            Ok(child) => child,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        child.verify_trusted_config_directory()?;
        let identity = child.directory_identity()?;
        let metadata = crate::app_server::session_discovery::session_directory::client_metadata_in(
            &child,
            &id,
            &self.state.cwd(),
        )?;
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&self.storage)?.directory_identity()?
                == root.directory_identity()?
                && root
                    .open_child(OsStr::new(&id), false)?
                    .directory_identity()?
                    == identity,
            "peer_source_metadata_changed"
        );
        Ok(metadata
            .and_then(|row| row.fields.get("archivedAt").cloned().flatten())
            .map(|value| {
                value
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(128)
                    .collect()
            }))
    }
    pub(crate) fn observe_status(
        &self,
    ) -> Result<kcoder_app_protocol::cross_session_messages::AgentMessageTarget> {
        use kcoder_app_protocol::{ThreadMainTurn, ThreadStatus, cross_session_messages::*};
        self.check_owner()?;
        let policy = self.service.policy()?;
        let archived_at = self.current_archived_at()?;
        let active = self.turns.current_identity();
        let active_turn_id = active
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .map(|identity| identity.turn_id.clone());
        let running = active_turn_id.is_some() || (self.activity)();
        let mut last_turn = None;
        let mut unresolved_attempts = false;
        if let Some(store) = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &self.artifacts,
            &self.state.session_id(),
        )? {
            match store.list_with_budget(
                crate::app_server::session_discovery::session_directory::MAX_STATUS_ATTEMPTS,
                crate::app_server::session_discovery::session_directory::MAX_STATUS_ATTEMPT_BYTES,
            ) {
                Ok(records) => {
                    unresolved_attempts = records.iter().any(|record| {
                        !record.status.is_terminal() || record.completion.is_none()
                    });
                    last_turn = latest_turn(&records);
                }
                Err(error)
                    if kcoder_state::turn_attempt_store::TurnAttemptStore::is_observation_budget_exhausted(&error) =>
                {
                    unresolved_attempts = true;
                }
                Err(error) => return Err(error),
            }
        }
        self.check_owner()?;
        let mut allowed_modes = vec![AgentMessageMode::EnqueueOnly];
        if policy.wake_idle {
            allowed_modes.push(AgentMessageMode::WakeIfIdle);
        }
        if archived_at.is_some()
            || self.state.channel_task_source().is_some()
            || self.state.agent_definition().is_some()
        {
            allowed_modes.clear();
        }
        Ok(AgentMessageTarget {
            thread_id: self.state.session_id(),
            address: Some(self.address()?),
            title: None,
            status: if active.is_err() || (!running && unresolved_attempts) {
                ThreadStatus::Unknown
            } else if running {
                ThreadStatus::Running
            } else {
                ThreadStatus::Idle
            },
            active_turn_id,
            presence: AgentMessageTargetPresence::Resident,
            run_summary: Some(AgentMessageTargetRunSummary {
                main_turn: if active.is_err() || (!running && unresolved_attempts) {
                    ThreadMainTurn::Unknown
                } else if running {
                    ThreadMainTurn::Running
                } else {
                    ThreadMainTurn::Idle
                },
                pending_approvals: None,
                pending_questions: None,
                active_jobs: None,
                tasks_pending: None,
                tasks_running: None,
                pending_followups: None,
                pending_goals: None,
            }),
            last_turn,
            archived_at,
            last_history_update_at_ms: None,
            allowed_modes,
        })
    }
    fn check_tool(&self, name: &str, input: &serde_json::Value) -> Result<()> {
        self.check_owner()?;
        let settings = self
            .settings
            .try_read()
            .map_err(|_| anyhow::anyhow!("peer_source_settings_busy"))?;
        ensure!(
            settings.model_capabilities.tools
                && !matches!(
                    settings.tools.profile,
                    ToolProfile::None | ToolProfile::Nano
                )
                && !ToolRegistry::name_is_disabled(name, &settings.tools.disabled),
            "peer_source_tool_disabled"
        );
        let contributions = self
            .contributions
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        let exists = match name {
            "ListSessions" => contributions
                .discovery
                .as_ref()
                .is_some_and(SessionDiscoveryContribution::is_current),
            "SendSessionMessage" => contributions
                .send
                .as_ref()
                .is_some_and(SessionMessageContribution::is_current),
            "ListSessionMessageReceipts" => contributions
                .list_receipts
                .as_ref()
                .is_some_and(SessionMessageContribution::is_current),
            "GetSessionMessageReceipt" => contributions
                .receipt
                .as_ref()
                .is_some_and(SessionMessageContribution::is_current),
            _ => false,
        };
        ensure!(exists, "peer_source_tool_contribution_changed");
        let permissions = self
            .permissions
            .try_read()
            .map_err(|_| anyhow::anyhow!("peer_source_permissions_busy"))?;
        ensure!(
            !permissions.is_explicitly_denied(name, input),
            "peer_source_permission_denied"
        );
        Ok(())
    }
    pub(crate) fn check_message_call(
        &self,
        call: &SessionMessageCall,
        input: &serde_json::Value,
    ) -> Result<()> {
        match call.owner().try_matches(call.state()) {
            Some(true) => {}
            Some(false) => anyhow::bail!("peer_source_call_owner_changed"),
            None => anyhow::bail!("peer_source_busy"),
        }
        ensure!(
            self.owner.same_lifecycle(call.owner()) && self.state.shares_state_with(call.state()),
            "peer_source_call_owner_changed"
        );
        self.check_tool(call.tool_name(), input)?;
        let contributions = self
            .contributions
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        let contribution = match call.tool_name() {
            "SendSessionMessage" => contributions.send.as_ref(),
            "GetSessionMessageReceipt" => contributions.receipt.as_ref(),
            "ListSessionMessageReceipts" => contributions.list_receipts.as_ref(),
            _ => None,
        };
        ensure!(
            contribution.is_some_and(|token| token.matches_call(call)),
            "peer_source_call_contribution_changed"
        );
        Ok(())
    }
    pub(crate) fn check_discovery_call(
        &self,
        call: &SessionDiscoveryCall,
        input: &serde_json::Value,
    ) -> Result<()> {
        ensure!(call.matches(&self.state), "peer_source_call_owner_changed");
        self.check_tool("ListSessions", input)?;
        ensure!(
            self.contributions
                .lock()
                .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
                .discovery
                .as_ref()
                .is_some_and(|token| token.matches_call(call)),
            "peer_source_call_contribution_changed"
        );
        Ok(())
    }
    /// The caller invokes this only at the actual authorized source admission.
    /// A private RPC uses its original runtime; model calls additionally prove their contribution.
    pub(crate) fn remember_authorized_intent(&self, intent: &AgentMessageIntent) -> Result<()> {
        intent.validate().map_err(anyhow::Error::msg)?;
        self.check_tool("SendSessionMessage", &serde_json::to_value(intent)?)?;
        self.service.require_enabled(false)?;
        let mut canonical = intent.clone();
        if canonical.target_address.is_none() {
            canonical.target_address = Some(self.service.address(&intent.target_thread_id)?);
        }
        self.check_tool("SendSessionMessage", &serde_json::to_value(&canonical)?)?;
        let prior = self
            .admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
            .get(&intent.client_message_id)
            .cloned();
        if let Some(prior) = &prior {
            ensure!(
                prior.canonical == canonical,
                "peer_source_original_intent_conflict"
            );
        }
        let mut reply = None;
        if let Some(id) = canonical.reply_to_message_id.as_deref() {
            let source = self.address()?;
            let destination = canonical
                .target_address
                .as_ref()
                .context("peer_source_address_required")?;
            let operation_id =
                PeerMessageService::operation_id(&source, &canonical.client_message_id)?;
            let authority = self.service.authority()?;
            if let Some(original) = authority.store()?.read_operation(&operation_id)? {
                let claims = &original.attestation.claims;
                ensure!(
                    claims.source_address == source
                        && claims.destination == *destination
                        && claims.client_message_id == canonical.client_message_id
                        && claims.mode == canonical.mode
                        && claims.expected_turn_id == canonical.expected_turn_id
                        && claims.reply_to_message_id == canonical.reply_to_message_id
                        && claims.body_sha256
                            == format!("{:x}", Sha256::digest(canonical.text.as_bytes())),
                    "peer_source_original_intent_conflict"
                );
                crate::app_server::session_messages::router_store::verify_peer_attestation(
                    &original.attestation,
                    &self.service.identity()?,
                )?;
            } else if let Some(witness) = prior.as_ref().and_then(|prior| prior.reply.as_ref()) {
                witness.verify_current(&source, destination, id)?;
                reply = Some(witness.clone());
            } else {
                reply = Some(self.state.capture_peer_reply_reference(
                    &self.owner,
                    &source,
                    destination,
                    id,
                )?);
            }
        }
        let mut admitted = self
            .admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        if let Some(original) = admitted.get_mut(&intent.client_message_id) {
            ensure!(
                original.canonical == canonical,
                "peer_source_original_intent_conflict"
            );
            original.reply = reply;
            return Ok(());
        }
        ensure!(admitted.len() < 128, "peer_source_operation_capacity");
        admitted.insert(
            intent.client_message_id.clone(),
            AdmittedIntent {
                canonical,
                original: intent.clone(),
                reply,
            },
        );
        Ok(())
    }
    fn check_admitted_current(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        ensure!(
            source.shares_state_with(&self.state) && self.owner.same_lifecycle(owner),
            "peer_source_admission_owner_changed"
        );
        self.check_owner()?;
        let mut canonical = intent.clone();
        if canonical.target_address.is_none() {
            canonical.target_address = Some(self.service.address(&intent.target_thread_id)?);
        }
        let admitted = self
            .admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
            .get(&intent.client_message_id)
            .cloned()
            .context("peer_source_original_admission_unavailable")?;
        ensure!(
            admitted.canonical == canonical,
            "peer_source_original_intent_changed"
        );
        self.check_tool(
            "SendSessionMessage",
            &serde_json::to_value(&admitted.original)?,
        )?;
        self.check_tool("SendSessionMessage", &serde_json::to_value(&canonical)?)?;
        if let Some(witness) = &admitted.reply {
            witness.verify_current(
                &self.address_identity,
                canonical.target_address.as_ref().unwrap(),
                canonical.reply_to_message_id.as_deref().unwrap(),
            )?;
        }
        Ok(())
    }
    pub(crate) fn check_original(
        &self,
        check: &OriginalSourceCheck,
    ) -> Result<PeerRouterOperationV1> {
        check.validate()?;
        self.check_owner()?;
        let admitted = self
            .admitted
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
            .get(&check.client_message_id)
            .cloned()
            .context("peer_source_original_admission_unavailable")?;
        ensure!(
            OriginalSourceCheck::for_intent(&admitted.canonical)? == *check,
            "peer_source_original_intent_changed"
        );
        self.remember_authorized_intent(&admitted.original)?;
        let source = self.address()?;
        let authority = self.service.authority()?;
        let operation = authority
            .store()?
            .find_source_operation(
                &source,
                &kcoder_app_protocol::cross_session_messages::AgentMessageGetParams {
                    client_message_id: Some(check.client_message_id.clone()),
                    message_id: None,
                },
            )?
            .context("peer_source_original_operation_unavailable")?;
        let claims = &operation.attestation.claims;
        ensure!(
            claims.source_address == source
                && claims.destination == check.destination
                && claims.client_message_id == check.client_message_id
                && claims.mode == check.mode
                && claims.expected_turn_id == check.expected_turn_id
                && claims.reply_to_message_id == check.reply_to_message_id
                && claims.body_sha256 == check.body_sha256,
            "peer_source_original_operation_changed"
        );
        crate::app_server::session_messages::router_store::verify_peer_attestation(
            &operation.attestation,
            &self.service.identity()?,
        )?;
        self.check_owner()?;
        Ok(operation)
    }
}
impl LocalPeerSourceAuthorization for BoundPeerSource {
    fn check_current(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        ensure!(
            source.shares_state_with(&self.state) && self.owner.same_lifecycle(owner),
            "peer_source_admission_owner_changed"
        );
        self.remember_authorized_intent(intent)
    }
    fn check_before_queue_commit(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        self.check_admitted_current(source, owner, intent)
    }
}
impl crate::app_server::session_messages::service::LivePeerSource for BoundPeerSource {
    fn verify_reply_attempt(
        &self,
        attempt: &kcoder_types::TurnAttemptIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        attempt.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            attempt.thread_id == self.state.session_id()
                && self
                    .turns
                    .current_identity()
                    .map_err(anyhow::Error::msg)?
                    .as_ref()
                    == Some(attempt)
                && intent.reply_to_message_id.is_some(),
            "peer_reply_attempt_changed"
        );
        self.check_admitted_current(&self.state, &self.owner, intent)?;
        ensure!(
            self.turns
                .current_identity()
                .map_err(anyhow::Error::msg)?
                .as_ref()
                == Some(attempt),
            "peer_reply_attempt_changed"
        );
        Ok(())
    }
    fn source_admission_history(
        &self,
    ) -> Result<Option<kcoder_state::PeerSourceAdmissionHistoryWitness>> {
        self.check_owner()?;
        let witness = match self.state.peer_source_admission_history(&self.owner) {
            Ok(witness) => Some(witness),
            Err(error) if error.is::<kcoder_state::PeerSourceHistoryEmptyUncommitted>() => None,
            Err(error) => return Err(error),
        };
        self.check_owner()?;
        Ok(witness)
    }
    fn admit_original(&self, intent: &AgentMessageIntent) -> Result<()> {
        self.remember_authorized_intent(intent)
    }
    fn address(&self) -> Result<SessionAddressV1> {
        BoundPeerSource::address(self)
    }
    fn verify_original(
        &self,
        claims: &kcoder_app_protocol::cross_session_router::PeerMessageAttestationClaimsV1,
    ) -> Result<PeerRouterOperationV1> {
        ensure!(
            claims.source_address == self.address()?,
            "peer_source_original_owner_changed"
        );
        let operation = self.check_original(&OriginalSourceCheck {
            client_message_id: claims.client_message_id.clone(),
            destination: claims.destination.clone(),
            mode: claims.mode,
            expected_turn_id: claims.expected_turn_id.clone(),
            body_sha256: claims.body_sha256.clone(),
            reply_to_message_id: claims.reply_to_message_id.clone(),
        })?;
        ensure!(
            operation.attestation.claims == *claims,
            "peer_source_original_operation_changed"
        );
        Ok(operation)
    }
}
#[cfg(all(test, target_os = "linux"))]
#[path = "peer_sessions/tests.rs"]
mod tests;
