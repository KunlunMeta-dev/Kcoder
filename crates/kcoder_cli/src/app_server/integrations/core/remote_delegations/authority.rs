//! Actual accepted caller + independent first-party profile authority for the initial text-only boundary.
use super::super::NativeIntegrationContext;
#[cfg(test)]
use super::super::{NativeDomain, NativeDomainGuard};
use super::{
    NativeRemoteAuthority,
    registry::{NativeFirstPartyPeer, NativeRemoteRegistry},
    source_budget::NativeRemoteSourceBudget,
};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{InstalledOutboundRunner, OutboundEffect};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::{
    AppStateIdentity,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_tools::ToolContext;
#[cfg(test)]
use kcoder_types::integrations::core::IntegrationNullable;
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct AcceptedRemoteAuthority {
    sender: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateIdentity,
    accepted: TurnAttemptRecord,
    caller: ToolContext,
    registry: NativeRemoteRegistry,
    peer: NativeFirstPartyPeer,
    identity: Value,
    prompt: String,
    deadline: tokio::time::Instant,
    session: Mutex<Option<String>>,
    launch_environment: BTreeMap<OsString, OsString>,
    source_budget: Option<Arc<NativeRemoteSourceBudget>>,
}
impl AcceptedRemoteAuthority {
    /// The registered Tool calls this only after the ordinary Engine permission/Hook path.
    /// Validate its actual current caller before binding or initializing receiver identity.
    #[cfg(test)]
    pub fn bind_current_call(
        sender: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
        registry: NativeRemoteRegistry,
        owned_workspace: &std::path::Path,
        input: kcoder_tools::integrations::remotes::RemoteDelegateInput,
    ) -> Result<Self> {
        input
            .validate()
            .map_err(|_| anyhow::anyhow!("REMOTE_INVALID_INPUT"))?;
        validate_caller(sender, engine, attempt, actual, &input.prompt)?;
        let peer = registry.bind(&input.peer_id, &input.peer_revision, owned_workspace)?;
        Self::capture(
            sender,
            engine,
            attempt,
            actual,
            registry,
            peer,
            (input, None),
        )
    }
    pub fn bind_metered_current_call(
        sender: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
        registry: NativeRemoteRegistry,
        owned_workspace: &std::path::Path,
        admitted: (
            kcoder_tools::integrations::remotes::RemoteDelegateInput,
            &Mutex<Vec<super::source_budget::NativeRemoteSourceTaskOwner>>,
        ),
    ) -> Result<Self> {
        let (input, budget_owners) = admitted;
        input
            .validate()
            .map_err(|_| anyhow::anyhow!("REMOTE_INVALID_INPUT"))?;
        let budget = NativeRemoteSourceBudget::capture(sender, engine, attempt, actual)?;
        budget.bind_goal_for_original_owner(budget_owners)?;
        budget.require_delegation_policy()?;
        let peer = registry.bind(&input.peer_id, &input.peer_revision, owned_workspace)?;
        Self::capture(
            sender,
            engine,
            attempt,
            actual,
            registry,
            peer,
            (input, Some(budget)),
        )
    }
    /// Called only by the actual registered native Tool after its normal Engine permission path.
    /// No JSON value supplies its state, original attempt, current call or receiver installation.
    fn capture(
        sender: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
        registry: NativeRemoteRegistry,
        peer: NativeFirstPartyPeer,
        admitted: (
            kcoder_tools::integrations::remotes::RemoteDelegateInput,
            Option<Arc<NativeRemoteSourceBudget>>,
        ),
    ) -> Result<Self> {
        let (input, source_budget) = admitted;
        let prompt = input.prompt;
        let maximum_seconds = input.maximum_seconds;
        let accepted = validate_caller(sender, engine, attempt, actual, &prompt)?;
        if let Some(budget) = &source_budget {
            budget.check_current()?;
            budget.require_delegation_policy()?;
        } else {
            #[cfg(test)]
            {
                require_budget_contract(sender)?;
                require_budget_contract(peer.receiver())?;
            }
            #[cfg(not(test))]
            anyhow::bail!("REMOTE_NATIVE_TASK_BUDGET_REQUIRED");
        }
        peer.check_current(true)?;
        let identity = peer.identity();
        let maximum_seconds = maximum_seconds
            .min(peer.maximum_duration())
            .min(peer.receiver_policy().maximum_duration_seconds);
        ensure!(maximum_seconds > 0, "REMOTE_DEADLINE_INVALID");
        let mut deadline =
            tokio::time::Instant::now() + Duration::from_secs(maximum_seconds.into());
        if let Some(bound) = source_budget
            .as_ref()
            .map(|budget| budget.execution_deadline())
            .transpose()?
            .flatten()
        {
            deadline = deadline.min(bound);
        }

        let launch_environment = BTreeMap::from([
            (
                OsString::from("KCODER_CONFIG_DIR"),
                peer.receiver().profile_path()?.as_os_str().to_owned(),
            ),
            (
                OsString::from("PATH"),
                std::env::var_os("PATH").unwrap_or_default(),
            ),
        ]);
        Ok(Self {
            sender: sender.recapture_for_owned_service()?,
            engine: engine.clone(),
            state: engine.state.inspection_identity(),
            accepted,
            caller: actual.clone(),
            registry,
            peer,
            identity,
            prompt,
            deadline,
            session: Mutex::new(None),
            launch_environment,
            source_budget,
        })
    }
    pub fn original_office_receiver(&self) -> Result<Option<&NativeIntegrationContext>> {
        self.verify_all()?;
        if self.peer.receiver_policy().office.enabled {
            Ok(Some(self.peer.receiver_context()?))
        } else {
            Ok(None)
        }
    }
    pub fn receiver_formats(&self) -> &[kcoder_types::integrations::office::OfficeFileFormat] {
        &self.peer.receiver_policy().office.allowed_formats
    }
    pub fn require_material_transfer(&self, bytes: u64) -> Result<()> {
        self.verify_all()?;
        ensure!(
            self.peer.receiver_policy().accept_materials
                && bytes <= self.peer.receiver_policy().maximum_material_bytes,
            "REMOTE_RECEIVER_MATERIAL_CAPABILITY_REQUIRED"
        );
        Ok(())
    }
    pub fn original_operation_id(&self) -> Result<String> {
        Ok(format!(
            "remote-{}",
            super::launch::digest(&(
                kcoder_types::integrations::core::IntegrationOwner::from(self.sender.scope()),
                &self.accepted.identity,
                self.original_call_id()
            ))?
        ))
    }
    pub fn prepare_native_launch(&mut self) -> Result<super::launch::NativeRemoteLaunchRecord> {
        self.verify_all()?;
        let budget = self
            .source_budget
            .as_ref()
            .context("REMOTE_NATIVE_TASK_BUDGET_REQUIRED")?;
        budget.require_delegation_policy()?;
        let operation = self.original_operation_id()?;
        let locator = super::launch::NativeRemoteLaunchLocator::from_current_native(
            &self.sender,
            &self.engine.state.cwd(),
            &operation,
        )?;
        self.launch_environment.insert(
            super::launch::NATIVE_REMOTE_LAUNCH_ENV.into(),
            locator.into(),
        );
        let remaining = u64::try_from(
            self.deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis(),
        )?;
        ensure!(remaining > 0, "REMOTE_NATIVE_DEADLINE_EXPIRED");
        Ok(super::launch::NativeRemoteLaunchRecord {
            version: 1,
            operation,
            source: budget.frozen_native_facts()?,
            receiver_scope: self.peer.receiver().scope().clone(),
            receiver_settings_sha256: self.peer.receiver_settings_sha256().into(),
            receiver_identity: self.identity.clone(),
            receiver_program_identity: Some(self.peer.original_program_identity()?.into()),
            prompt_sha256: format!("{:x}", sha2::Sha256::digest(self.prompt.as_bytes())),
            deadline_utc_ms: super::launch::now()?
                .checked_add(remaining)
                .context("REMOTE_NATIVE_DEADLINE_EXPIRED")?,
            materials: Vec::new(),
        })
    }
    pub fn runner(&self) -> Result<InstalledOutboundRunner> {
        self.verify_all()?;
        // Receiver credentials resolve from its own native profile. Sender API keys/environment do not cross.
        let runner = InstalledOutboundRunner::from_native_installation(
            self.peer.program().to_owned(),
            self.runner_arguments().into(),
            self.launch_environment.clone(),
            self.peer.workspace().to_owned(),
            self.peer.program().to_owned(),
            "kcoder".into(),
            kcoder_cli_commands::build_identity::version().into(),
        )?;
        #[cfg(target_os = "linux")]
        let runner = runner.with_native_executable_anchor(self.peer.executable_anchor()?)?;
        Ok(runner)
    }
    fn runner_arguments(&self) -> [OsString; 5] {
        let profile = if self.peer.receiver_policy().office.enabled {
            "core"
        } else {
            "none"
        };
        ["acp", "--tool-profile", profile, "--max-retries", "0"].map(OsString::from)
    }
    pub fn original_call_id(&self) -> &str {
        self.caller.tool_call_id.as_deref().unwrap_or_default()
    }
    #[cfg(test)]
    pub fn peer_id(&self) -> &str {
        self.peer.id()
    }
    fn verify_all(&self) -> Result<()> {
        self.sender.verify()?;
        ensure!(
            PrivateDirectory::open_existing(&self.caller.state.cwd())?.directory_identity()?
                == self.sender.workspace_directory_identity()?,
            "REMOTE_NATIVE_WORKSPACE_MISMATCH"
        );
        ensure!(
            self.state.matches(&self.caller.state)
                && self
                    .caller
                    .state
                    .current_history_attempt_identity()
                    .as_ref()
                    == Some(&self.accepted.identity)
                && !self.caller.is_aborted(),
            "REMOTE_NATIVE_CALL_OWNER_CHANGED"
        );
        ensure!(
            read_accepted(&self.engine, &self.accepted.identity)? == self.accepted,
            "REMOTE_NATIVE_CALL_OWNER_CHANGED"
        );
        ensure!(
            tokio::time::Instant::now() < self.deadline,
            "REMOTE_NATIVE_DEADLINE_EXPIRED"
        );
        self.registry.check_current()?;
        self.peer.check_current(false)?;
        if let Some(budget) = &self.source_budget {
            budget.check_current()?;
            budget.require_delegation_policy()?;
        } else {
            #[cfg(test)]
            {
                require_budget_contract(&self.sender)?;
                require_budget_contract(self.peer.receiver())?;
            }
            #[cfg(not(test))]
            anyhow::bail!("REMOTE_NATIVE_TASK_BUDGET_REQUIRED");
        }
        Ok(())
    }
}
pub fn validate_caller(
    sender: &NativeIntegrationContext,
    engine: &QueryEngine,
    attempt: &TurnAttemptIdentity,
    actual: &ToolContext,
    prompt: &str,
) -> Result<TurnAttemptRecord> {
    ensure!(
        actual.state.current_history_attempt_identity().as_ref() == Some(attempt),
        "REMOTE_NATIVE_CALL_OWNER_MISMATCH"
    );
    validate_captured_caller(sender, engine, attempt, actual, prompt)
}
/// Revalidate the already captured actual Tool owner in its owned I/O tasks.
/// Initial Tool admission still requires validate_caller's current task-local
/// scope; this helper cannot capture an owner or deserialize one from data.
pub fn validate_captured_caller(
    sender: &NativeIntegrationContext,
    engine: &QueryEngine,
    attempt: &TurnAttemptIdentity,
    actual: &ToolContext,
    prompt: &str,
) -> Result<TurnAttemptRecord> {
    sender.verify()?;
    let settings_path = engine
        .settings_persistence_path()
        .context("REMOTE_PROFILE_SETTINGS_UNAVAILABLE")?;
    ensure!(
        settings_path.file_name() == Some(std::ffi::OsStr::new("settings.json"))
            && PrivateDirectory::open_existing(
                settings_path
                    .parent()
                    .context("REMOTE_PROFILE_SETTINGS_UNAVAILABLE")?
            )?
            .directory_identity()?
                == sender.profile()?.directory_identity()?,
        "REMOTE_PROFILE_SETTINGS_TARGET_CHANGED"
    );
    ensure!(
        engine.state.inspection_identity().matches(&actual.state)
            && actual.state.session_id() == attempt.thread_id
            && engine.session_id() == attempt.thread_id
            && !actual.is_aborted(),
        "REMOTE_NATIVE_CALL_OWNER_MISMATCH"
    );
    ensure!(
        PrivateDirectory::open_existing(&actual.state.cwd())?.directory_identity()?
            == sender.workspace_directory_identity()?,
        "REMOTE_NATIVE_WORKSPACE_MISMATCH"
    );
    ensure!(
        actual
            .tool_call_id
            .as_ref()
            .is_some_and(|call| !call.is_empty()
                && call.len() <= 256
                && !call.chars().any(char::is_control)),
        "REMOTE_NATIVE_CALL_REQUIRED"
    );
    ensure!(
        !prompt.trim().is_empty() && prompt.len() <= 48 * 1024,
        "REMOTE_PROMPT_LIMIT"
    );
    read_accepted(engine, attempt)
}
impl NativeRemoteAuthority for AcceptedRemoteAuthority {
    fn original_attempt(&self) -> &TurnAttemptIdentity {
        &self.accepted.identity
    }
    fn verify_original_tool(
        &self,
        engine_state: &kcoder_state::AppState,
        tool_state: &kcoder_state::AppState,
        tool_call_id: Option<&str>,
        is_aborted: &dyn Fn() -> bool,
    ) -> Result<()> {
        self.verify_all()?;
        ensure!(
            self.state.matches(engine_state)
                && self.state.matches(tool_state)
                && tool_call_id == Some(self.original_call_id())
                && !is_aborted(),
            "REMOTE_NATIVE_CALL_OWNER_CHANGED"
        );
        Ok(())
    }
    fn check_current(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.validate_scope(self.sender.scope())?;
        self.verify_all()
    }
    fn verify_runner(
        &self,
        context: &NativeIntegrationContext,
        runner: &InstalledOutboundRunner,
    ) -> Result<()> {
        self.check_current(context)?;
        ensure!(
            runner.executable() == self.peer.program()
                && runner.owner_executable() == self.peer.program()
                && runner.workspace() == self.peer.workspace()
                && runner.implementation()
                    == ("kcoder", kcoder_cli_commands::build_identity::version())
                && runner.arguments() == self.runner_arguments()
                && runner.environment() == &self.launch_environment,
            "REMOTE_NATIVE_RUNNER_CHANGED"
        );
        self.peer.check_current(true)?;
        #[cfg(target_os = "linux")]
        self.peer.verify_executable_anchor(
            runner
                .executable_anchor()
                .context("REMOTE_NATIVE_EXECUTION_ANCHOR_REQUIRED")?,
        )?;
        Ok(())
    }
    fn check_frozen_intent(&self, stage: OutboundEffect, actual: &Value) -> Result<()> {
        self.verify_all()?;
        match stage {
            OutboundEffect::Spawn => ensure!(
                actual
                    == &json!({"expectedName":"kcoder","expectedVersion":kcoder_cli_commands::build_identity::version()}),
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
            OutboundEffect::Initialize => ensure!(
                actual["protocolVersion"] == 1,
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
            OutboundEffect::Session => ensure!(
                actual["cwd"].as_str() == self.peer.workspace().to_str()
                    && actual
                        .get("mcpServers")
                        .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)),
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
            OutboundEffect::Prompt => ensure!(
                actual["prompt"] == json!([{"type":"text","text":self.prompt}])
                    && self
                        .session
                        .lock()
                        .map_err(|_| anyhow::anyhow!("REMOTE_SESSION_UNAVAILABLE"))?
                        .as_deref()
                        == actual["sessionId"].as_str(),
                "REMOTE_FROZEN_INTENT_CHANGED"
            ),
        }
        Ok(())
    }
    fn observe_receipt(&self, stage: OutboundEffect, safe: &Value) -> Result<()> {
        if stage == OutboundEffect::Session {
            let id = safe["sessionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .context("REMOTE_SESSION_ID_REQUIRED")?;
            let mut session = self
                .session
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_SESSION_UNAVAILABLE"))?;
            ensure!(
                session.as_deref().is_none_or(|old| old == id),
                "REMOTE_SESSION_CHANGED"
            );
            *session = Some(id.to_owned());
        }
        Ok(())
    }
    fn recipient_revision(&self) -> &str {
        self.peer.revision()
    }
    fn recipient_identity(&self) -> &Value {
        &self.identity
    }
    fn deadline(&self) -> tokio::time::Instant {
        self.deadline
    }
}
fn read_accepted(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
) -> Result<TurnAttemptRecord> {
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .context("REMOTE_ORIGINAL_TASK_MISSING")?;
    let record = store
        .load(identity)?
        .context("REMOTE_ORIGINAL_TASK_MISSING")?;
    ensure!(
        record.identity == *identity
            && record.status == TurnAttemptStatus::Accepted
            && record.completion.is_none(),
        "REMOTE_ORIGINAL_TASK_NOT_ACTIVE"
    );
    Ok(record)
}
#[cfg(test)]
fn require_budget_contract(context: &NativeIntegrationContext) -> Result<()> {
    ensure!(
        context.scope().organization_id.is_none(),
        "REMOTE_ORGANIZATION_POLICY_UNAVAILABLE"
    );
    let mut account = context.scope().clone();
    account.workspace_id = IntegrationNullable::Null;
    // A priced/quota-managed native run needs a real cross-process metering contract.
    // Unknown remote spend must never bypass or refund an existing native budget.
    ensure!(
        NativeDomainGuard::observe(context.profile()?, &account, NativeDomain::Budgets)?.is_none(),
        "REMOTE_NATIVE_BUDGET_CONTRACT_REQUIRED"
    );
    Ok(())
}
