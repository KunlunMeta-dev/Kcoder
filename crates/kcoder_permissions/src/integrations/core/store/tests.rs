use super::*;
use kcoder_types::integrations::core::{IntegrationEntityKind, IntegrationNullable};
use serde_json::json;

#[test]
fn retired_service_proofs_cannot_execute_and_do_not_break_other_records_in_the_journal()
-> Result<()> {
    use kcoder_types::integrations::core::{
        NATIVE_CODE_SERVICE_TEMPLATE_V1, NativeCodeServiceIntent,
    };

    let (root, parent, authority) = fixture();
    let (ordinary, proof) =
        authority.issue("ordinary-source", &params(), &subject(), &policy(), 100)?;

    // Recreate the old wire bytes directly, independently of the decode-only
    // historical struct. No production issuer can construct a service grant.
    let legacy_intent = format!(
        r#"{{"template":"native-background-service-v1","leaseId":"retired-channel-service","operationId":"retired-service-approval","scope":{},"sourceBindingRef":{},"sourceConnectionId":"connection-one","observedSubjectRef":{},"sourceRevision":"sdk-source-one","configurationSha256":"{}","nativeImageSha256":"{}","actions":{},"expiresAtMs":10000}}"#,
        serde_json::to_string(&scope())?,
        serde_json::to_string(&ordinary.delegation_ref)?,
        serde_json::to_string(&subject().observed_subject_ref)?,
        "a".repeat(64),
        "b".repeat(64),
        serde_json::to_string(&params().actions)?,
    );
    let mut claims = proof.claims.clone();
    claims.delegation_id = "retired-channel-service-proof".into();
    claims.expires_at_ms = 10000.into();
    let mut legacy_claims = serde_json::to_string(&claims)?;
    assert_eq!(legacy_claims.pop(), Some('}'));
    legacy_claims.push_str(&format!(r#","serviceLease":{legacy_intent}}}"#));
    let mut signed_bytes = b"kcoder-native-service-delegation-v1\0".to_vec();
    signed_bytes.extend_from_slice(legacy_claims.as_bytes());
    let signature = authority.key.sign(&signed_bytes).as_ref().to_vec();
    let legacy_proof = SignedDelegation::from_private_bytes(
        format!(
            r#"{{"claims":{legacy_claims},"signature":{}}}"#,
            serde_json::to_string(&signature)?
        )
        .as_bytes(),
    )?;
    {
        let _writer = authority.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = authority.read_journal()?;
        authority.commit(
            &mut journal,
            Event::Issued {
                operation_id: "retired-service-approval".into(),
                intent: digest(
                    format!(r#"["native-service-lease-issue-v1",{legacy_intent}]"#).as_bytes(),
                ),
                proof: Box::new(legacy_proof.clone()),
            },
        )?;
    }

    let code_intent = NativeCodeServiceIntent {
        template: NATIVE_CODE_SERVICE_TEMPLATE_V1.into(),
        lease_id: "saved-code".into(),
        operation_id: "approve-saved-code".into(),
        scope: scope(),
        definition_id: "saved-code-definition".into(),
        definition_version: 1,
        definition_sha256: "c".repeat(64),
        task_sha256: "d".repeat(64),
        configuration_sha256: "e".repeat(64),
        native_image_sha256: "f".repeat(64),
        expires_at_ms: 10000,
    };
    let code_source = AuthenticatedNativeCodeServiceSource::from_native_source(
        &code_intent.scope,
        &code_intent.definition_id,
        code_intent.definition_version,
        &code_intent.definition_sha256,
        &code_intent.task_sha256,
        &code_intent.configuration_sha256,
        &code_intent.native_image_sha256,
    )?;
    let code = authority.issue_native_code_service(&code_intent, &code_source, 200)?;
    let path = root.path().join("issuer").join(JOURNAL_FILE);
    let original_bytes = std::fs::read(&path)?;
    drop(authority);
    let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    let retired = reopened
        .read(&legacy_proof.claims.delegation_id, 300)?
        .unwrap();
    assert_eq!(retired.status, IntegrationDelegationStatus::Revoked);
    assert_eq!(
        reopened
            .read(&ordinary.delegation_ref.id, 300)?
            .unwrap()
            .status,
        IntegrationDelegationStatus::Active
    );
    assert_eq!(
        reopened
            .authorize(
                &legacy_proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                300
            )
            .err()
            .unwrap()
            .to_string(),
        "DELEGATION_SERVICE_RETIRED"
    );
    let old_permit = DelegationPermit {
        proof: legacy_proof.clone(),
        action: IntegrationDelegationAction::ReadTask,
        resource_refs: vec![resource()],
    };
    assert!(
        reopened
            .revalidate(&old_permit, &policy(), &subject(), 300)
            .is_err()
    );
    reopened.authorize(
        &proof,
        &policy(),
        &subject(),
        IntegrationDelegationAction::ReadTask,
        &[resource()],
        300,
    )?;
    let code_permit =
        reopened.authorize_native_code_service(&code.reference, &code_intent, &code_source, 300)?;
    reopened.revalidate_native_code_service(&code_permit, &code_source, 300)?;
    assert!(
        reopened
            .issue(
                "retired-service-approval",
                &params(),
                &subject(),
                &policy(),
                300
            )
            .is_err()
    );
    let mut corrupted = legacy_proof;
    corrupted.signature[0] ^= 1;
    assert!(
        reopened
            .authorize(
                &corrupted,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                300
            )
            .is_err()
    );
    assert_eq!(
        std::fs::read(path)?,
        original_bytes,
        "Reading retired records must not rewrite the shared journal"
    );
    Ok(())
}

#[test]
fn warm_journal_reuses_verified_bytes_and_observes_cross_instance_revocation() -> Result<()> {
    let (_root, parent, authority) = fixture();
    for index in 0..46 {
        authority.issue(
            &format!("warm-grant-{index}"),
            &params(),
            &subject(),
            &policy(),
            100,
        )?;
    }
    let (grant, proof) = authority.issue("warm-current", &params(), &subject(), &policy(), 100)?;
    let samples = |cold: bool| -> Result<Vec<u128>> {
        let mut times = Vec::new();
        for _ in 0..48 {
            if cold {
                *authority.verified_journal.lock().unwrap() = None;
            }
            let start = std::time::Instant::now();
            assert_eq!(
                authority
                    .read(&grant.delegation_ref.id, 200)?
                    .unwrap()
                    .status,
                IntegrationDelegationStatus::Active
            );
            times.push(start.elapsed().as_micros());
        }
        times.sort_unstable();
        Ok(times)
    };
    let cold = samples(true)?;
    let before = authority
        .journal_replays
        .load(std::sync::atomic::Ordering::Relaxed);
    let warm = samples(false)?;
    assert_eq!(
        authority
            .journal_replays
            .load(std::sync::atomic::Ordering::Relaxed),
        before,
        "unchanged reads must not replay or reverify historical signatures"
    );
    {
        let bytes = authority
            .journal_bytes_read
            .load(std::sync::atomic::Ordering::Relaxed);
        let journal_len = authority
            .verified_journal
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bytes
            .len();
        samples(false)?;
        assert_eq!(
            authority
                .journal_bytes_read
                .load(std::sync::atomic::Ordering::Relaxed),
            bytes + 48 * journal_len,
            "each warm observation must read current journal bytes exactly once"
        );
    }
    eprintln!(
        "CHANNEL_LATENCY group=issuer samples=48 cold_p50_us={} cold_p95_us={} warm_p50_us={} warm_p95_us={}",
        cold[24], cold[45], warm[24], warm[45]
    );
    let other = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    other.revoke("other-process-revoke", &grant.delegation_ref.id, "1", 300)?;
    assert_eq!(
        authority
            .read(&grant.delegation_ref.id, 301)?
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                301
            )
            .is_err()
    );
    // Same-size corruption with an unchanged head must never hit the cache.
    let path = parent
        .open_entry_handle(OsStr::new("issuer"))?
        .open_child_directory()?;
    let mut bytes = read_file(&path, JOURNAL_FILE, MAX_JOURNAL_BYTES)?;
    bytes[0] = b'!';
    use std::io::{Seek, SeekFrom, Write};
    let mut file = path.open_read_write_file(OsStr::new(JOURNAL_FILE), false)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    assert!(authority.read(&grant.delegation_ref.id, 302).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    Ok(())
}

#[test]
fn effect_authorization_reads_one_current_journal_and_rejects_cross_instance_revoke() -> Result<()>
{
    let (_root, parent, authority) = fixture();
    let (grant, proof) =
        authority.issue("personal-effect", &params(), &subject(), &policy(), 100)?;
    let checked = || {
        authority.authorize(
            &proof,
            &policy(),
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &params().resource_refs,
            200,
        )
    };
    let authorized = checked()?;
    assert_eq!(authorized.proof, proof);
    assert_eq!(authorized.action, IntegrationDelegationAction::ReadTask);
    assert_eq!(authorized.resource_refs, params().resource_refs);
    let journal_len = authority
        .verified_journal
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .bytes
        .len();
    let count = || {
        authority
            .journal_bytes_read
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    let before = count();
    checked()?;
    assert_eq!(count() - before, journal_len);
    let other = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    other.revoke(
        "personal-effect-revoked",
        &grant.delegation_ref.id,
        "1",
        201,
    )?;
    assert!(checked().is_err());
    Ok(())
}

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "native-account".into(),
        target_id: "native-target".into(),
        workspace_id: IntegrationNullable::Value("native-workspace".into()),
        identity_generation: "connection-one".into(),
        target_revision: "configuration-one".into(),
        organization_id: None,
    }
}

fn resource() -> IntegrationEntityRef {
    IntegrationEntityRef {
        kind: IntegrationEntityKind::Connection,
        id: "connection-one".into(),
        revision: Some("1".into()),
    }
}

fn subject() -> AuthenticatedDelegationSubject {
    AuthenticatedDelegationSubject {
        connection_ref: IntegrationRevisionRef {
            id: "connection-one".into(),
            revision: "1".into(),
        },
        observed_subject_ref: IntegrationRevisionRef {
            id: "observed-one".into(),
            revision: "4".into(),
        },
        source_revision: "sdk-source-one".into(),
        channel_instance_id: "channel-instance-one".into(),
    }
}

fn policy() -> AuthenticatedDelegationPolicy {
    AuthenticatedDelegationPolicy {
        scope: scope(),
        revision: "native-policy-one".into(),
        allowed_actions: [
            IntegrationDelegationAction::AcceptTask,
            IntegrationDelegationAction::ReadTask,
        ]
        .into_iter()
        .collect(),
        resource_refs: vec![resource()],
    }
}

fn params() -> IntegrationDelegationPrepareParams {
    serde_json::from_value(json!({"purpose":"channel_binding","connectionId":"connection-one",
        "observedSubjectRef":{"id":"observed-one","revision":"4"},"actions":["runtime.acceptTask","runtime.readTask"],
        "resourceRefs":[{"kind":"connection","id":"connection-one","revision":"1"}],"expiresInMs":10000})).unwrap()
}

fn fixture() -> (
    tempfile::TempDir,
    PrivateDirectory,
    NativeDelegationAuthority,
) {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let authority =
        NativeDelegationAuthority::create_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    (temp, parent, authority)
}

#[test]
fn native_issuer_survives_reopen_without_extending_a_grant() {
    let (_temp, parent, authority) = fixture();
    let (first, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    assert_eq!(first.status, IntegrationDelegationStatus::Active);
    assert_eq!(first.expires_at_ms, 10100.into());
    assert_eq!(
        authority
            .issue("operation-one", &params(), &subject(), &policy(), 500)
            .unwrap()
            .0,
        first
    );
    let mut changed = params();
    changed.expires_in_ms = 10001.into();
    assert!(
        authority
            .issue("operation-one", &changed, &subject(), &policy(), 500)
            .is_err()
    );
    drop(authority);
    let next_scope = scope();
    let reopened =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &next_scope).unwrap();
    let mut next_policy = policy();
    next_policy.scope = next_scope;
    reopened
        .authorize(
            &proof,
            &next_policy,
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &[resource()],
            600,
        )
        .unwrap();
    assert_eq!(
        reopened
            .issue("operation-one", &params(), &subject(), &next_policy, 10000)
            .unwrap()
            .0
            .expires_at_ms,
        10100.into()
    );
}

#[test]
fn tampering_forged_issuers_and_caller_verification_keys_cannot_authorize() {
    let (_temp, _parent, authority) = fixture();
    let (_, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    let mut bad = serde_json::to_value(&proof).unwrap();
    bad["claims"]["actions"] = json!(["runtime.cancelTask"]);
    let bad = SignedDelegation::from_private_bytes(&serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(
        authority
            .authorize(
                &bad,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                101
            )
            .is_err()
    );
    let mut key = serde_json::to_value(&proof).unwrap();
    key["publicKey"] = json!([1, 2, 3]);
    assert!(SignedDelegation::from_private_bytes(&serde_json::to_vec(&key).unwrap()).is_err());
    let (_other_temp, _, other) = fixture();
    assert!(
        other
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                101
            )
            .is_err()
    );
    assert!(!format!("{proof:?}").contains(&proof.claims.nonce));
    assert!(!format!("{authority:?}").contains(&proof.claims.issuer_id));
}

#[test]
fn exact_actions_resources_subject_revision_and_current_native_policy_are_required() {
    let (_temp, _, authority) = fixture();
    let (_, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::CancelTask,
                &[resource()],
                101
            )
            .is_err()
    );
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[],
                101
            )
            .is_err()
    );
    for property in ["subject", "source", "connection"] {
        let mut changed = subject();
        match property {
            "subject" => changed.observed_subject_ref.revision = "5".into(),
            "source" => changed.source_revision = "other-source".into(),
            _ => changed.connection_ref.id = "other-connection".into(),
        }
        assert!(
            authority
                .authorize(
                    &proof,
                    &policy(),
                    &changed,
                    IntegrationDelegationAction::ReadTask,
                    &[resource()],
                    101
                )
                .is_err()
        );
    }
    for property in [
        "account",
        "target",
        "workspace",
        "policy",
        "configuration",
        "resource",
        "identity",
    ] {
        let mut changed = policy();
        match property {
            "account" => changed.scope.account_id = "other".into(),
            "target" => changed.scope.target_id = "other".into(),
            "workspace" => changed.scope.workspace_id = IntegrationNullable::Null,
            "policy" => changed.revision = "other".into(),
            "configuration" => changed.scope.target_revision = "other".into(),
            "identity" => changed.scope.identity_generation = "other-identity-generation".into(),
            _ => changed.resource_refs[0].revision = Some("2".into()),
        }
        assert!(
            authority
                .authorize(
                    &proof,
                    &changed,
                    &subject(),
                    IntegrationDelegationAction::ReadTask,
                    &[resource()],
                    101
                )
                .is_err()
        );
    }
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                99
            )
            .is_err()
    );
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                10100
            )
            .is_err()
    );
}

