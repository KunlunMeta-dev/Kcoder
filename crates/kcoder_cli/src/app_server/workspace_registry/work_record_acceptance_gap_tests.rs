//! A stored Work binding is only a claim, even beside a real live input and lease.
use super::*;
use kcoder_state::continuous_work::{
    ContinuousWorkStore, InitialAdmission, NativeInitialWorkAdmission, NativeInitialWorkCapacity,
    NativeInitialWorkReceipt, NativeInitialWorkRequest, StoredBindingLookup, WorkInputSource,
    observe_stored_work_binding,
};
use kcoder_state::turn_attempt_store::{
    TurnAttemptBeginOutcome, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_state::{AppState, UserInputCommit, UserInputStart};
use kcoder_types::continuous_work::{WorkRecord, WorkScope};
use kcoder_types::{Message, TurnAttemptIdentity, TurnAttemptStatus};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn private_test_root() -> anyhow::Result<tempfile::TempDir> {
    #[cfg(unix)]
    let root = {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()?
    };
    #[cfg(not(unix))]
    let root = tempfile::tempdir()?;
    kcoder_config::PrivateDirectory::open_existing(root.path())?.verify_private_directory()?;
    Ok(root)
}

fn work(scope: &WorkScope, attempt: &TurnAttemptIdentity, id: &str) -> WorkRecord {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": id},
        "origin": {"kind": "foreground", "initialAttempt": attempt},
        "linkedThreadIds": [&attempt.thread_id],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
            "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
            "appliedInputSequence": 0}
    }))
    .unwrap()
}

