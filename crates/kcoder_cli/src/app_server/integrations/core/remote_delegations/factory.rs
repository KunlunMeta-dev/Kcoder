//! Normal accepted-turn tools over the original Native operations, budgets, ACP owner and Office artifacts.
use super::{
    artifacts::NativeRemoteReceivedOutput,
    authority::{AcceptedRemoteAuthority, validate_caller},
    registry::{self, NativeRemoteRegistry},
    *,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_acp::outbound::{OutboundAcp, OutboundContentBlock, OutboundTextContent};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_tools::{
    ToolContext, ToolError,
    integrations::remotes::{
        RemoteCatalogTool, RemoteDelegateBackend, RemoteDelegateInput, RemoteDelegateTool,
        RemoteOperationInput, RemoteOperationTool,
    },
};
use kcoder_types::{
    TurnAttemptIdentity,
    integrations::{core::*, office::OfficeFileFormat},
};
use serde_json::json;
use std::path::Path;
use tokio_util::sync::CancellationToken;
#[path = "factory/ssh.rs"]
mod ssh;

pub fn install_outgoing_for_accepted_turn(
    native: &NativeIntegrationContext,
    attempt: &TurnAttemptIdentity,
    engine: QueryEngine,
    host_client: Option<Arc<super::transport::host_client::NativeRemoteHostClient>>,
) -> Result<QueryEngine> {
    install_with_native_host_selection(
        native,
        attempt,
        engine,
        NativeExecutableSelection::Current,
        host_client,
    )
}
#[derive(Clone)]
enum NativeExecutableSelection {
    Current,
    #[cfg(test)]
    Installed(std::path::PathBuf),
}
#[cfg(test)]
fn install_with_native_selection(
    native: &NativeIntegrationContext,
    attempt: &TurnAttemptIdentity,
    engine: QueryEngine,
    installation: NativeExecutableSelection,
) -> Result<QueryEngine> {
    install_with_native_host_selection(native, attempt, engine, installation, None)
}
fn install_with_native_host_selection(
    native: &NativeIntegrationContext,
    attempt: &TurnAttemptIdentity,
    engine: QueryEngine,
    installation: NativeExecutableSelection,
    host_client: Option<Arc<super::transport::host_client::NativeRemoteHostClient>>,
) -> Result<QueryEngine> {
    if engine.state.session_mode() != kcoder_state::SessionMode::Default {
        return Ok(engine);
    }
    let Some(registry) = registry::observe(native, &engine)? else {
        return Ok(engine);
    };
    ensure!(
        engine.state.current_history_attempt_identity().as_ref() == Some(attempt)
            && attempt.thread_id == engine.session_id(),
        "REMOTE_NATIVE_CALL_OWNER_MISMATCH"
    );
    let backend = Arc::new(CurrentTurnRemoteBackend {
        native: native.recapture_for_owned_service()?,
        engine: engine.clone(),
        attempt: attempt.clone(),
        revision: registry.revision().into(),
        _installation: installation,
        host_client,
        budget_owners: Mutex::default(),
    });
    let mut tools = engine.tools.clone();
    tools
        .try_register(Arc::new(RemoteCatalogTool::new(backend.clone())))
        .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_TOOL_COLLISION"))?;
    tools
        .try_register(Arc::new(RemoteDelegateTool::new(backend.clone())?))
        .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_TOOL_COLLISION"))?;
    tools
        .try_register(Arc::new(RemoteOperationTool::new(backend)))
        .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_TOOL_COLLISION"))?;
    Ok(engine.with_turn_tools(tools))
}
struct CurrentTurnRemoteBackend {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    attempt: TurnAttemptIdentity,
    revision: String,
    _installation: NativeExecutableSelection,
    host_client: Option<Arc<super::transport::host_client::NativeRemoteHostClient>>,
    budget_owners: Mutex<Vec<super::source_budget::NativeRemoteSourceTaskOwner>>,
}
impl Drop for CurrentTurnRemoteBackend {
    fn drop(&mut self) {
        let owners = self
            .budget_owners
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for owner in owners.drain(..) {
            if owner.settle().is_err() {
                tracing::warn!(
                    code = "REMOTE_SOURCE_TERMINAL_ACCOUNTING_UNAVAILABLE",
                    "Original remote source accounting remains pending"
                );
            }
        }
    }
}
#[async_trait]
impl RemoteDelegateBackend for CurrentTurnRemoteBackend {
    fn source_revision(&self) -> &str {
        &self.revision
    }
    fn catalog(&self, actual: &ToolContext) -> Result<Value, ToolError> {
        (||->Result<Value>{validate_caller(&self.native,&self.engine,&self.attempt,actual,"native remote catalog")?;
            let registry=registry::observe(&self.native,&self.engine)?.context("REMOTE_NATIVE_CATALOG_UNAVAILABLE")?;
            Ok(json!({"revision":registry.revision(),"peers":registry.peers()?,"runtimeAdmission":"requires_actual_native_accepted_task_and_explicit_budget_policy","businessReady":false}))})().map_err(public_tool_error)
    }
    fn operation(
        &self,
        input: RemoteOperationInput,
        actual: &ToolContext,
    ) -> Result<Value, ToolError> {
        (|| -> Result<Value> {
            validate_caller(
                &self.native,
                &self.engine,
                &self.attempt,
                actual,
                "native original remote operation",
            )?;
            let registry = self.registry()?;
            ensure!(
                registry.revision() == self.revision,
                "REMOTE_RUNNER_CONFIGURATION_CHANGED"
            );
            management::manage_original_with_guard(&self.native, &input, &|| {
                validate_caller(
                    &self.native,
                    &self.engine,
                    &self.attempt,
                    actual,
                    "native original remote operation",
                )?;
                self.registry()?.check_current()
            })
        })()
        .map_err(public_tool_error)
    }
    async fn delegate(
        &self,
        input: RemoteDelegateInput,
        actual: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.delegate_owned(input, actual)
            .await
            .map_err(public_tool_error)
    }
}
impl CurrentTurnRemoteBackend {
    fn registry(&self) -> Result<NativeRemoteRegistry> {
        let registry = registry::observe(&self.native, &self.engine)?
            .context("REMOTE_NATIVE_CATALOG_UNAVAILABLE")?;
        #[cfg(test)]
        let registry = match &self._installation {
            NativeExecutableSelection::Current => registry,
            NativeExecutableSelection::Installed(program) => {
                registry.with_installed_test_program(program.clone())
            }
        };
        Ok(registry)
    }
    async fn delegate_owned(
        &self,
        input: RemoteDelegateInput,
        actual: &ToolContext,
    ) -> Result<Value> {
        validate_caller(
            &self.native,
            &self.engine,
            &self.attempt,
            actual,
            &input.prompt,
        )?;
        let settings = self
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .clone();
        ensure!(
            settings.enabled && settings.allowed_formats.contains(&OfficeFileFormat::Json),
            "REMOTE_NATIVE_ARTIFACT_PROVIDER_REQUIRED"
        );
        let registry = self.registry()?;
        ensure!(
            registry.revision() == self.revision,
            "REMOTE_RUNNER_CONFIGURATION_CHANGED"
        );
        if let Some(peer) = registry.configured_ssh_peer(&input.peer_id, &input.peer_revision)? {
            return self.delegate_owned_ssh(input, actual, registry, peer).await;
        }
        let mut workspace = OwnedRemoteWorkspace::create(&self.native, &self.attempt, actual)?;
        let prompt = input.prompt.clone();
        let mut materials = Vec::new();
        let mut total_material_bytes = 0u64;
        for reference in &input.materials {
            let material = super::materials::capture(
                &self.native,
                &self.engine,
                &self.attempt,
                actual,
                reference,
            )?;
            total_material_bytes = total_material_bytes
                .checked_add(material.descriptor().bytes)
                .context("REMOTE_MATERIAL_TOTAL_LIMIT")?;
            ensure!(
                total_material_bytes <= super::materials::MAX_MATERIAL_BYTES,
                "REMOTE_MATERIAL_TOTAL_LIMIT"
            );
            materials.push(material);
        }
        let mut authority = AcceptedRemoteAuthority::bind_metered_current_call(
            &self.native,
            &self.engine,
            &self.attempt,
            actual,
            registry,
            workspace.path(),
            (input, &self.budget_owners),
        )?;
        if !materials.is_empty() {
            authority.require_material_transfer(total_material_bytes)?;
        }
        let mut launch = authority.prepare_native_launch()?;
        launch.materials = materials
            .iter()
            .map(|material| material.descriptor().clone())
            .collect();
        let operation = launch.operation.clone();
        let request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,request_id:format!("request-{operation}"),scope:self.native.scope().clone(),operation_id:Some(operation.clone()),expected_revision:None,
            timeout_ms:1000,cancellation_ref:None,payload:json!({"sourceTask":self.attempt,"sourceToolCallId":actual.tool_call_id,"prompt":prompt,"recipientRevision":launch.receiver_settings_sha256,"materials":launch.materials}).as_object().unwrap().clone()};
        let authority = Arc::new(authority);
        let journal = Arc::new(NativeRemoteJournal::begin(
            &self.native,
            &request,
            authority.clone(),
        )?);
        journal.store().freeze_native_launch(
            &operation,
            self.native.scope(),
            &serde_json::to_vec(&launch)?,
        )?;
        let runner = authority.runner()?;
        let cancel = actual
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        workspace.mark_launch_attempt();
        let mut peer = match OutboundAcp::spawn(&runner, journal.clone()) {
            Ok(peer) => peer,
            Err(_) => return Ok(unknown(&operation, "REMOTE_NATIVE_SPAWN_OUTCOME_UNKNOWN")),
        };
        let received = async {
            peer.initialize(&cancel).await?;
            let wait = journal
                .deadline()
                .saturating_duration_since(tokio::time::Instant::now());
            ensure!(!wait.is_zero(), "REMOTE_NATIVE_DEADLINE_EXPIRED");
            peer.prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(prompt))],
                &cancel,
                wait,
            )
            .await
        }
        .await;
        let cleanup = peer.shutdown().await;
        workspace.confirm_cleanup(cleanup.confirmed());
        journal.record_owned_cleanup(&cleanup)?;
        let received = match received {
            Ok(received) => received,
            Err(_error) => {
                #[cfg(test)]
                if std::env::var_os("KCODER_REMOTE_TEST_TRACE").is_some() {
                    eprintln!("owned original ACP dispatch diagnostic: {_error:#}");
                }
                return Ok(unknown(
                    &operation,
                    "REMOTE_NATIVE_DISPATCH_OUTCOME_REQUIRES_ORIGINAL_READ",
                ));
            }
        };
        ensure!(cleanup.confirmed(), "REMOTE_NATIVE_CLEANUP_UNCONFIRMED");
        let observation = journal
            .store()
            .read(&operation)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            observation.receiver.is_some(),
            "REMOTE_RECEIVER_NATIVE_ACCEPTANCE_UNKNOWN"
        );
        let mut output = NativeRemoteReceivedOutput::capture(&journal, received)?;
        if let Err(_error) = output.bind_original_native_result(authority.as_ref(), &journal) {
            #[cfg(test)]
            if std::env::var_os("KCODER_REMOTE_TEST_TRACE").is_some() {
                eprintln!("owned original Native result diagnostic: {_error:#}");
            }
            // The remote turn may already be completed. Preserve its original
            // identity for reconciliation instead of losing it in a tool error.
            return Ok(unknown(
                &operation,
                "REMOTE_NATIVE_OUTPUT_REQUIRES_ORIGINAL_READ",
            ));
        }
        let artifact = output.publish(&journal, &self.engine, actual)?;
        let reader = output.read(&journal, &runner, &self.engine, actual).await;
        let reader = match reader {
            Ok(value) => {
                json!({"state":"received","complete":value["complete"],"businessVerified":false})
            }
            Err(_) => json!({"state":"unavailable","businessVerified":false}),
        };
        Ok(
            json!({"operationId":operation,"state":"native_receiver_observed","receiver":observation.receiver,
            "artifact":{"id":artifact.id,"revision":artifact.revision,"sha256":artifact.sha256,"bytes":artifact.bytes},
            "reader":reader,"verification":"partial","businessCompleted":false,"ownerCleanupConfirmed":cleanup.confirmed()}),
        )
    }
}
#[cfg(test)]
mod tests;
fn unknown(operation: &str, code: &str) -> Value {
    json!({"operationId":operation,"state":"outcome_unknown","code":code,"recovery":"reconcile_original","businessCompleted":false})
}
fn public_tool_error(error: anyhow::Error) -> ToolError {
    #[cfg(test)]
    if std::env::var_os("KCODER_REMOTE_TEST_TRACE").is_some() {
        eprintln!("owned remote fixture diagnostic: {error:#}");
    }
    let code = error
        .chain()
        .find_map(|cause| {
            let text = cause.to_string();
            (text.len() <= 160
                && (text.starts_with("REMOTE_")
                    || text.starts_with("BUDGET_")
                    || text.starts_with("RUNTIME_")
                    || text.starts_with("GOAL_NATIVE_"))
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
            .then_some(text)
        })
        .unwrap_or_else(|| "REMOTE_NATIVE_UNAVAILABLE".into());
    ToolError::Execution(code)
}
struct OwnedRemoteWorkspace {
    directory: Option<tempfile::TempDir>,
    identity: String,
    launch_attempted: bool,
    cleanup_confirmed: bool,
}
impl OwnedRemoteWorkspace {
    fn create(
        native: &NativeIntegrationContext,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
    ) -> Result<Self> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("kcoder-native-remote-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder.tempdir()?;
        let private = PrivateDirectory::open_existing(directory.path())?;
        private.verify_private_directory()?;
        let identity = private.directory_identity()?;
        private.atomic_replace(OsStr::new("owner.json"),&serde_json::to_vec(&json!({"kind":"native-remote-workspace-v1","owner":IntegrationOwner::from(native.scope()),"attempt":attempt,
            "toolCallId":actual.tool_call_id,"parentPid":std::process::id(),"nonce":uuid::Uuid::new_v4(),"directoryIdentity":identity}))?)?;
        Ok(Self {
            directory: Some(directory),
            identity,
            launch_attempted: false,
            cleanup_confirmed: false,
        })
    }
    fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("owned workspace retained")
            .path()
    }
    fn mark_launch_attempt(&mut self) {
        self.launch_attempted = true;
    }
    fn confirm_cleanup(&mut self, confirmed: bool) {
        self.cleanup_confirmed = confirmed;
    }
}
impl Drop for OwnedRemoteWorkspace {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            let same = PrivateDirectory::open_existing(directory.path())
                .and_then(|private| private.directory_identity())
                .is_ok_and(|identity| identity == self.identity);
            if !same || (self.launch_attempted && !self.cleanup_confirmed) {
                let _ = directory.keep();
            }
        }
    }
}
