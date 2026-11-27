use super::*;

fn entry(kind: TransferAttemptKind) -> TransferAttemptRecord {
    TransferAttemptRecord {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        kind,
        call_digest: "a".repeat(64),
        selection_digest: (kind == TransferAttemptKind::Run).then(|| "b".repeat(64)),
    }
}

#[test]
fn durable_acceptance_never_grants_the_same_attempt_execution_after_all_owners_die() {
    let f = Fixture::new();
    let attempt = entry(TransferAttemptKind::Run);
    let untouched = f
        .target
        .read_attempt(&f.request, f.source.authority(), Some(&attempt.attempt_id))
        .unwrap();
    assert!(!untouched.tracked && untouched.attempt.is_none() && !untouched.running);
    let guard = f
        .target
        .claim_attempt(&f.request, f.source.authority(), &attempt)
        .unwrap()
        .unwrap();
    guard.verify().unwrap();
    let observed = f
        .target
        .read_attempt(&f.request, f.source.authority(), Some(&attempt.attempt_id))
        .unwrap();
    assert!(observed.tracked && observed.running && observed.attempt.as_ref() == Some(&attempt));
    assert!(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &attempt)
            .unwrap()
            .is_none()
    );
    let newer = entry(TransferAttemptKind::Run);
    assert!(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &newer)
            .is_err()
    );
    drop(guard);
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    assert!(
        reopened
            .claim_attempt(&f.request, f.source.authority(), &attempt)
            .unwrap()
            .is_none()
    );
    assert!(
        !reopened
            .read_attempt(&f.request, f.source.authority(), Some(&attempt.attempt_id))
            .unwrap()
            .running
    );
    assert!(
        reopened
            .claim_attempt(&f.request, f.source.authority(), &newer)
            .unwrap()
            .is_some()
    );
}

#[test]
fn accepted_attempt_kind_call_and_operation_selection_are_immutable() {
    let f = Fixture::new();
    let attempt = entry(TransferAttemptKind::Run);
    drop(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &attempt)
            .unwrap()
            .unwrap(),
    );
    for field in ["kind", "call", "selection"] {
        let mut changed = attempt.clone();
        match field {
            "kind" => {
                changed.kind = TransferAttemptKind::Finish;
                changed.selection_digest = None;
            }
            "call" => changed.call_digest = "c".repeat(64),
            _ => changed.selection_digest = Some("d".repeat(64)),
        }
        assert!(
            f.target
                .claim_attempt(&f.request, f.source.authority(), &changed)
                .is_err()
        );
    }
    let mut newer = entry(TransferAttemptKind::Run);
    newer.selection_digest = Some("e".repeat(64));
    assert!(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &newer)
            .is_err()
    );
    let finish = entry(TransferAttemptKind::Finish);
    assert!(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &finish)
            .unwrap()
            .is_some()
    );
}

#[test]
fn attempt_birth_or_lock_loss_remains_unknown_without_repair_and_another_target_cannot_adopt_it() {
    let f = Fixture::new();
    let attempt = entry(TransferAttemptKind::Run);
    let guard = f
        .target
        .claim_attempt(&f.request, f.source.authority(), &attempt)
        .unwrap()
        .unwrap();
    let directory = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(format!("{}.admission", f.request));
    let lock = directory.join("attempt.lock");
    let moved = f._root.path().join("held-lock");
    std::fs::rename(&lock, &moved).unwrap();
    assert!(guard.verify().is_err());
    assert!(
        f.target
            .read_attempt(&f.request, f.source.authority(), Some(&attempt.attempt_id))
            .is_err()
    );
    assert!(
        f.target
            .claim_attempt(
                &f.request,
                f.source.authority(),
                &entry(TransferAttemptKind::Run)
            )
            .is_err()
    );
    assert!(!lock.exists());
    drop(guard);
    std::fs::rename(&moved, &lock).unwrap();
    std::fs::remove_file(directory.join("attempts.json")).unwrap();
    assert!(
        f.target
            .read_attempt(&f.request, f.source.authority(), None)
            .is_err()
    );
    assert!(
        f.target
            .claim_attempt(&f.request, f.source.authority(), &attempt)
            .is_err()
    );
    assert!(!directory.join("attempts.json").exists());
    let other = IncomingTransfers::open(&f._root.path().join("other-profile")).unwrap();
    assert!(
        other
            .read_attempt(&f.request, f.source.authority(), None)
            .is_err()
    );
}

#[test]
fn the_attempt_ledger_has_a_fixed_count_budget_and_does_not_store_selection_content() {
    let f = Fixture::new();
    for _ in 0..256 {
        drop(
            f.target
                .claim_attempt(
                    &f.request,
                    f.source.authority(),
                    &entry(TransferAttemptKind::Finish),
                )
                .unwrap()
                .unwrap(),
        );
    }
    assert!(
        f.target
            .claim_attempt(
                &f.request,
                f.source.authority(),
                &entry(TransferAttemptKind::Finish)
            )
            .is_err()
    );
    let bytes = std::fs::read(
        f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(format!("{}.admission/attempts.json", f.request)),
    )
    .unwrap();
    assert!(bytes.len() < 128 * 1024);
    assert!(!String::from_utf8(bytes).unwrap().contains("settings.json"));
}
