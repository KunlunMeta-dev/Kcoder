use super::*;
use crate::UserInputStart;
use crate::continuous_work::StoredBindingLookup;
use kcoder_types::TurnAttemptIdentity;
use std::{ffi::OsStr, time::Duration};

struct Fixture {
    root: tempfile::TempDir,
    state: AppState,
    store: ContinuousWorkStore,
    scope: WorkScope,
    source: WorkInputSource,
    attempt: TurnAttemptIdentity,
    input: CommittedUserInput,
    original: Message,
    capacity: NativeInitialWorkCapacity,
}

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

impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        Self::with_text("the original user input").await
    }

    async fn with_text(text: &str) -> anyhow::Result<Self> {
        let root = private_test_root()?;
        let history = root.path().join("original.jsonl");
        kcoder_config::PrivateDirectory::open_existing(root.path())?
            .open_read_write_file(OsStr::new("original.jsonl"), true)?;
        let state = AppState::new(root.path());
        state.with_history_path(&history);
        let thread = state.session_id();
        let attempt = TurnAttemptIdentity {
            thread_id: thread.clone(),
            turn_id: "owned-turn".into(),
            attempt_id: "owned-attempt".into(),
        };
        let owner = state.inspection_lifecycle_identity();
        let original = Message::user_text(text);
        let input = state
            .history_attempt_scope(attempt.clone())?
            .run(async {
                match state.try_begin_user_input(&owner, original.clone()) {
                    UserInputStart::Accepted(pending) => pending.wait_with_witness().await,
                    _ => anyhow::bail!("input was not accepted"),
                }
            })
            .await?;
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile)?;
        let store = ContinuousWorkStore::open_or_create(&profile)?;
        Ok(Self {
            root,
            state,
            store,
            scope: WorkScope {
                account_id: "account".into(),
                target_id: "target".into(),
                workspace_id: "workspace".into(),
            },
            source: WorkInputSource {
                kind: "foreground".into(),
                instance_id: "target".into(),
                conversation_id: thread,
            },
            attempt,
            input,
            original,
            capacity: NativeInitialWorkCapacity::new(1),
        })
    }

    fn work(&self, id: &str) -> WorkRecord {
        serde_json::from_value(serde_json::json!({
            "schemaVersion":1,
            "identity":{"scope":self.scope,"workId":id},
            "origin":{"kind":"foreground","initialAttempt":self.attempt},
            "linkedThreadIds":[self.attempt.thread_id],"phase":"pending",
            "revision":{"revision":1,"requirementsRevision":1,"controlEpoch":0,
                "ownerEpoch":0,"acceptedInputSequence":1,"requiredInputSequence":1,
                "appliedInputSequence":0}
        }))
        .unwrap()
    }

    fn request<'a>(&'a self, id: &'a str) -> NativeInitialWorkRequest<'a> {
        NativeInitialWorkRequest {
            state: &self.state,
            scope: &self.scope,
            work: self.work(id),
            source: &self.source,
            request_id: id,
            committed: self.input.clone(),
            original_accepted: &self.original,
            accepted_deliveries: vec![],
            capacity: &self.capacity,
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn long_plain_text_within_existing_store_limit_is_supported() -> anyhow::Result<()> {
    let input = "x".repeat(1_100_000);
    let f = Fixture::with_text(&input).await?;
    let owner = match f.store.admit_initial_from_native(f.request("large")) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("valid large text was not accepted"),
    };
    assert!(owner.observer().observe_original(&f.state).is_some());
    let (_, payload) = f
        .store
        .read_input(&f.scope, "large", &f.source, "large")?
        .unwrap();
    assert_eq!(payload["text"].as_str(), Some(input.as_str()));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn initial_receipt_is_original_and_consumes_shared_input_once() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let owner = match f.store.admit_initial_from_native(f.request("first")) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("original admission did not produce a receipt"),
    };
    let receipt = owner.observer();
    let original_work = receipt.observe_original(&f.state).unwrap();
    assert_eq!(original_work.identity.work_id, "first");
    assert_eq!(original_work.origin.initial_attempt, f.attempt);
    let observed = f
        .store
        .read_input(&f.scope, "first", &f.source, "first")?
        .unwrap();
    assert_eq!(
        observed.1,
        serde_json::json!({"text":"the original user input"})
    );
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("second")),
        NativeInitialWorkAdmission::Unknown
    ));
    assert!(f.store.read_work(&f.scope, "second")?.is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn foreign_state_hook_change_and_attempt_change_cannot_create_work() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let profile = f.root.path().join("profile");
    let before = std::fs::read(profile.join("continuous-work.v1/state.json"))?;
    let other = AppState::new(f.root.path());
    let mut request = f.request("wrong");
    request.state = &other;
    assert!(matches!(
        f.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::Unavailable
    ));
    let changed = Message::user_text("changed before the hook");
    let mut request = f.request("wrong");
    request.original_accepted = &changed;
    assert!(matches!(
        f.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::Unavailable
    ));
    let mut request = f.request("wrong");
    request.work.origin.initial_attempt.attempt_id = "another-attempt".into();
    assert!(matches!(
        f.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::Unavailable
    ));
    assert_eq!(
        std::fs::read(profile.join("continuous-work.v1/state.json"))?,
        before
    );
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("right")),
        NativeInitialWorkAdmission::Accepted(_)
    ));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn existing_receipt_cannot_mint_original_native_evidence() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    assert!(matches!(
        f.store.admit(
            &f.scope,
            f.work("old"),
            &f.source,
            "old",
            serde_json::json!({"text":"the original user input"}),
            vec![]
        )?,
        InitialAdmission::Accepted(_)
    ));
    let path = f.root.path().join("profile/continuous-work.v1/state.json");
    let before = std::fs::read(&path)?;
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("old")),
        NativeInitialWorkAdmission::Unknown
    ));
    assert_eq!(std::fs::read(path)?, before);
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("new")),
        NativeInitialWorkAdmission::Unknown
    ));
    assert!(f.store.read_work(&f.scope, "new")?.is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn lost_result_after_commit_is_unknown_and_never_replayed() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    publication_intent::fail_after_native_commit_for_test();
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("original")),
        NativeInitialWorkAdmission::Unknown
    ));
    assert!(f.store.read_work(&f.scope, "original")?.is_some());
    let path = f.root.path().join("profile/continuous-work.v1/state.json");
    let before = std::fs::read(&path)?;
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("original")),
        NativeInitialWorkAdmission::Unknown
    ));
    assert_eq!(std::fs::read(path)?, before);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn original_source_change_during_publication_is_unknown() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let result = std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            publication_intent::pause_after_native_intent_for_test(ready_tx, resume_rx);
            f.store.admit_initial_from_native(f.request("racing"))
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        f.state
            .with_deferred_history_path(f.root.path().join("different.jsonl"));
        resume_tx.send(()).unwrap();
        worker.join().unwrap()
    });
    assert!(matches!(result, NativeInitialWorkAdmission::Unknown));
    assert!(f.store.read_work(&f.scope, "racing")?.is_some());
    assert_eq!(
        crate::continuous_work::observe_stored_work_binding(
            &f.root.path().join("profile"),
            &f.scope,
            "racing",
            &f.attempt.thread_id
        ),
        StoredBindingLookup::Observed
    );
    assert!(matches!(
        f.store.admit_initial_from_native(f.request("retry")),
        NativeInitialWorkAdmission::Unavailable
    ));
    assert!(f.store.read_work(&f.scope, "retry")?.is_none());
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn same_bytes_at_a_replaced_payload_name_are_not_original() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let owner = match f.store.admit_initial_from_native(f.request("replace")) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("expected original receipt"),
    };
    let receipt = owner.observer();
    let stored = f
        .store
        .read_input(&f.scope, "replace", &f.source, "replace")?
        .unwrap()
        .0;
    let directory = f.root.path().join("profile/continuous-work.v1");
    let target = directory.join(stored.payload_ref);
    let original = std::fs::read(&target)?;
    std::fs::rename(&target, directory.join("held-original"))?;
    kcoder_config::PrivateDirectory::open_existing(&directory)?
        .atomic_replace(target.file_name().unwrap(), &original)?;
    assert!(receipt.observe_original(&f.state).is_none());
    Ok(())
}

