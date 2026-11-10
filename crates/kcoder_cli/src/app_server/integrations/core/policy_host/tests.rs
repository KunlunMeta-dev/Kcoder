use super::*;
use kcoder_config::PrivateDirectory;
use serde_json::json;
use std::path::Path;

fn capture(profile: &Path, workspace: &Path, generation: &str) -> NativeIntegrationContext {
    NativeIntegrationContext::capture(profile, workspace, generation, "configuration-one").unwrap()
}

fn subject() -> AuthenticatedDelegationSubject {
    AuthenticatedDelegationSubject {
        connection_ref: IntegrationRevisionRef {
            id: "connection-one".into(),
            revision: "1".into(),
        },
        observed_subject_ref: IntegrationRevisionRef {
            id: "observed-one".into(),
            revision: "1".into(),
        },
        source_revision: "source-one".into(),
        channel_instance_id: "instance-one".into(),
    }
}

fn policy(context: &NativeIntegrationContext) -> AuthenticatedDelegationPolicy {
    AuthenticatedDelegationPolicy {
        scope: context.scope().clone(),
        revision: "native-current-policy".into(),
        allowed_actions: [
            IntegrationDelegationAction::AcceptTask,
            IntegrationDelegationAction::ReadTask,
        ]
        .into_iter()
        .collect(),
        resource_refs: vec![IntegrationEntityRef {
            kind: IntegrationEntityKind::Connection,
            id: "connection-one".into(),
            revision: Some("1".into()),
        }],
    }
}

fn request(context: &NativeIntegrationContext) -> IntegrationRequest {
    serde_json::from_value(json!({"contractVersion":"parallel-v1","requestId":"request-one","scope":context.scope(),
        "operationId":"prepare-one","timeoutMs":1000,"payload":{"purpose":"channel_binding","connectionId":"connection-one",
        "observedSubjectRef":{"id":"observed-one","revision":"1"},"actions":["runtime.acceptTask","runtime.readTask"],
        "resourceRefs":[{"kind":"connection","id":"connection-one","revision":"1"}],"expiresInMs":10000}})).unwrap()
}

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    NativeIntegrationContext,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_or_create(temp.path()).unwrap();
    root.create_private_child(OsStr::new("profile")).unwrap();
    root.create_private_child(OsStr::new("workspace")).unwrap();
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    let context = capture(&profile, &workspace, "connection-one");
    (temp, profile, workspace, context)
}

fn test_clock() -> impl Fn() -> u64 {
    // The host adds elapsed lock and validation time to the supplied timestamp.
    let started = std::time::Instant::now();
    move || 100 + started.elapsed().as_millis() as u64
}

#[test]
fn native_policy_preserves_original_operation_across_reconnect_and_durable_revocation() {
    let (_temp, profile, workspace, context) = fixture();
    let now = test_clock();
    assert!(NativePolicyService::load(&context).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 2);
    let (mut service, mut operations) = (None, None);
    let req = request(&context);
    let created = prepare_native_delegation(
        &context,
        &req,
        &subject(),
        &policy(&context),
        &mut service,
        &mut operations,
        now(),
    )
    .unwrap();
    let receipt = operations
        .as_ref()
        .unwrap()
        .read(&context, "prepare-one")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.phase, IntegrationOperationPhase::Completed);
    assert_eq!(
        receipt.entity_ref.as_ref().unwrap().kind,
        IntegrationEntityKind::Delegation
    );
    assert_eq!(receipt.entity_ref.unwrap().id, created.delegation_ref.id);
    drop(service);
    drop(operations);
    drop(context);
    let next = capture(&profile, &workspace, "connection-two");
    let (mut service, mut operations) = (None, None);
    let repeated = prepare_native_delegation(
        &next,
        &request(&next),
        &subject(),
        &policy(&next),
        &mut service,
        &mut operations,
        now(),
    )
    .unwrap();
    assert_eq!(repeated, created);
    let service = service.unwrap();
    let permit = service
        .authorize(
            &next,
            &created.delegation_ref,
            &subject(),
            &policy(&next),
            IntegrationDelegationAction::ReadTask,
            &policy(&next).resource_refs,
            now(),
        )
        .unwrap();
    let revoked = service
        .revoke(&next, "revoke-one", &created.delegation_ref, now())
        .unwrap();
    assert_eq!(revoked.status, IntegrationDelegationStatus::Revoked);
    assert!(!revoked.cancellation_requested && !revoked.cancellation_settled);
    assert!(
        service
            .revalidate(&next, &permit, &subject(), &policy(&next), now())
            .is_err()
    );
    assert_eq!(
        service
            .read(&next, &created.delegation_ref.id, now())
            .unwrap()
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
}

#[test]
fn invalid_observations_and_scope_do_not_create_issuer_or_operation_storage() {
    let (_temp, profile, _, context) = fixture();
    let (mut service, mut operations) = (None, None);
    let mut bad_subject = subject();
    bad_subject.connection_ref.id = "other".into();
    assert!(
        prepare_native_delegation(
            &context,
            &request(&context),
            &bad_subject,
            &policy(&context),
            &mut service,
            &mut operations,
            100
        )
        .is_err()
    );
    let mut bad_request = request(&context);
    bad_request.scope.account_id = "other".into();
    assert!(
        prepare_native_delegation(
            &context,
            &bad_request,
            &subject(),
            &policy(&context),
            &mut service,
            &mut operations,
            101
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 2);
}

#[test]
fn reserved_original_operation_without_issuer_result_is_unknown_and_never_reissued() {
    let (_temp, profile, _, context) = fixture();
    let req = request(&context);
    let ledger = NativeOperations::initialize(&context, "prepare-one").unwrap();
    let _ = ledger
        .begin(&context, &req, "P-POLICY", "prepareDelegation")
        .unwrap();
    let (mut service, mut operations) = (None, Some(ledger));
    assert!(
        prepare_native_delegation(
            &context,
            &req,
            &subject(),
            &policy(&context),
            &mut service,
            &mut operations,
            100
        )
        .is_err()
    );
    assert!(NativePolicyService::load(&context).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 4);
    assert_eq!(
        operations
            .unwrap()
            .read(&context, "prepare-one")
            .unwrap()
            .unwrap()
            .phase,
        IntegrationOperationPhase::Unknown
    );
}

#[test]
fn lost_original_issuer_directory_does_not_mint_a_replacement() {
    let (temp, profile, _, context) = fixture();
    let (mut service, mut operations) = (None, None);
    prepare_native_delegation(
        &context,
        &request(&context),
        &subject(),
        &policy(&context),
        &mut service,
        &mut operations,
        100,
    )
    .unwrap();
    let directory_name = service.as_ref().unwrap().guard.namespace_id().to_string();
    std::fs::rename(
        profile.join(&directory_name),
        temp.path().join("lost-issuer"),
    )
    .unwrap();
    drop(service);
    assert!(NativePolicyService::load(&context).is_err());
    assert!(!profile.join(directory_name).exists());
}
