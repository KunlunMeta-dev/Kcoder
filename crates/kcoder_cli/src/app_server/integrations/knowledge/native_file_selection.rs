//! Actual public user-control ownership plus current target Read/sandbox policy.
use super::rpc::configuration::EngineSnapshot;
use super::{
    ApprovedFileEventSource, KnowledgePolicyEvaluator, KnowledgeResource, NativeFileEventBinding,
};
use crate::app_server::{ConnectionState, integrations::core::NativeIntegrationContext};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::integrations::{core::*, knowledge::*};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::PathBuf,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeFileEventSelection {
    pub(crate) binding: Arc<NativeFileEventBinding>,
    pub(crate) receipt: AutomationFileSelectionReceipt,
    native: NativeIntegrationContext,
}
/// Only the finite authenticated public user route owns ConnectionState. An
/// SDK/model callback or a selection JSON cannot construct this proof.
pub(crate) struct NativeFileEventSelectionPermit {
    owner: Weak<()>,
    ended: CancellationToken,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    params: AutomationFileSelectionParams,
    expires: Instant,
}
impl NativeFileEventSelectionPermit {
    pub(in crate::app_server) fn from_public_control(
        connection: &ConnectionState,
        engine: &QueryEngine,
        request: &IntegrationRequest,
    ) -> Result<Self> {
        ensure!(
            connection.initialized
                && connection.integration_automation_v1
                && !connection.native_source_dispatch
                && connection.native_source_accepted.is_none()
                && !connection.input_ended.is_cancelled(),
            "AUTOMATION_FILE_SELECTION_CALLER_UNAVAILABLE"
        );
        ensure!(
            engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_CONFIGURATION_UNAVAILABLE"))?
                .integrations
                .knowledge
                .business_automation_enabled,
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        request.validate(true)?;
        let params: AutomationFileSelectionParams =
            serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
        params.validate().map_err(anyhow::Error::msg)?;
        let native = connection
            .integration_context
            .as_ref()
            .context("AUTOMATION_FILE_SELECTION_CALLER_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        ensure!(
            native.scope().organization_id.is_none(),
            "AUTOMATION_FILE_SELECTION_ORGANIZATION_UNAVAILABLE"
        );
        EngineSnapshot::capture(engine)?.verify_binding(engine, &native)?;
        Ok(Self {
            owner: Arc::downgrade(&connection.source_management_owner),
            ended: connection.input_ended.clone(),
            native,
            engine: engine.clone(),
            state: engine.state.inspection_lifecycle_identity(),
            params,
            expires: Instant::now() + Duration::from_millis(request.timeout_ms),
        })
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && Instant::now() < self.expires
                && self.state.matches(&self.engine.state),
            "AUTOMATION_FILE_SELECTION_CALLER_CHANGED"
        );
        self.native.verify()?;
        EngineSnapshot::capture(&self.engine)?.verify_binding(&self.engine, &self.native)
    }
    /// Run on the original host's bounded blocking lane. Path labels resolve
    /// from its real workspace FD; no links, escapes, directory grants or
    /// permission-mode changes are introduced by selecting/detecting files.
    pub(crate) fn prepare(self) -> Result<NativeFileEventSelection> {
        self.verify()?;
        let root = self.engine.state.cwd();
        let mut directory = PrivateDirectory::open_existing(&root)?;
        ensure!(
            directory.directory_identity()? == self.native.workspace_directory_identity()?,
            "AUTOMATION_FILE_SELECTION_TARGET_CHANGED"
        );
        let mut path = root;
        if self.params.relative_directory != "." {
            for component in self.params.relative_directory.split('/') {
                directory = directory.open_child(OsStr::new(component), false)?;
                path.push(component);
            }
        }
        let directory_identity = directory.directory_identity()?;
        let owner = KnowledgeOwner::from(self.native.scope());
        let mut selected = Vec::new();
        let mut items = Vec::new();
        let mut paths = BTreeMap::new();
        let mut identities = std::collections::BTreeSet::new();
        for name in &self.params.file_names {
            crate::app_server::workspace_io::validate_name(name)?;
            let actual = path.join(name);
            // This is the real existing Read permission and sandbox. Ask stays
            // Ask: the caller must use the existing permission interaction.
            self.engine.verify_native_file_observation_read(&actual)?;
            let file = directory.open_single_link_regular_file(OsStr::new(name))?;
            ensure!(
                file.metadata()?.len() <= 1024 * 1024,
                "AUTOMATION_EVENT_FILE_TOO_LARGE"
            );
            let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
            ensure!(
                identities.insert(hash(&identity)?),
                "AUTOMATION_FILE_SELECTION_DUPLICATE_OBJECT"
            );
            let revision = hash(&(&owner, &directory_identity, name, &identity))?;
            let reference = format!("file-resource-{revision}");
            selected.push((reference.clone(), name.into()));
            paths.insert(
                reference.clone(),
                SelectedPath {
                    path: actual,
                    identity,
                },
            );
            items.push(AutomationFileSelectionItem {
                resource_ref: reference,
                name: name.clone(),
                identity_revision: revision,
            });
        }
        self.verify()?;
        items.sort_by(|left, right| left.name.cmp(&right.name));
        selected.sort_by(|left, right| left.0.cmp(&right.0));
        let selection_revision = hash(&(&owner, &directory_identity, &items))?;
        let source_ref = format!("file-events-{selection_revision}");
        let policy = Arc::new(CurrentSelectedFileRead {
            owner: owner.clone(),
            native: self.native.recapture_for_owned_service()?,
            engine: self.engine.clone(),
            state: self.state,
            control_owner: self.owner,
            ended: self.ended,
            directory: directory.duplicate_handle()?,
            directory_identity,
            paths,
            relative_directory: self.params.relative_directory.clone(),
            revision: selection_revision.clone(),
        });
        let source = ApprovedFileEventSource::from_authorized_files(
            self.native.scope(),
            &source_ref,
            directory,
            selected,
        )?;
        let binding = Arc::new(NativeFileEventBinding::from_authorized_source(
            &self.native,
            &self.engine,
            source,
            policy,
        )?);
        Ok(NativeFileEventSelection {
            binding,
            native: self.native,
            receipt: AutomationFileSelectionReceipt {
                owner,
                source_ref,
                selection_revision,
                items,
            },
        })
    }
}

