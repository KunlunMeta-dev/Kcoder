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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::remote_delegations::source_budget::tests::Fixture;
    #[tokio::test]
    async fn fresh_control_reads_absence_without_namespace_or_task_creation_and_old_owner_cannot_write()
     {
        let f = Fixture::new();
        let owner = Arc::new(());
        let control = NativeRemoteOperationControl::capture(
            &f.native,
            &f.engine,
            Arc::downgrade(&owner),
            CancellationToken::new(),
        )
        .unwrap();
        let before = std::fs::read_dir(f.native.profile_path().unwrap())
            .unwrap()
            .count();
        let params = RemoteOperationControlParams {
            request_id: "read-original".into(),
            scope: f.native.scope().clone(),
            operation_id: "not-created".into(),
            expected_revision: None,
        };
        let recent = control
            .list(&RemoteOperationListParams {
                request_id: "read-own-recent".into(),
                scope: params.scope.clone(),
            })
            .unwrap();
        assert!(recent.items.is_empty());
        assert_eq!(recent.total, 0);
        let reply = control.run(&params, false).unwrap();
        assert!(reply.snapshot.is_none());
        assert_eq!(reply.scope, params.scope);
        assert_eq!(
            std::fs::read_dir(f.native.profile_path().unwrap())
                .unwrap()
                .count(),
            before
        );
        let mut foreign = params.clone();
        foreign.scope.account_id = "another-account".into();
        assert!(control.run(&foreign, false).is_err());
        drop(owner);
        assert!(control.run(&params, false).is_err());
        assert_eq!(
            std::fs::read_dir(f.native.profile_path().unwrap())
                .unwrap()
                .count(),
            before
        );
        f.close().await;
    }

    #[tokio::test]
    async fn original_endpoint_receipts_reopen_as_readonly_controls_without_local_receiver_tokens()
    {
        use kcoder_state::integrations::core::remote_delegations::NativeRemoteEndpointReceiverObservation;
        use kcoder_types::integrations::core::{
            NativeRemoteAcceptedFactsV1, NativeRemoteCallOutcomeV1 as Outcome,
            NativeRemoteTurnIdentityV1,
        };
        use serde_json::json;
        let f = Fixture::new();
        let owner = Arc::new(());
        let control = NativeRemoteOperationControl::capture(
            &f.native,
            &f.engine,
            Arc::downgrade(&owner),
            CancellationToken::new(),
        )
        .unwrap();
        let operations = match NativeOperations::load(&f.native).unwrap() {
            Some(existing) => existing,
            None => NativeOperations::initialize(&f.native, "original-endpoint-controls").unwrap(),
        };
        let (_guard, store) = NativeDomainGuard::initialize(
            f.native.profile().unwrap(),
            f.native.scope(),
            NativeDomain::RemoteDelegations,
            "original-endpoint-controls",
            |directory| {
                NativeRemoteDelegationStore::create_in(
                    directory,
                    OsStr::new("data"),
                    f.native.scope(),
                )
            },
        )
        .unwrap();
        for (index, outcome, status, terminal) in [
            (0, None, RemoteOperationReceiverStatus::Accepted, false),
            (
                1,
                Some(Outcome::OutcomeUnknown),
                RemoteOperationReceiverStatus::Unknown,
                false,
            ),
            (
                2,
                Some(Outcome::Completed),
                RemoteOperationReceiverStatus::Completed,
                true,
            ),
            (
                3,
                Some(Outcome::Failed),
                RemoteOperationReceiverStatus::Failed,
                true,
            ),
            (
                4,
                Some(Outcome::Interrupted),
                RemoteOperationReceiverStatus::Interrupted,
                true,
            ),
        ] {
            let operation = format!("original-endpoint-{index}");
            let request = IntegrationRequest {
                contract_version: IntegrationContractVersion::ParallelV1,
                request_id: format!("seed-{operation}"),
                scope: f.native.scope().clone(),
                operation_id: Some(operation.clone()),
                expected_revision: None,
                timeout_ms: 1000,
                cancellation_ref: None,
                payload: json!({"prompt":"Original endpoint input"})
                    .as_object()
                    .unwrap()
                    .clone(),
            };
            operations
                .begin(&f.native, &request, "P-REMOTE", "delegate")
                .unwrap();
            store.begin(&NativeRemotePlan{operation_id:operation.clone(),scope:f.native.scope().clone(),
                public_intent:Value::Object(request.payload),recipient_revision:"selected-target-revision".into(),
                recipient_identity:json!({"kind":"native_ssh_acp","targetId":"selected-target"})}).unwrap();
            for (stage, receipt) in [
                (
                    NativeRemoteStage::Spawn,
                    json!({"ownedEndpointInstanceId":"original-endpoint-instance"}),
                ),
                (NativeRemoteStage::Initialize, json!({"protocolVersion":1})),
                (
                    NativeRemoteStage::BindOriginal,
                    json!({"data":{"kind":"original_bound","receiverSettingsSha256":"c".repeat(64)}}),
                ),
                (
                    NativeRemoteStage::Session,
                    json!({"sessionId":"original-remote-session"}),
                ),
            ] {
                let permit = store
                    .before_dispatch(
                        &operation,
                        f.native.scope(),
                        stage,
                        &json!({"original":true}),
                    )
                    .unwrap();
                store.receive(&permit, &receipt).unwrap();
            }
            let _prompt = store
                .before_dispatch(
                    &operation,
                    f.native.scope(),
                    NativeRemoteStage::Prompt,
                    &json!({"original":true}),
                )
                .unwrap();
            let mut receiver_scope = f.native.scope().clone();
            receiver_scope.account_id = "original-remote-account".into();
            store
                .record_endpoint_receiver(
                    &operation,
                    &NativeRemoteEndpointReceiverObservation {
                        endpoint_instance_id: "original-endpoint-instance".into(),
                        accepted: NativeRemoteAcceptedFactsV1 {
                            identity: NativeRemoteTurnIdentityV1 {
                                thread_id: format!("receiver-thread-{index}"),
                                turn_id: "original-receiver-turn".into(),
                                attempt_id: "original-receiver-attempt".into(),
                            },
                            accepted_input_sha256: "a".repeat(64),
                            accepted_receipt_sha256: "b".repeat(64),
                            receiver_settings_sha256: "c".repeat(64),
                            receiver_scope: Some(receiver_scope),
                        },
                        outcome,
                        cleanup_confirmed: false,
                    },
                )
                .unwrap();
            let before = store.read(&operation).unwrap().unwrap();
            assert!(
                before.receiver.is_none(),
                "Endpoint facts cannot create a local Accepted receiver token"
            );
            let params = RemoteOperationControlParams {
                request_id: format!("read-{operation}"),
                scope: f.native.scope().clone(),
                operation_id: operation.clone(),
                expected_revision: None,
            };
            let projected = control.run(&params, false).unwrap().snapshot.unwrap();
            assert_eq!(projected.receiver.status, status);
            assert_eq!(projected.receiver.terminal_confirmed, terminal);
            assert_eq!(
                projected.receiver.identity.unwrap().thread_id,
                format!("receiver-thread-{index}")
            );
            assert_eq!(
                projected.cleanup,
                RemoteOperationCleanupStatus::NotObserved,
                "Receiver terminal does not prove owned-tree cleanup"
            );
            assert!(!projected.business_completed);
            let recent = control
                .list(&RemoteOperationListParams {
                    request_id: format!("list-{operation}"),
                    scope: f.native.scope().clone(),
                })
                .unwrap();
            assert!(
                recent
                    .items
                    .iter()
                    .find(|row| row.operation_id == operation)
                    .unwrap()
                    .receiver_observed
            );
            assert_eq!(
                store.read(&operation).unwrap().unwrap().revision,
                before.revision,
                "Read/recent cannot modify the original journal"
            );
            let mut foreign = params;
            foreign.scope.account_id = "other-source-account".into();
            assert!(control.run(&foreign, false).is_err());
        }
        drop(owner);
        assert!(
            control
                .list(&RemoteOperationListParams {
                    request_id: "revoked-original-owner".into(),
                    scope: f.native.scope().clone()
                })
                .is_err()
        );
        f.close().await;
    }
}
