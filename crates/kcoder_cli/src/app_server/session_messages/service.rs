//! Profile-owned peer service shared by Native RPC and local independent sessions.
use super::{
    policy::PeerMessagePolicy,
    router_authority::{NativePeerRouterAuthority, PeerRouterConnectionGuard},
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    RetentionParentLaunchV1,
    cross_session_messages::{AgentMessageGetParams, AgentMessagePolicyResult},
    cross_session_router::{
        PeerMessageAttestationClaimsV1, PeerRouterIdentityV1, PeerRouterOperationV1,
    },
};
use kcoder_config::ConfigPaths;
use kcoder_state::{
    AppState, AppStateLifecycleIdentity,
    cross_session_messages::{CrossSessionMessageRecord, CrossSessionMessageStore},
};
use kcoder_types::cross_session_messages::{
    AgentMessageIntent, AgentMessageMode, AgentMessageReceipt, CrossSessionMessageSource,
};
use kcoder_types::session_address::SessionAddressV1;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[path = "service/local_admission.rs"]
mod local_admission;
mod receipt_details;
pub(crate) use local_admission::{LocalTargetSnapshot, local_send_error};
pub(crate) use receipt_details::OutgoingReceiptRead;

type SourceRegistry = BTreeMap<SessionAddressV1, Weak<dyn LivePeerSource>>;
#[cfg(test)]
#[path = "service/local_admission_tests.rs"]
mod local_admission_tests;
fn source_registry() -> &'static Mutex<SourceRegistry> {
    static SOURCES: OnceLock<Mutex<SourceRegistry>> = OnceLock::new();
    SOURCES.get_or_init(Mutex::default)
}