#[test]
fn transport_restart_preserves_the_same_stable_subject_but_not_changed_security_source() {
    let (_temp, parent, authority) = fixture();
    let (_, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    drop(authority);
    let authority =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    let mut reconnected = subject();
    reconnected.connection_ref.revision = "42".into();
    reconnected.channel_instance_id = "new-owned-sdk-socket".into();
    authority
        .authorize(
            &proof,
            &policy(),
            &reconnected,
            IntegrationDelegationAction::ReadTask,
            &[resource()],
            101,
        )
        .unwrap();
    reconnected.source_revision = "new-credential-binding-version".into();
    assert!(
        authority
            .authorize(
                &proof,
                &policy(),
                &reconnected,
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                102
            )
            .is_err()
    );
}

#[test]
fn revocation_is_durable_cas_idempotent_and_invalidates_existing_permits() {
    let (_temp, parent, authority) = fixture();
    let (view, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    let permit = authority
        .authorize(
            &proof,
            &policy(),
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &[resource()],
            101,
        )
        .unwrap();
    authority
        .revalidate(&permit, &policy(), &subject(), 102)
        .unwrap();
    assert!(
        authority
            .revoke("bad-revision", &view.delegation_ref.id, "2", 102)
            .is_err()
    );
    let revoked = authority
        .revoke("revoke-one", &view.delegation_ref.id, "1", 103)
        .unwrap();
    assert_eq!(revoked.status, IntegrationDelegationStatus::Revoked);
    assert_eq!(revoked.delegation_ref.revision, "2");
    assert_eq!(
        authority
            .revoke("revoke-one", &view.delegation_ref.id, "1", 104)
            .unwrap(),
        revoked
    );
    assert!(
        authority
            .revalidate(&permit, &policy(), &subject(), 105)
            .is_err()
    );
    let reopened =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    assert!(
        reopened
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                106
            )
            .is_err()
    );
    assert_eq!(
        reopened
            .read(&view.delegation_ref.id, 106)
            .unwrap()
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
    assert!(reopened.read_private_proof(&view.delegation_ref).is_err());
}

#[test]
fn identity_disable_reaches_other_open_instances_and_survives_restart() {
    let (_temp, parent, authority) = fixture();
    let (_, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    let second =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    let permit = second
        .authorize(
            &proof,
            &policy(),
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &[resource()],
            101,
        )
        .unwrap();
    authority
        .revoke_identity("identity-revoke-one", 102)
        .unwrap();
    authority
        .revoke_identity("identity-revoke-one", 103)
        .unwrap();
    assert!(
        second
            .revalidate(&permit, &policy(), &subject(), 103)
            .is_err()
    );
    assert!(
        second
            .issue(
                "late-old-management-call",
                &params(),
                &subject(),
                &policy(),
                103
            )
            .is_err()
    );
    drop(authority);
    drop(second);
    let reopened =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    assert!(
        reopened
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                104
            )
            .is_err()
    );
    assert!(
        reopened
            .issue(
                "restart-must-not-reenable",
                &params(),
                &subject(),
                &policy(),
                104
            )
            .is_err()
    );
}

#[test]
fn committed_storage_loss_never_recreates_or_reissues_authority() {
    for name in [BINDING_FILE, KEY_FILE, JOURNAL_FILE, HEAD_FILE, LOCK_FILE] {
        let (temp, parent, authority) = fixture();
        authority
            .issue("operation-one", &params(), &subject(), &policy(), 100)
            .unwrap();
        std::fs::remove_file(temp.path().join("issuer").join(name)).unwrap();
        assert!(authority.read("missing", 101).is_err(), "missing {name}");
        assert!(
            NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err(),
            "reopen {name}"
        );
        assert!(!temp.path().join("issuer").join(name).exists());
    }
}

#[test]
fn committed_journal_truncation_and_partial_tail_are_explicit_errors() {
    let (temp, parent, authority) = fixture();
    let (view, _) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    let path = temp.path().join("issuer").join(JOURNAL_FILE);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"").unwrap();
    assert!(authority.read(&view.delegation_ref.id, 101).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    std::fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
    assert!(authority.read(&view.delegation_ref.id, 102).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes[..bytes.len() - 1]);
}

#[test]
fn complete_append_survives_lost_head_update_without_reissuing_the_action() {
    let (temp, parent, authority) = fixture();
    let head_path = temp.path().join("issuer").join(HEAD_FILE);
    let prior_head = std::fs::read(&head_path).unwrap();
    let (first, proof) = authority
        .issue("operation-one", &params(), &subject(), &policy(), 100)
        .unwrap();
    std::fs::write(&head_path, prior_head).unwrap();
    let reopened =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    assert_eq!(
        reopened
            .issue("operation-one", &params(), &subject(), &policy(), 101)
            .unwrap()
            .1,
        proof
    );
    reopened
        .revoke("revoke-one", &first.delegation_ref.id, "1", 102)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("issuer").join(JOURNAL_FILE))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn missing_live_sdk_observation_cannot_be_replaced_with_similar_caller_labels() {
    let (_temp, _, authority) = fixture();
    let mut changed = subject();
    changed.observed_subject_ref.id = "observed-two".into();
    assert!(
        authority
            .issue("operation-one", &params(), &changed, &policy(), 100)
            .is_err()
    );
    let mut narrowed = policy();
    narrowed.allowed_actions.clear();
    assert!(
        authority
            .issue("operation-one", &params(), &subject(), &narrowed, 100)
            .is_err()
    );
    let mut unversioned = params();
    unversioned.resource_refs[0].revision = None;
    assert!(
        authority
            .issue("operation-one", &unversioned, &subject(), &policy(), 100)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn hardlinked_or_replaced_native_files_fail_closed_without_permission_repairs() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, _, authority) = fixture();
    let path = temp.path().join("issuer").join(KEY_FILE);
    std::fs::hard_link(&path, temp.path().join("other-link")).unwrap();
    assert!(authority.read("missing", 100).is_err());
    std::fs::remove_file(temp.path().join("other-link")).unwrap();
    std::fs::set_permissions(
        temp.path().join("issuer"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(authority.read("missing", 101).is_err());
    assert_eq!(
        std::fs::metadata(temp.path().join("issuer"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[test]
fn held_issuer_rejects_in_place_key_corruption() -> Result<()> {
    let (temp, _, authority) = fixture();
    let (issued, _) = authority.issue("warm-key", &params(), &subject(), &policy(), 100)?;
    assert!(authority.read(&issued.delegation_ref.id, 101)?.is_some());
    let path = temp.path().join("issuer").join(KEY_FILE);
    let original = Zeroizing::new(std::fs::read(&path)?);
    let mut damaged = Zeroizing::new(original.to_vec());
    damaged[0] ^= 1;
    std::fs::write(&path, &damaged[..])?;
    assert!(authority.read(&issued.delegation_ref.id, 102).is_err());
    std::fs::write(&path, &original[..])?;
    assert!(authority.read(&issued.delegation_ref.id, 103)?.is_some());
    Ok(())
}

#[test]
fn persistent_authorization_survives_restart_but_rechecks_identity_policy_and_revocation() {
    use kcoder_types::integrations::core::IntegrationAuthorizationTime::UntilRevoked;
    let (_temp, parent, authority) = fixture();
    let mut selected = params();
    selected.expires_in_ms = UntilRevoked;
    let (issued, proof) = authority
        .issue("persistent-consent", &selected, &subject(), &policy(), 100)
        .unwrap();
    assert_eq!(issued.expires_at_ms, UntilRevoked);
    let mut tampered = serde_json::to_value(&proof).unwrap();
    tampered["claims"]["expiresAtMs"] = json!(999999);
    assert!(
        SignedDelegation::from_private_bytes(&serde_json::to_vec(&tampered).unwrap())
            .unwrap()
            .verify(&authority.key)
            .is_err()
    );
    drop(authority);
    let reopened =
        NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).unwrap();
    let at = 100 + 366 * 86_400_000;
    let permit = reopened
        .authorize(
            &proof,
            &policy(),
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &[resource()],
            at,
        )
        .unwrap();
    let mut changed_subject = subject();
    changed_subject.observed_subject_ref.id = "another-actor".into();
    assert!(
        reopened
            .revalidate(&permit, &policy(), &changed_subject, at)
            .is_err()
    );
    let mut changed_policy = policy();
    changed_policy.allowed_actions.clear();
    assert!(
        reopened
            .revalidate(&permit, &changed_policy, &subject(), at)
            .is_err()
    );
    reopened
        .revoke(
            "explicit-revocation",
            &issued.delegation_ref.id,
            &issued.delegation_ref.revision,
            at,
        )
        .unwrap();
    assert!(
        reopened
            .revalidate(&permit, &policy(), &subject(), at + 1)
            .is_err()
    );
    assert_eq!(
        reopened
            .read(&issued.delegation_ref.id, at + 1)
            .unwrap()
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
}

#[test]
fn legacy_signed_deadline_is_not_migrated_to_persistent_consent() {
    let (_temp, _parent, authority) = fixture();
    let (issued, proof) = authority
        .issue("limited-consent", &params(), &subject(), &policy(), 100)
        .unwrap();
    let mut tampered = serde_json::to_value(&proof).unwrap();
    tampered["claims"]["expiresAtMs"] = json!(null);
    assert!(
        SignedDelegation::from_private_bytes(&serde_json::to_vec(&tampered).unwrap())
            .unwrap()
            .verify(&authority.key)
            .is_err()
    );
    assert_eq!(
        authority
            .read(&issued.delegation_ref.id, 10100)
            .unwrap()
            .unwrap()
            .status,
        IntegrationDelegationStatus::Expired
    );
}
