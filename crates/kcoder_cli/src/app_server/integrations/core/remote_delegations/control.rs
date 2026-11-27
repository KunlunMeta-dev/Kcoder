//! Authenticated Native control owns only the selected original operation. It never delegates a task.
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_tools::integrations::remotes::{RemoteOperationAction, RemoteOperationInput};
use kcoder_types::integrations::core::*;
use std::sync::Weak;
use tokio_util::sync::CancellationToken;

pub struct NativeRemoteOperationControl {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    owner: Weak<()>,
    cancel: CancellationToken,
}
impl NativeRemoteOperationControl {
    pub fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        owner: Weak<()>,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let result = Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            state: engine.state.inspection_lifecycle_identity(),
            owner,
            cancel,
        };
        result.check()?;
        Ok(result)
    }
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }
    pub fn check(&self) -> Result<()> {
        ensure!(
            !self.cancel.is_cancelled()
                && self.owner.upgrade().is_some()
                && self.state.matches(&self.engine.state),
            "REMOTE_CONTROL_OWNER_CHANGED"
        );
        self.native.verify()?;
        ensure!(
            self.native.scope().organization_id.is_none(),
            "REMOTE_CONTROL_ORGANIZATION_UNAVAILABLE"
        );
        let path = self
            .engine
            .settings_persistence_path()
            .context("REMOTE_CONTROL_PROFILE_REQUIRED")?;
        ensure!(
            PrivateDirectory::open_existing(
                path.parent().context("REMOTE_CONTROL_PROFILE_REQUIRED")?
            )?
            .directory_identity()?
                == self.native.profile()?.directory_identity()?
                && PrivateDirectory::open_existing(&self.engine.state.cwd())?
                    .directory_identity()?
                    == self.native.workspace_directory_identity()?,
            "REMOTE_CONTROL_TARGET_CHANGED"
        );
        Ok(())
    }
    pub fn list(&self, request: &RemoteOperationListParams) -> Result<RemoteOperationListReply> {
        self.check()?;
        request.validate()?;
        self.native.validate_scope(&request.scope)?;
        let (items, total) = if let Some(guard) = NativeDomainGuard::observe(
            self.native.profile()?,
            self.native.scope(),
            NativeDomain::RemoteDelegations,
        )? {
            let store = NativeRemoteDelegationStore::open_in(
                &guard.directory(self.native.profile()?)?,
                OsStr::new("data"),
                self.native.scope(),
            )?
            .context("REMOTE_JOURNAL_MISSING")?;
            let (rows, total) = store.recent()?;
            (
                rows.into_iter()
                    .map(|row| RemoteOperationSummary {
                        operation_id: row.operation_id,
                        journal_revision: row.revision,
                        receiver_observed: row.receiver.is_some()
                            || row.endpoint_receiver.is_some(),
                    })
                    .collect(),
                total,
            )
        } else {
            (Vec::new(), 0)
        };
        self.check()?;
        Ok(RemoteOperationListReply {
            request_id: request.request_id.clone(),
            scope: self.native.scope().clone(),
            items,
            total: u32::try_from(total)?,
        })
    }
    pub fn native(&self) -> &NativeIntegrationContext {
        &self.native
    }
    pub fn engine(&self) -> &QueryEngine {
        &self.engine
    }
    pub fn reconcile_endpoint<'a>(
        &'a self,
        request: &'a RemoteOperationControlParams,
        host: Option<&'a Arc<transport::host_client::NativeRemoteHostClient>>,
        rpc_id: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(self.reconcile_endpoint_producer(request, host, rpc_id))
    }
    async fn reconcile_endpoint_producer(
        &self,
        request: &RemoteOperationControlParams,
        host: Option<&Arc<transport::host_client::NativeRemoteHostClient>>,
        rpc_id: &Value,
    ) -> Result<()> {
        super::original_reconcile::reconcile(self, request, host, rpc_id).await
    }
    pub fn run(
        &self,
        request: &RemoteOperationControlParams,
        cancellation: bool,
    ) -> Result<RemoteOperationControlReply> {
        request.validate(cancellation)?;
        self.check()?;
        self.native.validate_scope(&request.scope)?;
        let input = RemoteOperationInput {
            action: if cancellation {
                RemoteOperationAction::Cancel
            } else {
                RemoteOperationAction::Read
            },
            operation_id: request.operation_id.clone(),
            expected_revision: request.expected_revision,
        };
        let value = management::manage_original_with_guard(&self.native, &input, &|| self.check())?;
        self.check()?;
        let snapshot = if value["state"] == "not_found" {
            None
        } else {
            Some(project(&value)?)
        };
        let outcome = if cancellation
            && snapshot.is_some()
            && value["cancellationState"] == "already_terminal"
        {
            RemoteOperationControlOutcome::AlreadyTerminal
        } else if cancellation && snapshot.is_some() {
            RemoteOperationControlOutcome::CancellationRequested
        } else {
            RemoteOperationControlOutcome::Observed
        };
        Ok(RemoteOperationControlReply {
            request_id: request.request_id.clone(),
            scope: self.native.scope().clone(),
            operation_id: request.operation_id.clone(),
            outcome,
            snapshot,
        })
    }
}
fn project(value: &Value) -> Result<RemoteOperationSnapshot> {
    let source = &value["receiver"];
    let status = match source["status"].as_str() {
        Some("accepted") => RemoteOperationReceiverStatus::Accepted,
        Some("completed") => RemoteOperationReceiverStatus::Completed,
        Some("failed") => RemoteOperationReceiverStatus::Failed,
        Some("interrupted") => RemoteOperationReceiverStatus::Interrupted,
        _ if source["state"] == "outcome_unknown" => RemoteOperationReceiverStatus::Unknown,
        _ => RemoteOperationReceiverStatus::NotObserved,
    };
    let mut protocol = Vec::new();
    for (stage, status) in value["stages"]
        .as_object()
        .context("REMOTE_CONTROL_INVALID_OBSERVATION")?
    {
        protocol.push(RemoteOperationProtocolStage {
            stage: stage.clone(),
            status: serde_json::from_value(status.clone())?,
        });
    }
    let artifact = &value["receipts"]["output_transfer"];
    let artifact = if artifact["artifact"].is_object() {
        Some(RemoteOperationArtifact {
            id: artifact["artifact"]["id"]
                .as_str()
                .context("REMOTE_CONTROL_INVALID_OBSERVATION")?
                .into(),
            revision: artifact["artifact"]["revision"]
                .as_u64()
                .context("REMOTE_CONTROL_INVALID_OBSERVATION")?,
            sha256: artifact["sha256"]
                .as_str()
                .context("REMOTE_CONTROL_INVALID_OBSERVATION")?
                .into(),
            bytes: artifact["bytes"]
                .as_u64()
                .context("REMOTE_CONTROL_INVALID_OBSERVATION")?,
        })
    } else {
        None
    };
    let reason_code = source["code"]
        .as_str()
        .filter(|code| {
            code.len() <= 160
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .map(str::to_owned);
    let identity = if source["identity"].is_object() {
        Some(serde_json::from_value(source["identity"].clone())?)
    } else {
        None
    };
    Ok(RemoteOperationSnapshot {
        operation_id: value["operationId"]
            .as_str()
            .context("REMOTE_CONTROL_INVALID_OBSERVATION")?
            .into(),
        operation_revision: value["operationRevision"]
            .as_u64()
            .context("REMOTE_CONTROL_INVALID_OBSERVATION")?,
        operation_phase: serde_json::from_value(value["operationPhase"].clone())?,
        journal_revision: value["journalRevision"]
            .as_u64()
            .context("REMOTE_CONTROL_INVALID_OBSERVATION")?,
        receiver: RemoteOperationReceiver {
            status,
            identity,
            terminal_confirmed: value["executionTerminalConfirmed"]
                .as_bool()
                .unwrap_or(false),
            finished_at_ms: source["finishedAtMs"].as_u64(),
            reason_code,
        },
        cleanup: match value["ownerCleanupState"].as_str() {
            Some("confirmed") => RemoteOperationCleanupStatus::Confirmed,
            Some("unconfirmed") => RemoteOperationCleanupStatus::Unconfirmed,
            _ => RemoteOperationCleanupStatus::NotObserved,
        },
        protocol,
        artifact,
        business_completed: false,
    })
}
