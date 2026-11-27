//! Original remote operation control reads and owner checks over the actual Native store.
use super::*;
// The production module's private imports, re-stated for this attached test module.
use super::super::super::{NativeDomain, NativeDomainGuard, NativeOperations};
use crate::app_server::integrations::core::remote_delegations::source_budget::tests::Fixture;
use kcoder_state::integrations::core::remote_delegations::{
    NativeRemoteDelegationStore, NativeRemotePlan, NativeRemoteStage,
};
use kcoder_types::integrations::core::*;
use serde_json::Value;
use std::{ffi::OsStr, sync::Arc};
use tokio_util::sync::CancellationToken;
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
async fn original_endpoint_receipts_reopen_as_readonly_controls_without_local_receiver_tokens() {
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
            NativeRemoteDelegationStore::create_in(directory, OsStr::new("data"), f.native.scope())
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
        store
            .begin(&NativeRemotePlan {
                operation_id: operation.clone(),
                scope: f.native.scope().clone(),
                public_intent: Value::Object(request.payload),
                recipient_revision: "selected-target-revision".into(),
                recipient_identity: json!({"kind":"native_ssh_acp","targetId":"selected-target"}),
            })
            .unwrap();
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
