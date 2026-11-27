//! The source metadata is an explicit unit fixture; actual saved-file/OS producer gates are separate.
use super::*;
use kcoder_types::integrations::core::*;

fn intent(id: &str) -> NativeCodeServiceIntent {
    NativeCodeServiceIntent {
        template: NATIVE_CODE_SERVICE_TEMPLATE_V1.into(),
        lease_id: id.into(),
        operation_id: format!("approve-{id}"),
        scope: IntegrationScope {
            account_id: "owner".into(),
            target_id: "target".into(),
            workspace_id: IntegrationNullable::Value("workspace".into()),
            identity_generation: "identity".into(),
            target_revision: "configuration".into(),
            organization_id: None,
        },
        definition_id: "saved-code".into(),
        definition_version: 1,
        definition_sha256: "a".repeat(64),
        task_sha256: "b".repeat(64),
        configuration_sha256: "c".repeat(64),
        native_image_sha256: "d".repeat(64),
        expires_at_ms: 10000,
    }
}
fn source(intent: &NativeCodeServiceIntent) -> AuthenticatedNativeCodeServiceSource {
    AuthenticatedNativeCodeServiceSource::from_native_source(
        &intent.scope,
        &intent.definition_id,
        intent.definition_version,
        &intent.definition_sha256,
        &intent.task_sha256,
        &intent.configuration_sha256,
        &intent.native_image_sha256,
    )
    .unwrap()
}

#[test]
fn native_code_service_uses_original_issuer_and_absolute_deadline_without_channel_binding() {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let original = intent("one");
    let issuer =
        NativeDelegationAuthority::create_in(&root, OsStr::new("issuer"), &original.scope).unwrap();
    let issued = issuer
        .issue_native_code_service(&original, &source(&original), 100)
        .unwrap();
    assert_eq!(issued.expires_at_ms, 10000);
    assert_eq!(
        issuer
            .issue_native_code_service(&original, &source(&original), 500)
            .unwrap(),
        issued
    );
    let mut changed = original.clone();
    changed.expires_at_ms += 1;
    assert!(
        issuer
            .issue_native_code_service(&changed, &source(&changed), 600)
            .is_err()
    );
    drop(issuer);
    let reopened =
        NativeDelegationAuthority::open_in(&root, OsStr::new("issuer"), &original.scope).unwrap();
    let permit = reopened
        .authorize_native_code_service(&issued.reference, &original, &source(&original), 1000)
        .unwrap();
    reopened
        .revalidate_native_code_service(&permit, &source(&original), 1000)
        .unwrap();
    assert!(
        reopened
            .revalidate_native_code_service(&permit, &source(&original), 10000)
            .is_err()
    );
    assert_eq!(
        reopened
            .read_native_code_service_issue(&original, 10001)
            .unwrap()
            .unwrap()
            .status,
        IntegrationDelegationStatus::Expired
    );
    assert!(
        reopened
            .read_native_code_service_issue(&intent("not-issued"), 1000)
            .unwrap()
            .is_none()
    );
}

#[test]
fn native_code_service_revocation_and_changed_source_cannot_affect_a_peer_or_gain_scope() {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let one = intent("one");
    let two = intent("two");
    let issuer =
        NativeDelegationAuthority::create_in(&root, OsStr::new("issuer"), &one.scope).unwrap();
    let first = issuer
        .issue_native_code_service(&one, &source(&one), 100)
        .unwrap();
    let peer = issuer
        .issue_native_code_service(&two, &source(&two), 100)
        .unwrap();
    let permit = issuer
        .authorize_native_code_service(&first.reference, &one, &source(&one), 500)
        .unwrap();
    for field in 0..4 {
        let mut changed = one.clone();
        match field {
            0 => changed.definition_sha256 = "e".repeat(64),
            1 => changed.task_sha256 = "e".repeat(64),
            2 => changed.configuration_sha256 = "e".repeat(64),
            _ => changed.scope.identity_generation = "next".into(),
        }
        assert!(
            issuer
                .revalidate_native_code_service(&permit, &source(&changed), 500)
                .is_err()
        );
    }
    let revoked = issuer
        .revoke_native_code_service("stop-one", &first.reference, 600)
        .unwrap();
    assert_eq!(revoked.status, IntegrationDelegationStatus::Revoked);
    assert_eq!(
        issuer
            .revoke_native_code_service("stop-one", &first.reference, 700)
            .unwrap(),
        revoked
    );
    assert!(
        issuer
            .revalidate_native_code_service(&permit, &source(&one), 700)
            .is_err()
    );
    issuer
        .authorize_native_code_service(&peer.reference, &two, &source(&two), 700)
        .unwrap();
    issuer.revoke_identity("disable-owner", 800).unwrap();
    assert!(
        issuer
            .authorize_native_code_service(&peer.reference, &two, &source(&two), 900)
            .is_err()
    );
}
