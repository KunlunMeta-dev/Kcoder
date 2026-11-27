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
        let journal = authority.read_journal()?;
        authority.commit(
            &journal,
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

fn counter(value: &std::sync::atomic::AtomicUsize) -> usize {
    journal_cache::TestCounters::get(value)
}

#[test]
fn warm_journal_reuses_verified_bytes_and_observes_cross_instance_revocation() -> Result<()> {
    let (_root, parent, authority) = fixture();
    for index in 0..30 {
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
                authority.invalidate_journal_cache()?;
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
    let before = counter(&authority.counters.full_replays);
    let tails = counter(&authority.counters.tail_parses);
    let warm = samples(false)?;
    assert_eq!(
        counter(&authority.counters.full_replays),
        before,
        "unchanged reads must not replay or reverify historical signatures"
    );
    assert_eq!(counter(&authority.counters.tail_parses), tails);
    {
        let bytes = counter(&authority.counters.journal_bytes_read);
        let (journal_len, last_len) = {
            let cache = authority.verified_journal.lock().unwrap();
            let cache = cache.as_ref().unwrap();
            (cache.length, cache.length - cache.last_record_offset)
        };
        samples(false)?;
        let read = counter(&authority.counters.journal_bytes_read) - bytes;
        assert_eq!(
            read as u64,
            48 * last_len,
            "each warm observation re-reads only the final record"
        );
        assert!(last_len <= MAX_RECORD_BYTES as u64 && last_len * 10 < journal_len);
    }
    eprintln!(
        "CHANNEL_LATENCY group=issuer samples=48 cold_p50_us={} cold_p95_us={} warm_p50_us={} warm_p95_us={}",
        cold[24], cold[45], warm[24], warm[45]
    );
    let other = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    other.revoke("other-process-revoke", &grant.delegation_ref.id, "1", 300)?;
    let replays = counter(&authority.counters.full_replays);
    assert_eq!(
        authority
            .read(&grant.delegation_ref.id, 301)?
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
    assert_eq!(
        counter(&authority.counters.full_replays),
        replays,
        "an appended revocation is consumed as a tail, not a full replay"
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
    let path = parent
        .open_entry_handle(OsStr::new("issuer"))?
        .open_child_directory()?;
    let original = read_file(&path, JOURNAL_FILE, MAX_JOURNAL_BYTES)?;
    let rewrite = |bytes: &[u8]| -> Result<()> {
        use std::io::Write;
        let mut file = path.open_read_write_file(OsStr::new(JOURNAL_FILE), false)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    };
    // Same-size corruption of an earlier record with an unchanged head keeps
    // serving the previously verified state (which already holds the
    // revocation) and fails closed on the next cold load.
    let mut bytes = original.clone();
    bytes[0] = b'!';
    rewrite(&bytes)?;
    assert_eq!(
        authority
            .read(&grant.delegation_ref.id, 302)?
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    // Same-size corruption of the final record is detected on the warm path.
    rewrite(&original)?;
    authority.read(&grant.delegation_ref.id, 303)?;
    let mut bytes = original.clone();
    let last = bytes.len() - 3;
    bytes[last] ^= 1;
    rewrite(&bytes)?;
    assert!(authority.read(&grant.delegation_ref.id, 304).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    Ok(())
}

#[test]
fn effect_authorization_reads_one_current_journal_and_rejects_cross_instance_revoke() -> Result<()>
{
    let (_temp, parent, authority) = fixture();
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
    let last_len = {
        let cache = authority.verified_journal.lock().unwrap();
        let cache = cache.as_ref().unwrap();
        cache.length - cache.last_record_offset
    };
    let before = counter(&authority.counters.journal_bytes_read);
    checked()?;
    assert_eq!(
        (counter(&authority.counters.journal_bytes_read) - before) as u64,
        last_len
    );
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

#[test]
fn incremental_parse_falls_back_on_truncation_replacement_and_head_mismatch() -> Result<()> {
    let (temp, parent, authority) = fixture();
    let (first, _) = authority.issue("tail-one", &params(), &subject(), &policy(), 100)?;
    authority.issue("tail-two", &params(), &subject(), &policy(), 100)?;
    authority.read(&first.delegation_ref.id, 101)?;
    let journal = temp.path().join("issuer").join(JOURNAL_FILE);
    let head = temp.path().join("issuer").join(HEAD_FILE);
    let original = std::fs::read(&journal)?;
    let original_head = std::fs::read(&head)?;

    // Truncation to a shorter, still well-formed prefix: fall back, then the
    // committed head is missing and the read fails closed.
    let first_line = original.iter().position(|b| *b == b'\n').unwrap() + 1;
    std::fs::write(&journal, &original[..first_line])?;
    let replays = counter(&authority.counters.full_replays);
    assert!(authority.read(&first.delegation_ref.id, 102).is_err());
    assert_eq!(counter(&authority.counters.full_replays), replays + 1);

    // Restore; a partial appended tail is rejected (full parse fails closed).
    std::fs::write(&journal, &original)?;
    authority.read(&first.delegation_ref.id, 103)?;
    let mut partial = original.clone();
    partial.extend_from_slice(b"{\"sequence\":3");
    std::fs::write(&journal, &partial)?;
    assert!(authority.read(&first.delegation_ref.id, 104).is_err());

    // A head that names an unknown position with an unchanged length falls
    // back and fails closed.
    std::fs::write(&journal, &original)?;
    authority.read(&first.delegation_ref.id, 105)?;
    std::fs::write(
        &head,
        serde_json::to_vec(&Head {
            version: 1,
            sequence: 2,
            digest: "0".repeat(64),
        })?,
    )?;
    assert!(authority.read(&first.delegation_ref.id, 106).is_err());
    std::fs::write(&head, &original_head)?;
    authority.read(&first.delegation_ref.id, 107)?;

    // Replacing the journal file (new identity) is a storage change.
    std::fs::remove_file(&journal)?;
    std::fs::write(&journal, &original)?;
    assert!(authority.read(&first.delegation_ref.id, 108).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    Ok(())
}

/// Issue, revoke a delegation, a code grant and the identity, then compact.
fn compacted_history(
    authority: &NativeDelegationAuthority,
) -> Result<(
    IntegrationDelegationView,
    SignedDelegation,
    IntegrationDelegationView,
)> {
    let (revoked, _) = authority.issue("history-revoked", &params(), &subject(), &policy(), 100)?;
    let (active, proof) =
        authority.issue("history-active", &params(), &subject(), &policy(), 100)?;
    authority.revoke("history-revoke", &revoked.delegation_ref.id, "1", 101)?;
    Ok((active, proof, revoked))
}

fn status(authority: &NativeDelegationAuthority, id: &str) -> IntegrationDelegationStatus {
    authority.read(id, 200).unwrap().unwrap().status
}

#[test]
fn compaction_preserves_revocations_signatures_and_allows_unbounded_issuance() -> Result<()> {
    let (temp, parent, authority) = fixture();
    let (active, proof, revoked) = compacted_history(&authority)?;
    // Far more events than the per-file bound: automatic compaction keeps the
    // journal writable (previously DELEGATION_JOURNAL_FULL forever).
    for index in 0..(MAX_RECORDS * 3) {
        authority.issue(
            &format!("bulk-{index}"),
            &params(),
            &subject(),
            &policy(),
            100,
        )?;
    }
    assert!(counter(&authority.counters.compactions) >= 3);
    let checkpoint = temp.path().join("issuer").join(CHECKPOINT_FILE);
    assert!(checkpoint.exists());
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&checkpoint)?)?;
    let revocations = raw["body"]["revocations"].as_array().unwrap();
    assert_eq!(revocations.len(), 1);
    let original: serde_json::Value = serde_json::from_str(revocations[0].as_str().unwrap())?;
    assert_eq!(original["event"]["kind"], "revoked");
    assert_eq!(original["event"]["operation_id"], "history-revoke");
    assert_eq!(
        original["event"]["revoked_at_ms"], 101,
        "revocation kept verbatim"
    );
    let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(
        status(&reopened, &revoked.delegation_ref.id),
        IntegrationDelegationStatus::Revoked
    );
    assert_eq!(
        status(&reopened, &active.delegation_ref.id),
        IntegrationDelegationStatus::Active
    );
    reopened.authorize(
        &proof,
        &policy(),
        &subject(),
        IntegrationDelegationAction::ReadTask,
        &[resource()],
        200,
    )?;
    // Idempotent replays of compacted operations still resolve to the original.
    assert_eq!(
        reopened
            .issue("history-active", &params(), &subject(), &policy(), 300)?
            .1,
        proof
    );
    assert!(
        reopened
            .revoke("history-revoke", &active.delegation_ref.id, "1", 300)
            .is_err(),
        "a compacted operation id keeps its original intent"
    );
    // A forged proof still fails signature verification after compaction.
    let mut forged = proof.clone();
    forged.signature[0] ^= 1;
    assert!(
        reopened
            .authorize(
                &forged,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                200
            )
            .is_err()
    );
    // Identity revocation survives a later compaction as well.
    reopened.revoke_identity("history-identity", 300)?;
    reopened.compact()?;
    let again = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(
        status(&again, &active.delegation_ref.id),
        IntegrationDelegationStatus::Revoked
    );
    assert!(
        again
            .issue("after-identity", &params(), &subject(), &policy(), 300)
            .is_err()
    );
    Ok(())
}

#[test]
fn compaction_crash_at_each_step_loads_the_same_state() -> Result<()> {
    for step in [1u8, 2] {
        let (temp, parent, authority) = fixture();
        let (active, proof, revoked) = compacted_history(&authority)?;
        if step == 2 {
            // A previous completed compaction makes the stale prefix start
            // after an older base, not at sequence one.
            authority.compact()?;
            authority.issue("between", &params(), &subject(), &policy(), 100)?;
        }
        authority
            .counters
            .compaction_crash
            .store(step, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            authority.compact().unwrap_err().to_string(),
            "TEST_COMPACTION_CRASH"
        );
        drop(authority);
        let journal = temp.path().join("issuer").join(JOURNAL_FILE);
        assert!(std::fs::metadata(&journal)?.len() > 0, "not truncated");
        let check = |authority: &NativeDelegationAuthority| -> Result<()> {
            assert_eq!(
                status(authority, &revoked.delegation_ref.id),
                IntegrationDelegationStatus::Revoked
            );
            assert_eq!(
                status(authority, &active.delegation_ref.id),
                IntegrationDelegationStatus::Active
            );
            authority.authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                200,
            )?;
            Ok(())
        };
        let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
        check(&reopened)?;
        // Appending after the stale prefix and reloading still works.
        reopened.issue("after-crash", &params(), &subject(), &policy(), 100)?;
        let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
        check(&reopened)?;
        // Completing the compaction truncates the journal; state is unchanged.
        reopened.compact()?;
        assert_eq!(std::fs::metadata(&journal)?.len(), 0);
        let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
        check(&reopened)?;
        assert!(reopened.read_issue_operation("after-crash", 200)?.is_some());
    }
    Ok(())
}

#[test]
fn checkpoint_corruption_loss_and_temporary_files_are_handled_fail_closed() -> Result<()> {
    let (temp, parent, authority) = fixture();
    let (active, _, _) = compacted_history(&authority)?;
    authority.compact()?;
    let directory = temp.path().join("issuer");
    let checkpoint = directory.join(CHECKPOINT_FILE);
    let original = std::fs::read(&checkpoint)?;

    // An abandoned temporary checkpoint from an interrupted publish is ignored.
    let issuer = parent
        .open_entry_handle(OsStr::new("issuer"))?
        .open_child_directory()?;
    issuer.append(OsStr::new(".checkpoint.json.1.0.tmp"), b"{garbage")?;
    let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(
        status(&reopened, &active.delegation_ref.id),
        IntegrationDelegationStatus::Active
    );
    std::fs::remove_file(directory.join(".checkpoint.json.1.0.tmp"))?;

    // A modified (re-signed by nobody) checkpoint fails closed.
    let tampered =
        String::from_utf8(original.clone())?.replacen("\"revoked\":true", "\"revoked\":false", 1);
    assert_ne!(tampered.as_bytes(), original.as_slice());
    std::fs::write(&checkpoint, tampered)?;
    assert!(authority.read(&active.delegation_ref.id, 200).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());

    // Losing the checkpoint after truncation fails closed (history missing).
    std::fs::remove_file(&checkpoint)?;
    assert!(authority.read(&active.delegation_ref.id, 200).is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());

    // Restoring the original signed bytes (as a private file) loads again.
    issuer.atomic_replace(OsStr::new(CHECKPOINT_FILE), &original)?;
    let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(
        status(&reopened, &active.delegation_ref.id),
        IntegrationDelegationStatus::Active
    );
    Ok(())
}

#[test]
fn older_issuer_without_checkpoint_and_a_full_journal_load_and_become_writable() -> Result<()> {
    let (temp, parent, authority) = fixture();
    let (first, proof) = authority.issue("legacy-first", &params(), &subject(), &policy(), 100)?;
    // Fill the journal to the per-file bound through raw appends, as an older
    // binary (no compaction) would have left it.
    {
        let _writer = authority.lock(PrivateLeaseMode::Exclusive)?;
        while authority.read_journal()?.records < MAX_RECORDS {
            let journal = authority.read_journal()?;
            authority.append_for_test(
                &journal,
                Event::IdentityRevoked {
                    operation_id: format!("legacy-epoch-{}", journal.sequence),
                    intent: digest(b"identity_revoke"),
                    previous_epoch: journal.epoch.clone(),
                    next_epoch: Uuid::new_v4().to_string(),
                    revoked_at_ms: 100,
                },
            )?;
        }
    }
    assert!(!temp.path().join("issuer").join(CHECKPOINT_FILE).exists());
    let reopened = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(
        status(&reopened, &first.delegation_ref.id),
        IntegrationDelegationStatus::Revoked
    );
    // The next write compacts first instead of failing permanently.
    reopened.revoke_identity("legacy-after-full", 101)?;
    assert!(temp.path().join("issuer").join(CHECKPOINT_FILE).exists());
    let again = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert_eq!(again.read_journal()?.revocations.len(), MAX_RECORDS);
    assert!(
        again
            .authorize(
                &proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &[resource()],
                200
            )
            .is_err()
    );
    Ok(())
}

pub(super) fn scope() -> IntegrationScope {
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

pub(super) fn subject() -> AuthenticatedDelegationSubject {
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

pub(super) fn policy() -> AuthenticatedDelegationPolicy {
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

pub(super) fn params() -> IntegrationDelegationPrepareParams {
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
fn hardlinked_native_files_fail_closed() {
    let (temp, _, authority) = fixture();
    let path = temp.path().join("issuer").join(KEY_FILE);
    std::fs::hard_link(&path, temp.path().join("other-link")).unwrap();
    assert!(authority.read("missing", 100).is_err());
}

#[test]
fn binding_convergence_issuer_history_is_independent_of_directory_key_and_journal_inodes()
-> Result<()> {
    let (temp, parent, authority) = fixture();
    let (issued, _) = authority.issue("stable-issue", &params(), &subject(), &policy(), 100)?;
    let original_binding = read_file(&authority.directory, BINDING_FILE, MAX_RECORD_BYTES)?;
    let original_journal = read_file(&authority.directory, JOURNAL_FILE, MAX_JOURNAL_BYTES)?;
    drop(authority);
    std::fs::rename(
        temp.path().join("issuer"),
        temp.path().join("original-issuer"),
    )?;
    let restored = parent.create_private_child(OsStr::new("issuer"))?;
    for name in [BINDING_FILE, KEY_FILE, JOURNAL_FILE, HEAD_FILE] {
        restored.atomic_replace(
            OsStr::new(name),
            &std::fs::read(temp.path().join("original-issuer").join(name))?,
        )?;
    }
    // Keep the original actual writer lock; this test does not authorize
    // replacing it, rewriting genesis or minting another issuer/key.
    std::fs::rename(
        temp.path().join("original-issuer").join(LOCK_FILE),
        temp.path().join("issuer").join(LOCK_FILE),
    )?;
    let cold = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    assert!(cold.read(&issued.delegation_ref.id, 101)?.is_some());
    assert_eq!(
        read_file(&cold.directory, BINDING_FILE, MAX_RECORD_BYTES)?,
        original_binding
    );
    assert_eq!(
        read_file(&cold.directory, JOURNAL_FILE, MAX_JOURNAL_BYTES)?,
        original_journal
    );
    Ok(())
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