/// Original launch facts, captured before processing client JSON.
#[derive(Clone)]
pub struct PeerRouterLaunch {
    pub parent: RetentionParentLaunchV1,
    pub account_root: PathBuf,
}
struct BoundNative {
    authority: Arc<NativePeerRouterAuthority>,
    mailbox: Option<Arc<CrossSessionMessageStore>>,
    _close: PeerRouterConnectionGuard,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum PeerStartupMode {
    IndependentLocal,
    EnrolledV2Selected,
}
pub struct PeerMessageService {
    paths: ConfigPaths,
    cwd: PathBuf,
    launch: PeerRouterLaunch,
    private_parent: bool,
    startup_mode: PeerStartupMode,
    ssh_parent: Option<Arc<super::ssh_parent::CapturedPeerSshParent>>,
    #[cfg(target_os = "linux")]
    enrolled_parent: OnceLock<Arc<super::ssh_enrolled::CapturedEnrolledSshParent>>,
    policy: PeerMessagePolicy,
    native: Mutex<Option<BoundNative>>,
    cold_source: Mutex<Option<Weak<dyn super::router_rpc::ColdPeerSourceVerifier>>>,
    cold_target_owner: Mutex<Option<tokio_util::sync::CancellationToken>>,
    closed: AtomicBool,
}
/// A host binds this to its actual source runtime; a record or model JSON cannot implement it.
pub trait LocalPeerSourceAuthorization: Send + Sync {
    fn check_current(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()>;
    /// Fresh native liveness/permission only. Must not open a router transaction
    /// while the destination queue lock is held; no new intent is remembered here.
    fn check_before_queue_commit(
        &self,
        _source: &AppState,
        _owner: &AppStateLifecycleIdentity,
        _intent: &AgentMessageIntent,
    ) -> Result<()> {
        anyhow::bail!("peer_message_original_admission_required")
    }
}
/// An actual owned runtime, registered by a host; never a deserialized allow verdict.
pub trait LivePeerSource: LocalPeerSourceAuthorization {
    /// Recheck the original running turn and previously admitted reply intent.
    fn verify_reply_attempt(
        &self,
        _attempt: &kcoder_types::TurnAttemptIdentity,
        _intent: &AgentMessageIntent,
    ) -> Result<()> {
        anyhow::bail!("peer_reply_attempt_unavailable")
    }
    fn source_admission_history(
        &self,
    ) -> Result<Option<kcoder_state::PeerSourceAdmissionHistoryWitness>> {
        Ok(None)
    }
    fn address(&self) -> Result<SessionAddressV1>;
    fn admit_original(&self, intent: &AgentMessageIntent) -> Result<()>;
    fn verify_original(
        &self,
        claims: &PeerMessageAttestationClaimsV1,
    ) -> Result<PeerRouterOperationV1>;
}
impl PeerMessageService {
    pub fn capture(
        paths: ConfigPaths,
        cwd: PathBuf,
        launch: Option<PeerRouterLaunch>,
    ) -> Result<Arc<Self>> {
        Self::capture_inner(paths, cwd, launch, None, PeerStartupMode::IndependentLocal)
    }
    pub(crate) fn capture_native(
        paths: ConfigPaths,
        cwd: PathBuf,
        launch: Option<PeerRouterLaunch>,
        ssh_launch: Option<&super::ssh_parent::PeerSshLaunch>,
    ) -> Result<Arc<Self>> {
        ensure!(
            launch.is_none() || ssh_launch.is_none(),
            "peer_ssh_parent_purpose_conflict"
        );
        let ssh_parent = match ssh_launch {
            Some(super::ssh_parent::PeerSshLaunch::Enrolled(_)) => None,
            selection
                if kcoder_host_transport::ssh_peer_pins::may_attempt_legacy_kernel_capture(
                    &paths.config_dir,
                )
                .unwrap_or(false) =>
            {
                let nonce = selection.and_then(|selection| match selection {
                    super::ssh_parent::PeerSshLaunch::KernelNonce(nonce) => Some(nonce.as_str()),
                    _ => None,
                });
                super::ssh_parent::CapturedPeerSshParent::capture(nonce)
                    .ok()
                    .map(Arc::new)
            }
            _ => None,
        };
        let mode = if matches!(
            ssh_launch,
            Some(super::ssh_parent::PeerSshLaunch::Enrolled(_))
        ) {
            PeerStartupMode::EnrolledV2Selected
        } else {
            PeerStartupMode::IndependentLocal
        };
        let service = Self::capture_inner(paths, cwd, launch, ssh_parent, mode)?;
        if let Some(super::ssh_parent::PeerSshLaunch::Enrolled(selector)) = ssh_launch {
            #[cfg(target_os = "linux")]
            {
                let capture = (|| -> Result<()> {
                    let authority = service.authority()?;
                    let parent = super::ssh_enrolled::CapturedEnrolledSshParent::capture(
                        &authority, selector,
                    )?;
                    if let Err(error) = authority.install_transport_fence(parent.clone()) {
                        parent.close();
                        return Err(error);
                    }
                    service
                        .enrolled_parent
                        .set(parent)
                        .map_err(|_| anyhow::anyhow!("peer_ssh_parent_already_bound"))?;
                    Ok(())
                })();
                if capture.is_err() {
                    tracing::debug!(
                        code = "peer_ssh_pin_unavailable",
                        "Explicit SSH peer transport unavailable"
                    );
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = selector;
            }
        }
        Ok(service)
    }
    fn capture_inner(
        paths: ConfigPaths,
        cwd: PathBuf,
        launch: Option<PeerRouterLaunch>,
        ssh_parent: Option<Arc<super::ssh_parent::CapturedPeerSshParent>>,
        startup_mode: PeerStartupMode,
    ) -> Result<Arc<Self>> {
        let private_parent =
            launch.is_some() || ssh_parent.as_ref().is_some_and(|parent| parent.ready());
        let launch = launch.unwrap_or_else(|| PeerRouterLaunch {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: paths.config_dir.clone(),
        });
        let policy = PeerMessagePolicy::capture(paths.clone())?;
        let service = Arc::new(Self {
            paths,
            cwd,
            launch,
            private_parent,
            startup_mode,
            ssh_parent,
            #[cfg(target_os = "linux")]
            enrolled_parent: OnceLock::new(),
            policy,
            native: Mutex::new(None),
            cold_source: Mutex::new(None),
            cold_target_owner: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        // This is a profile load boundary. Ordinary reads never initialize a missing queue.
        service.load_native(service.policy.read()?.enabled)?;
        Ok(service)
    }
    fn load_native(&self, allow_create: bool) -> Result<()> {
        let mut native = self
            .native
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "peer_message_host_closed"
        );
        if let Some(bound) = &mut *native {
            bound.authority.verify()?;
            if allow_create && bound.mailbox.is_none() {
                let identity = bound.authority.identity()?;
                bound.mailbox = bound
                    .authority
                    .store()?
                    .workspace_mailbox(&identity.workspace_id, true)?
                    .map(Arc::new);
            }
            return Ok(());
        }
        if let Some(authority) = NativePeerRouterAuthority::capture(
            &self.launch.parent,
            &self.launch.account_root,
            &self.paths.config_dir,
            &self.cwd,
            allow_create,
        )? {
            let authority =
                if let Some(parent) = self.ssh_parent.as_ref().filter(|parent| parent.ready()) {
                    authority.with_transport_fence(Arc::new(
                        super::ssh_parent::LegacySshProfileFence::capture(
                            parent.clone(),
                            &self.paths.config_dir,
                        )?,
                    ))?
                } else {
                    authority
                };
            let authority = Arc::new(authority);
            let identity = authority.identity()?;
            let mailbox = authority
                .store()?
                .workspace_mailbox(&identity.workspace_id, allow_create)?
                .map(Arc::new);
            let close = authority.close_guard();
            *native = Some(BoundNative {
                authority,
                mailbox,
                _close: close,
            });
        }
        Ok(())
    }
    pub fn has_private_parent(&self) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        #[cfg(target_os = "linux")]
        if self
            .enrolled_parent
            .get()
            .is_some_and(|parent| parent.completed())
        {
            return self.identity().is_ok();
        }
        self.private_parent
            && self.ssh_parent.as_ref().is_none_or(|parent| {
                parent.verify().is_ok()
                    && kcoder_host_transport::ssh_peer_pins::may_attempt_legacy_kernel_capture(
                        &self.paths.config_dir,
                    )
                    .unwrap_or(false)
            })
    }
    /// Only an actual V2 startup selection requires its completed transport for
    /// cold actions. Failed capture must not become an independent local lane.
    pub(crate) fn check_selected_cold_transport(&self) -> Result<()> {
        ensure!(
            self.startup_mode != PeerStartupMode::EnrolledV2Selected || self.has_private_parent(),
            "peer_cold_target_selected_transport_unavailable"
        );
        Ok(())
    }
    /// Resource preparation only; every eventual cold/private use checks the
    /// completed parent again. A pending stored pin never permits a route.
    pub(crate) fn can_prepare_private_services(&self) -> bool {
        if self.has_private_parent() {
            return true;
        }
        #[cfg(target_os = "linux")]
        {
            self.enrolled_parent.get().is_some() && self.identity().is_ok()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
    pub(crate) fn authenticate_enrolled_ssh(
        &self,
        request: &kcoder_app_protocol::cross_session_router::ssh_enrollment::PeerSshAuthRequestV1,
    ) -> Result<serde_json::Value> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = request;
            anyhow::bail!("peer_ssh_enrollment_platform_unavailable");
        }
        #[cfg(target_os = "linux")]
        {
            use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
            ensure!(
                !self.closed.load(Ordering::Acquire),
                "peer_ssh_connection_closed"
            );
            let parent = self
                .enrolled_parent
                .get()
                .context("peer_ssh_pinned_enrollment_missing")?;
            match request.method.as_str() {
                PEER_SSH_AUTH_OFFER => Ok(serde_json::to_value(
                    parent.offer(request.params().map_err(anyhow::Error::msg)?)?,
                )?),
                PEER_SSH_AUTH_NATIVE_PROOF => Ok(serde_json::to_value(
                    parent.native_proof(request.params().map_err(anyhow::Error::msg)?)?,
                )?),
                PEER_SSH_AUTH_COMPLETE => Ok(serde_json::to_value(
                    parent.complete(request.params().map_err(anyhow::Error::msg)?)?,
                )?),
                _ => anyhow::bail!("peer_ssh_auth_method_unavailable"),
            }
        }
    }
    pub(crate) fn peer_ssh_offer(&self) -> bool {
        kcoder_host_transport::ssh_peer_pins::may_attempt_legacy_kernel_capture(
            &self.paths.config_dir,
        )
        .unwrap_or(false)
            && self
                .ssh_parent
                .as_ref()
                .is_some_and(|parent| parent.verify().is_ok())
            && self.identity().is_ok()
    }
    pub(crate) fn peer_backchannel_ready(&self) -> bool {
        self.has_private_parent() && self.ssh_parent.as_ref().is_none_or(|parent| parent.bound())
    }
    pub(crate) fn bind_peer_ssh_parent(
        &self,
        request: kcoder_app_protocol::cross_session_router::ssh_parent::PeerSshParentBindParamsV1,
    ) -> Result<kcoder_app_protocol::cross_session_router::ssh_parent::PeerSshParentBindingV1> {
        self.ssh_parent
            .as_ref()
            .context("peer_ssh_parent_unavailable")?
            .bind(request, self.identity()?)
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(parent) = &self.ssh_parent {
            parent.close();
        }
        #[cfg(target_os = "linux")]
        if let Some(parent) = self.enrolled_parent.get() {
            parent.close();
        }
        if let Ok(native) = self.native.lock()
            && let Some(bound) = &*native
        {
            bound.authority.close();
        }
    }
    pub fn profile_path(&self) -> &Path {
        &self.paths.config_dir
    }
    pub(crate) fn message_capabilities(
        &self,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterCapabilitiesV1> {
        self.authority()?.verify()?;
        use kcoder_app_protocol::cross_session_messages::*;
        Ok(
            kcoder_app_protocol::cross_session_router::PeerRouterCapabilitiesV1 {
                capabilities: vec![
                    CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1.into(),
                    CAPABILITY_CROSS_SESSION_MESSAGE_RECEIPTS_V1.into(),
                ],
            },
        )
    }
    /// The actual outer runtime owns the reader. This weak locator never
    /// extends its native lease or caches a source authorization verdict.
    pub(crate) fn install_cold_source_verifier(
        &self,
        verifier: &Arc<dyn super::router_rpc::ColdPeerSourceVerifier>,
    ) -> Result<()> {
        self.authority()?.verify()?;
        *self
            .cold_source
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_cold_source_owner_busy"))? =
            Some(Arc::downgrade(verifier));
        Ok(())
    }
    pub(crate) fn cold_source_verifier(
        &self,
    ) -> Result<Option<Arc<dyn super::router_rpc::ColdPeerSourceVerifier>>> {
        self.authority()?.verify()?;
        Ok(self
            .cold_source
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_cold_source_owner_busy"))?
            .as_ref()
            .and_then(Weak::upgrade))
    }
    pub fn live_registry(
        &self,
        allow_create: bool,
    ) -> Result<Option<kcoder_config::PrivateDirectory>> {
        if allow_create {
            self.require_enabled(false)?;
        } else {
            self.authority()?.verify()?;
        }
        let profile = kcoder_config::PrivateDirectory::open_existing(&self.paths.config_dir)?;
        profile.verify_private_directory()?;
        let name = OsStr::new("peer-live-v1");
        let directory = match profile.open_entry_handle(name) {
            Ok(entry) => entry.open_child_directory()?,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                if !allow_create {
                    return Ok(None);
                }
                match profile.create_private_child(name) {
                    Ok(directory) => directory,
                    Err(_) => profile.open_entry_handle(name)?.open_child_directory()?,
                }
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        self.authority()?.verify()?;
        Ok(Some(directory))
    }
    pub fn register_live_source(&self, source: Arc<dyn LivePeerSource>) -> Result<()> {
        let address = source.address()?;
        ensure!(
            self.identity()?.contains(&address),
            "peer_message_source_scope_changed"
        );
        let mut sources = source_registry()
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        sources.retain(|_, source| source.strong_count() > 0);
        ensure!(
            sources.contains_key(&address) || sources.len() < 1024,
            "peer_message_source_capacity"
        );
        sources.insert(address, Arc::downgrade(&source));
        Ok(())
    }
    pub fn local_source(
        &self,
        source: &SessionAddressV1,
    ) -> Result<Option<Arc<dyn LivePeerSource>>> {
        self.authority()?.verify()?;
        let sources = source_registry()
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        Ok(sources.get(source).and_then(Weak::upgrade))
    }
    pub fn policy(&self) -> Result<AgentMessagePolicyResult> {
        self.policy.read()
    }
    pub fn save_policy(
        &self,
        expected: &str,
        enabled: bool,
        wake_idle: bool,
    ) -> Result<AgentMessagePolicyResult> {
        let observation = self.policy.save(expected, enabled, wake_idle)?;
        if enabled {
            self.load_native(true)?;
        }
        Ok(observation)
    }
    pub fn require_enabled(&self, wake: bool) -> Result<()> {
        let policy = self.policy.read()?;
        ensure!(
            policy.enabled && (!wake || policy.wake_idle),
            "peer_message_policy_denied"
        );
        self.authority()?.verify()
    }
    pub(crate) fn bind_cold_target_owner(
        &self,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        *self
            .cold_target_owner
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_cold_owner_busy"))? = Some(cancel);
        Ok(())
    }
    pub(crate) fn cold_target_modes(&self) -> Result<Vec<AgentMessageMode>> {
        self.require_enabled(false)?;
        let mut modes = vec![AgentMessageMode::EnqueueOnly];
        if self.policy()?.wake_idle
            && self
                .cold_target_owner
                .lock()
                .map_err(|_| anyhow::anyhow!("peer_cold_owner_busy"))?
                .as_ref()
                .is_some_and(|owner| !owner.is_cancelled())
        {
            modes.push(AgentMessageMode::WakeIfIdle);
        }
        Ok(modes)
    }
    pub fn admission_settings(&self) -> Result<kcoder_config::CrossSessionMessagesSettings> {
        self.authority()?.verify()?;
        let settings = self.policy.read_settings()?;
        ensure!(settings.enabled, "peer_message_policy_denied");
        self.authority()?.verify()?;
        Ok(settings)
    }
    pub(crate) fn prepare_source_operation(
        &self,
        operation_id: &str,
        source: SessionAddressV1,
        intent: &AgentMessageIntent,
    ) -> Result<PeerRouterOperationV1> {
        let settings = self.admission_settings()?;
        let authority = self.authority()?;
        authority.store()?.prepare_with_rate_policy(
            operation_id,
            source,
            intent,
            super::router_store::SourcePrepareRatePolicy {
                max_messages_per_minute: settings.max_messages_per_minute,
                max_source_messages_per_minute: settings.max_source_messages_per_minute,
            },
        )
    }
    pub fn authority(&self) -> Result<Arc<NativePeerRouterAuthority>> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "peer_message_host_closed"
        );
        let native = self
            .native
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        let authority = native
            .as_ref()
            .context("peer_message_profile_not_enabled")?
            .authority
            .clone();
        authority.verify()?;
        Ok(authority)
    }
    pub fn identity(&self) -> Result<PeerRouterIdentityV1> {
        self.authority()?.identity()
    }
    pub fn address(&self, thread_id: &str) -> Result<SessionAddressV1> {
        let identity = self.identity()?;
        let address = SessionAddressV1 {
            target_id: identity.target_id,
            workspace_id: identity.workspace_id,
            thread_id: thread_id.into(),
        };
        address.validate().map_err(anyhow::Error::msg)?;
        Ok(address)
    }
    pub fn mailbox(&self) -> Result<Arc<CrossSessionMessageStore>> {
        let native = self
            .native
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        let bound = native
            .as_ref()
            .context("peer_message_profile_not_enabled")?;
        bound.authority.verify()?;
        bound
            .mailbox
            .clone()
            .context("peer_message_original_mailbox_unavailable")
    }
    pub fn has_loaded_mailbox(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self
                .native
                .try_lock()
                .is_ok_and(|native| native.as_ref().is_some_and(|bound| bound.mailbox.is_some()))
    }
    /// Idle observations never initialize a namespace or turn contention into absence.
    pub(crate) fn try_loaded_mailbox_for_idle(
        &self,
    ) -> Result<Option<Arc<CrossSessionMessageStore>>> {
        let native = self
            .native
            .try_lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "peer_message_host_closed"
        );
        Ok(native.as_ref().and_then(|bound| bound.mailbox.clone()))
    }
    /// Nonblocking while the caller holds a queue read lease. Full transport
    /// cleanup follows after that lease is released, without a lock inversion.
    pub(crate) fn begin_idle_close(
        &self,
        expected: Option<&Arc<CrossSessionMessageStore>>,
    ) -> Result<()> {
        let native = self
            .native
            .try_lock()
            .map_err(|_| anyhow::anyhow!("peer_message_host_busy"))?;
        let actual = native.as_ref().and_then(|bound| bound.mailbox.as_ref());
        ensure!(
            match (actual, expected) {
                (None, None) => true,
                (Some(actual), Some(expected)) => Arc::ptr_eq(actual, expected),
                _ => false,
            },
            "peer_message_idle_mailbox_changed"
        );
        self.closed.store(true, Ordering::Release);
        if let Some(bound) = &*native {
            bound.authority.close();
        }
        Ok(())
    }
    /// Queue expiry is owned housekeeping, independent of whether a target is resident.
    /// It never initializes a namespace, writes history or grants model execution.
    pub fn maintain_mailbox(&self) -> Result<()> {
        self.authority()?.verify()?;
        let store = self.mailbox()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .context("peer_message_clock_unavailable")?
            .as_millis();
        let now = u64::try_from(now).context("peer_message_clock_unavailable")?;
        store.maintain(now)?;
        self.authority()?.verify()
    }
    pub fn workspace_matches(&self, cwd: &std::path::Path) -> bool {
        dunce::canonicalize(cwd)
            .is_ok_and(|cwd| dunce::canonicalize(&self.cwd).is_ok_and(|own| own == cwd))
    }
    pub fn message_source(&self, thread_id: &str) -> Result<CrossSessionMessageSource> {
        let identity = self.identity()?;
        Ok(CrossSessionMessageSource {
            thread_id: thread_id.into(),
            principal_id: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "kcoder.peer-message.source.v1",
                    &identity.target_id,
                    &identity.identity_epoch,
                ))?)
            ),
            address: Some(self.address(thread_id)?),
        })
    }
    pub fn operation_id(source: &SessionAddressV1, client_message_id: &str) -> Result<String> {
        source.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            kcoder_types::cross_session_messages::valid_agent_message_id(client_message_id),
            "peer_message_invalid_identity"
        );
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&[
                "kcoder.peer-message.router-operation.v1",
                &source.target_id,
                &source.workspace_id,
                &source.thread_id,
                client_message_id,
            ])?)
        ))
    }
    /// A real source can seal its immutable operation before asking an
    /// authenticated router to reach a different target. This never admits a
    /// destination queue or substitutes a signature for destination authority.
    pub fn prepare_original(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        authority: &dyn LocalPeerSourceAuthorization,
        intent: &AgentMessageIntent,
    ) -> Result<PeerRouterOperationV1> {
        self.require_enabled(false)?;
        ensure!(
            self.workspace_matches(&source.cwd()) && owner.try_matches(source) == Some(true),
            "peer_message_source_changed"
        );
        intent.validate().map_err(anyhow::Error::msg)?;
        let destination = intent
            .target_address
            .as_ref()
            .context("peer_message_target_address_required")?;
        let source_address = self.address(&source.session_id())?;
        ensure!(&source_address != destination, "peer_message_self_target");
        authority.check_current(source, owner, intent)?;
        let id = Self::operation_id(&source_address, &intent.client_message_id)?;
        let authority = self.authority()?;
        let store = authority.store()?;
        let operation = self.prepare_source_operation(&id, source_address, intent)?;
        self.record_source_history_from_state(store, &id, source, owner)?;
        Ok(operation)
    }
    fn record_source_history_from_state(
        &self,
        store: &super::router_store::NativePeerRouterStore,
        operation_id: &str,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<()> {
        match source.peer_source_admission_history(owner) {
            Ok(witness) => store.record_source_history(operation_id, &witness),
            Err(error) if error.is::<kcoder_state::PeerSourceHistoryEmptyUncommitted>() => Ok(()),
            Err(error) => Err(error),
        }
    }
    /// Provenance only. A destination still needs the original source's fresh
    /// native permission check and its own current authorization before commit.
    pub fn verify_local_origin(
        &self,
        record: &CrossSessionMessageRecord,
    ) -> Result<PeerRouterOperationV1> {
        let operation =
            self.read_local_source_operation(&record.source, &record.intent.client_message_id)?;
        let claims = &operation.attestation.claims;
        ensure!(
            record.intent.target_address.as_ref() == Some(&claims.destination)
                && record.intent.target_thread_id == claims.destination.thread_id
                && record.intent.mode == claims.mode
                && record.intent.expected_turn_id == claims.expected_turn_id
                && record.intent.reply_to_message_id == claims.reply_to_message_id
                && format!("{:x}", Sha256::digest(record.intent.text.as_bytes()))
                    == claims.body_sha256,
            "peer_message_original_intent_changed"
        );
        Ok(operation)
    }
    /// Receipt provenance survives payload retirement. No empty replacement
    /// body is manufactured, and these facts never authorize a new delivery.
    pub fn verify_local_receipt_binding(
        &self,
        binding: &kcoder_state::cross_session_messages::CrossSessionReceiptBinding,
    ) -> Result<PeerRouterOperationV1> {
        let operation =
            self.read_local_source_operation(&binding.source, &binding.receipt.client_message_id)?;
        let claims = &operation.attestation.claims;
        ensure!(
            binding.target_address.as_ref() == Some(&claims.destination)
                && binding.target_thread_id == claims.destination.thread_id
                && binding.mode == claims.mode
                && binding.expected_turn_id == claims.expected_turn_id
                && binding.reply_to_message_id == claims.reply_to_message_id
                && binding.body_sha256 == claims.body_sha256,
            "peer_message_original_intent_changed"
        );
        Ok(operation)
    }
    fn read_local_source_operation(
        &self,
        actual_source: &CrossSessionMessageSource,
        client_message_id: &str,
    ) -> Result<PeerRouterOperationV1> {
        let source = actual_source
            .address
            .as_ref()
            .context("peer_message_source_address_required")?;
        let identity = self.identity()?;
        ensure!(
            identity.contains(source),
            "peer_message_remote_source_requires_route"
        );
        let native_source = self.message_source(&source.thread_id)?;
        ensure!(
            *actual_source == native_source,
            "peer_message_source_binding_changed"
        );
        let operation = self
            .authority()?
            .store()?
            .find_source_operation(
                source,
                &AgentMessageGetParams {
                    message_id: None,
                    client_message_id: Some(client_message_id.into()),
                },
            )?
            .context("peer_message_original_operation_missing")?;
        let claims = &operation.attestation.claims;
        ensure!(
            claims.source_address == *source && claims.client_message_id == client_message_id,
            "peer_message_source_binding_changed"
        );
        super::router_store::verify_peer_attestation(&operation.attestation, &identity)?;
        Ok(operation)
    }
}