fn snapshot(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, (String, Vec<u8>)>> {
    fn visit(
        root: &Path,
        path: &Path,
        output: &mut BTreeMap<PathBuf, (String, Vec<u8>)>,
    ) -> anyhow::Result<()> {
        let relative = path.strip_prefix(root)?.to_owned();
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(!metadata.file_type().is_symlink());
        if metadata.is_dir() {
            let directory = kcoder_config::PrivateDirectory::open_existing(path)?;
            output.insert(relative, (directory.directory_identity()?, Vec::new()));
            for child in std::fs::read_dir(path)? {
                visit(root, &child?.path(), output)?;
            }
        } else {
            anyhow::ensure!(metadata.is_file());
            let file = std::fs::File::open(path)?;
            let identity = format!(
                "{:?}",
                kcoder_config::PortableLeaseIdentity::from_regular_handle(&file)?
            );
            output.insert(
                relative,
                (identity, Sha256::digest(std::fs::read(path)?).to_vec()),
            );
        }
        Ok(())
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output)?;
    Ok(output)
}

// Test-only composition: real host lookup and account authorization are not
// established here. Run on an owned blocking worker in any future host path.
fn observe_with_original_lease(
    state: &AppState,
    history: &Path,
    lease: &DeferredSessionLeaseWitness,
    receipt: &NativeInitialWorkReceipt,
) -> Option<WorkRecord> {
    if state.history_path().as_deref() != Some(history) {
        return None;
    }
    lease.verify_target(history).ok()?;
    let initial = receipt.observe_original(state)?;
    lease.verify_target(history).ok()?;
    if state.history_path().as_deref() != Some(history) {
        return None;
    }
    Some(initial)
}

#[tokio::test(flavor = "current_thread")]
async fn native_initial_observation_requires_the_original_live_session_lease() -> anyhow::Result<()>
{
    let root = private_test_root()?;
    let profile = root.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&profile)?;
    let state = AppState::new(root.path());
    let thread = state.session_id();
    let history = root.path().join(format!("{thread}.jsonl"));
    kcoder_config::PrivateDirectory::open_existing(root.path())?
        .open_read_write_file(history.file_name().unwrap(), true)?;
    state.with_history_path(&history);
    let lease = SessionLease::acquire(&history)?;
    let lease_witness = lease
        .deferred_witness(&history)
        .expect("original lease witness");
    let attempt = TurnAttemptIdentity {
        thread_id: thread.clone(),
        turn_id: "owned-turn".into(),
        attempt_id: "owned-attempt".into(),
    };
    let owner = state.inspection_lifecycle_identity();
    let original = Message::user_text("the original accepted user input");
    let committed = state
        .history_attempt_scope(attempt.clone())?
        .run(async {
            match state.try_begin_user_input(&owner, original.clone()) {
                UserInputStart::Accepted(pending) => pending.wait_with_witness().await,
                _ => anyhow::bail!("original input was not accepted"),
            }
        })
        .await?;
    let scope = WorkScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: "workspace".into(),
    };
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "target".into(),
        conversation_id: thread.clone(),
    };
    let store = ContinuousWorkStore::open_or_create(&profile)?;
    let capacity = NativeInitialWorkCapacity::new(1);
    let native_owner = match store.admit_initial_from_native(NativeInitialWorkRequest {
        state: &state,
        scope: &scope,
        work: work(&scope, &attempt, "owned"),
        source: &source,
        request_id: "owned",
        committed,
        original_accepted: &original,
        accepted_deliveries: vec![],
        capacity: &capacity,
    }) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("original admission did not return native ownership"),
    };
    let receipt = native_owner.observer();
    let initial = observe_with_original_lease(&state, &history, &lease_witness, &receipt)
        .expect("same live state and lease");
    assert_eq!(initial.identity.work_id, "owned");
    let other = AppState::new(root.path());
    other.with_deferred_history_path(&history);
    assert!(observe_with_original_lease(&other, &history, &lease_witness, &receipt).is_none());
    drop(lease);
    assert!(
        receipt.observe_original(&state).is_some(),
        "State-only receipt is not a lease"
    );
    assert!(observe_with_original_lease(&state, &history, &lease_witness, &receipt).is_none());
    let replacement = SessionLease::acquire(&history)?;
    assert!(observe_with_original_lease(&state, &history, &lease_witness, &receipt).is_none());
    drop(replacement);
    drop(native_owner);
    assert!(receipt.observe_original(&state).is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn live_accepted_input_and_lease_cannot_authenticate_a_copied_work_claim()
-> anyhow::Result<()> {
    let root = private_test_root()?;
    let profile = root.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&profile)?;
    let state = AppState::new(root.path());
    let thread = state.session_id();
    let history = root.path().join(format!("{thread}.jsonl"));
    kcoder_config::PrivateDirectory::open_existing(root.path())?
        .open_read_write_file(history.file_name().unwrap(), true)?;
    state.with_history_path(&history);
    let lease = SessionLease::acquire(&history)?;
    let lease_witness = lease
        .deferred_witness(&history)
        .expect("original lease witness");

    let attempt = TurnAttemptIdentity {
        thread_id: thread.clone(),
        turn_id: "owned-turn".into(),
        attempt_id: "owned-attempt".into(),
    };
    let attempts = TurnAttemptStore::open(&root.path().join(&thread), &thread)?;
    let record = TurnAttemptRecord {
        client_presentation: None,
        version: 1,
        identity: attempt.clone(),
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    };
    assert!(matches!(
        attempts.begin(record.clone())?,
        TurnAttemptBeginOutcome::Created(_)
    ));
    let original = Message::user_text("the original accepted user input");
    let owner = state.inspection_lifecycle_identity();
    let committed = state
        .history_attempt_scope(attempt.clone())?
        .run(async {
            match state.try_begin_user_input(&owner, original.clone()) {
                UserInputStart::Accepted(pending) => pending.wait_with_witness().await,
                _ => anyhow::bail!("original input was not accepted"),
            }
        })
        .await?;
    assert_eq!(committed.outcome(), UserInputCommit::Durable);
    assert_eq!(committed.attempt(), Some(&attempt));
    assert!(committed.try_is_current()?);
    assert_eq!(attempts.load(&attempt)?, Some(record));
    lease_witness.verify_target(&history)?;
    let mut row = committed
        .try_take_native_row_receipt()?
        .expect("original row receipt");
    row.verify_entry(&thread, committed.uuid(), Some(&attempt), &original, 4096)?;
    assert!(
        row.verify_entry(
            &thread,
            committed.uuid(),
            Some(&attempt),
            &Message::user_text("another input"),
            4096
        )
        .is_err()
    );

    let scope = WorkScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: "workspace".into(),
    };
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "target".into(),
        conversation_id: thread.clone(),
    };
    let store = ContinuousWorkStore::open_or_create(&profile)?;
    for (id, text) in [
        ("forged-different", "another input"),
        ("forged-identical", "the original accepted user input"),
    ] {
        let admission = store.admit(
            &scope,
            work(&scope, &attempt, id),
            &source,
            id,
            json!({"text":text}),
            vec![],
        )?;
        assert!(matches!(admission, InitialAdmission::Accepted(_)));
    }
    let before = snapshot(&profile)?;
    for id in ["forged-different", "forged-identical"] {
        assert_eq!(
            store.read_work(&scope, id)?.unwrap().origin.initial_attempt,
            attempt
        );
        assert_eq!(
            observe_stored_work_binding(&profile, &scope, id, &thread),
            StoredBindingLookup::Observed
        );
    }
    assert_eq!(
        snapshot(&profile)?,
        before,
        "observation must not write the Work profile"
    );
    assert!(committed.try_is_current()?);
    lease_witness.verify_target(&history)?;

    drop(lease);
    assert!(lease_witness.verify_target(&history).is_err());
    let replacement = SessionLease::acquire(&history)?;
    assert!(lease_witness.verify_target(&history).is_err());
    assert!(committed.try_is_current()?);
    assert_eq!(
        observe_stored_work_binding(&profile, &scope, "forged-identical", &thread),
        StoredBindingLookup::Observed
    );
    drop(replacement);
    Ok(())
}