#[test]
fn host_configured_capacity_is_returned_on_drop() {
    let capacity = NativeInitialWorkCapacity::new(1);
    let permit = capacity.try_acquire().unwrap();
    assert!(capacity.try_acquire().is_none());
    drop(permit);
    assert!(capacity.try_acquire().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn full_capacity_keeps_the_work_commit_without_minting_evidence() -> anyhow::Result<()> {
    let first = Fixture::new().await?;
    let second = Fixture::new().await?;
    let third = Fixture::new().await?;
    let capacity = NativeInitialWorkCapacity::new(1);
    let mut request = first.request("first");
    request.capacity = &capacity;
    let owner = match first.store.admit_initial_from_native(request) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("expected a native owner"),
    };
    let receipt = owner.observer();
    assert!(receipt.observe_original(&first.state).is_some());
    let mut request = second.request("second");
    request.capacity = &capacity;
    assert!(matches!(
        second.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::WithoutWitness
    ));
    assert!(second.store.read_work(&second.scope, "second")?.is_some());
    let mut request = second.request("second");
    request.capacity = &capacity;
    assert!(matches!(
        second.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::Unknown
    ));
    drop(owner);
    assert!(receipt.observe_original(&first.state).is_none());
    let mut request = third.request("third");
    request.capacity = &capacity;
    assert!(matches!(
        third.store.admit_initial_from_native(request),
        NativeInitialWorkAdmission::Accepted(_)
    ));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn owner_drop_invalidates_weak_observer_even_if_input_remains() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let owner = match f.store.admit_initial_from_native(f.request("weak")) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("expected a native owner"),
    };
    let observer = owner.observer();
    assert!(observer.observe_original(&f.state).is_some());
    drop(owner);
    assert!(f.input.try_is_current()?);
    assert!(observer.observe_original(&f.state).is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn owner_drop_during_observation_returns_unknown() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let owner = match f.store.admit_initial_from_native(f.request("race")) {
        NativeInitialWorkAdmission::Accepted(owner) => owner,
        _ => anyhow::bail!("expected a native owner"),
    };
    let observer = owner.observer();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let result = std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            PAUSE_BEFORE_OBSERVATION_RESULT.with(|hook| {
                *hook.borrow_mut() = Some((ready_tx, resume_rx));
            });
            observer.observe_original(&f.state)
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(owner);
        assert!(
            f.capacity.try_acquire().is_none(),
            "in-flight observer must retain capacity"
        );
        resume_tx.send(()).unwrap();
        worker.join().unwrap()
    });
    assert!(result.is_none());
    assert!(f.capacity.try_acquire().is_some());
    Ok(())
}