/// The public dispatcher captures this on its actual selected target, then
/// runs it as one existing connection-owned request job. It never opens a task.
pub(crate) struct NativeFileEventSelectionControl {
    request: IntegrationRequest,
    permit: NativeFileEventSelectionPermit,
    cache: Arc<tokio::sync::Mutex<super::NativeKnowledgeRpc>>,
}
impl NativeFileEventSelectionControl {
    pub(in crate::app_server) fn from_public_control(
        connection: &ConnectionState,
        engine: &QueryEngine,
        request: IntegrationRequest,
    ) -> Result<Self> {
        let permit =
            NativeFileEventSelectionPermit::from_public_control(connection, engine, &request)?;
        Ok(Self {
            request,
            permit,
            cache: connection.integration_knowledge.clone(),
        })
    }
    pub(crate) async fn run(self) -> IntegrationReply {
        let request = self.request;
        let result=async {
            let selected=tokio::task::spawn_blocking(move||self.permit.prepare()).await
                .map_err(|_|anyhow::anyhow!("AUTOMATION_FILE_SELECTION_WORKER_UNAVAILABLE"))??;
            selected.binding.verify(&selected.native)?;
            let mut intent=request.clone();
            // The original operation freezes the actual resolved identities,
            // not merely reusable path labels. Receipt metadata is never a grant.
            intent.payload=serde_json::json!({"selector":request.payload,"resolvedSelection":selected.receipt}).as_object().unwrap().clone();
            let native=selected.native.recapture_for_owned_service()?;
            let operation=request.operation_id.clone().context("AUTOMATION_OPERATION_REQUIRED")?;
            let (ledger,receipt,new)=tokio::task::spawn_blocking(move||->Result<_>{
                let ledger=match crate::app_server::integrations::core::NativeOperations::load(&native)? {
                    Some(ledger)=>ledger,
                    None=>crate::app_server::integrations::core::NativeOperations::initialize(&native,&operation)?,
                };
                let (receipt,new)=ledger.begin(&native,&intent,"P-AUTOMATION","selectFileEventSource")?;
                Ok((ledger,receipt,new))
            }).await.map_err(|_|anyhow::anyhow!("AUTOMATION_FILE_SELECTION_WORKER_UNAVAILABLE"))??;
            ensure!(matches!(receipt.phase,IntegrationOperationPhase::Executing|IntegrationOperationPhase::Completed|IntegrationOperationPhase::Unknown),
                "AUTOMATION_FILE_SELECTION_ORIGINAL_REJECTED");
            if receipt.phase==IntegrationOperationPhase::Completed {
                ensure!(receipt.entity_ref.as_ref().is_some_and(|entity|entity.kind==IntegrationEntityKind::Input
                    && entity.id==selected.receipt.source_ref && entity.revision.as_deref()==Some(selected.receipt.selection_revision.as_str())),
                    "AUTOMATION_FILE_SELECTION_RECEIPT_CHANGED");
            }
            {
                let mut cache=self.cache.lock().await;
                let retained=if !new {cache.file_event_source(&selected.receipt.source_ref)
                    .filter(|binding|binding.verify(&selected.native).is_ok())}else{None};
                if retained.is_none(){cache.install_file_event_source(&selected.native,selected.binding.clone())?;}
            }
            selected.binding.verify(&selected.native)?;
            if !receipt.phase.is_terminal() {
                let native=selected.native.recapture_for_owned_service()?;
                let entity=IntegrationEntityRef {kind:IntegrationEntityKind::Input,id:selected.receipt.source_ref.clone(),revision:Some(selected.receipt.selection_revision.clone())};
                tokio::task::spawn_blocking(move||ledger.transition_with_entity(&native,&receipt,IntegrationOperationPhase::Completed,Some(entity),None)).await
                    .map_err(|_|anyhow::anyhow!("AUTOMATION_FILE_SELECTION_WORKER_UNAVAILABLE"))??;
            }
            Ok::<_,anyhow::Error>(serde_json::to_value(&selected.receipt)?.as_object().unwrap().clone())
        }.await;
        let (status, value, error) = match result {
            Ok(value) => (
                IntegrationStatus::Completed,
                IntegrationNullable::Value(value),
                IntegrationNullable::Null,
            ),
            Err(cause) => {
                let code = match cause.to_string().as_str() {
                    "NATIVE_FILE_READ_AUTHORIZATION_REQUIRED" => {
                        "AUTOMATION_FILE_READ_AUTHORIZATION_REQUIRED"
                    }
                    "NATIVE_FILE_READ_DENIED" | "NATIVE_FILE_READ_SANDBOX_DENIED" => {
                        "AUTOMATION_FILE_READ_DENIED"
                    }
                    "integration operation intent conflict" => "AUTOMATION_FILE_SELECTION_CONFLICT",
                    "AUTOMATION_FILE_SELECTION_CALLER_CHANGED"
                    | "AUTOMATION_FILE_READ_CALLER_UNAVAILABLE" => {
                        "AUTOMATION_FILE_SELECTION_CALLER_CHANGED"
                    }
                    _ => "AUTOMATION_FILE_SELECTION_UNCONFIRMED",
                };
                let status = if code == "AUTOMATION_FILE_SELECTION_UNCONFIRMED" {
                    IntegrationStatus::Unknown
                } else {
                    IntegrationStatus::Rejected
                };
                (
                    status,
                    IntegrationNullable::Null,
                    IntegrationNullable::Value(IntegrationError {
                        code: code.into(),
                        message_key: "knowledgeIntegration.operationFailed".into(),
                        recovery: if code == "AUTOMATION_FILE_READ_AUTHORIZATION_REQUIRED"
                            || code == "AUTOMATION_FILE_READ_DENIED"
                        {
                            IntegrationRecovery::RequestAuthorization
                        } else {
                            IntegrationRecovery::ReconcileOriginal
                        },
                    }),
                )
            }
        };
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id,
            operation_id: request
                .operation_id
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            status,
            result: value,
            error,
        }
    }
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
struct SelectedPath {
    path: PathBuf,
    identity: PortableLeaseIdentity,
}
struct CurrentSelectedFileRead {
    owner: KnowledgeOwner,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    control_owner: Weak<()>,
    ended: CancellationToken,
    directory: PrivateDirectory,
    directory_identity: String,
    paths: BTreeMap<String, SelectedPath>,
    relative_directory: String,
    revision: String,
}
impl KnowledgePolicyEvaluator for CurrentSelectedFileRead {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        ensure!(
            self.control_owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && self.state.matches(&self.engine.state),
            "AUTOMATION_FILE_READ_CALLER_UNAVAILABLE"
        );
        self.native.verify()?;
        ensure!(
            KnowledgeOwner::from(scope) == self.owner
                && resource.owner == self.owner
                && action == "automation.event_source.read"
                && resource.kind == "automation-file-source",
            "AUTOMATION_FILE_READ_DENIED"
        );
        EngineSnapshot::capture(&self.engine)?.verify_binding(&self.engine, &self.native)?;
        let selected = self
            .paths
            .get(&resource.id)
            .context("AUTOMATION_FILE_NOT_SELECTED")?;
        self.engine
            .verify_native_file_observation_read(&selected.path)?;
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "AUTOMATION_FILE_SELECTION_TARGET_CHANGED"
        );
        let mut current = PrivateDirectory::open_existing(&self.engine.state.cwd())?;
        if self.relative_directory != "." {
            for component in self.relative_directory.split('/') {
                current = current.open_child(OsStr::new(component), false)?;
            }
        }
        ensure!(
            current.directory_identity()? == self.directory_identity,
            "AUTOMATION_FILE_SELECTION_TARGET_CHANGED"
        );
        let name = selected
            .path
            .file_name()
            .context("AUTOMATION_FILE_SELECTION_NAME_INVALID")?;
        let file = self.directory.open_single_link_regular_file(name)?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&file)? == selected.identity,
            "AUTOMATION_FILE_SELECTION_IDENTITY_CHANGED"
        );
        ensure!(
            !self.ended.is_cancelled() && self.control_owner.upgrade().is_some(),
            "AUTOMATION_FILE_READ_CALLER_UNAVAILABLE"
        );
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Allow,
            policy_revision: self.revision.clone(),
            reason_code: "native_selected_current_read".into(),
        })
    }
}

#[cfg(test)]
mod tests;
