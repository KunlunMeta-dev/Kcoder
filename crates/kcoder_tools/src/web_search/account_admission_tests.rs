use super::*;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
};

fn context(settings: Option<PathBuf>) -> ToolContext {
    ToolContext::new(AppState::new(".")).with_settings_persistence_path(settings)
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
fn held_slots(directory: &PrivateDirectory, kind: &str, count: usize) -> usize {
    (0..count)
        .filter(|index| {
            directory
                .try_exclusive_lock(OsStr::new(&format!("{kind}-{index}.lock")))
                .unwrap()
                .is_none()
        })
        .count()
}
async fn until(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            Instant::now() < until,
            "owned admission fixture did not settle"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn missing_native_profile_does_not_guess_storage_and_pre_cancel_never_creates_it() {
    let cancel = CancellationToken::new();
    assert!(
        acquire(&context(None), &cancel, deadline())
            .await
            .unwrap()
            .is_none()
    );
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("new-profile/settings.json");
    cancel.cancel();
    let result = acquire(&context(Some(settings.clone())), &cancel, deadline()).await;
    assert!(
        matches!(result, Err(error) if error.kind == WebSearchErrorKind::Cancelled && !error.request_sent)
    );
    assert!(!settings.parent().unwrap().exists());
}
#[test]
fn sessions_rotate_without_losing_another_sessions_ticket_on_cancel() {
    let a = AppState::new(".");
    let b = AppState::new(".");
    let mut queue = FairQueue::default();
    let a1 = queue.register(&a).unwrap();
    let a2 = queue.register(&a).unwrap();
    let b1 = queue.register(&b).unwrap();
    let b2 = queue.register(&b).unwrap();
    assert!(queue.is_front(a1));
    queue.remove(a1, true);
    assert!(queue.is_front(b1));
    queue.remove(b2, false);
    assert!(queue.is_front(b1));
    queue.remove(b1, true);
    assert!(queue.is_front(a2));
}
#[tokio::test]
async fn cancellation_releases_only_its_queue_lease_and_keeps_active_peers() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("profile/settings.json");
    let ctx = Arc::new(context(Some(settings.clone())));
    let mut active = Vec::new();
    for _ in 0..ACTIVE_LIMIT {
        active.push(
            acquire(&ctx, &CancellationToken::new(), deadline())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let dir = directory(&settings).unwrap();
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let ctx = ctx.clone();
        let cancel = cancel.clone();
        async move { acquire(&ctx, &cancel, deadline()).await }
    });
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 1).await;
    cancel.cancel();
    assert!(
        matches!(task.await.unwrap(), Err(error) if error.kind == WebSearchErrorKind::Cancelled)
    );
    assert_eq!(held_slots(&dir, "queued", QUEUED_LIMIT), 0);
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), ACTIVE_LIMIT);
    drop(active.pop());
    let replacement = acquire(&ctx, &CancellationToken::new(), deadline())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), ACTIVE_LIMIT);
    drop(replacement);
}
#[tokio::test]
async fn native_profiles_are_isolated_and_admission_never_writes_settings() {
    let root = tempfile::tempdir().unwrap();
    let path_a = root.path().join("settings-a.json");
    let path_b = root.path().join("settings-b.json");
    let a = context(Some(path_a.clone()));
    let b = context(Some(path_b.clone()));
    let mut active = Vec::new();
    for _ in 0..ACTIVE_LIMIT {
        active.push(
            acquire(&a, &CancellationToken::new(), deadline())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let other = acquire(&b, &CancellationToken::new(), deadline())
        .await
        .unwrap()
        .unwrap();
    let saturated = acquire(
        &a,
        &CancellationToken::new(),
        Instant::now() + Duration::from_millis(30),
    )
    .await;
    assert!(
        matches!(saturated, Err(error) if error.kind == WebSearchErrorKind::Timeout && !error.request_sent)
    );
    assert_eq!(
        held_slots(&directory(&path_a).unwrap(), "active", ACTIVE_LIMIT),
        ACTIVE_LIMIT
    );
    assert_eq!(
        held_slots(&directory(&path_b).unwrap(), "active", ACTIVE_LIMIT),
        1
    );
    assert!(!path_a.exists());
    assert!(!path_b.exists());
    drop(other);
    assert_eq!(
        held_slots(&directory(&path_a).unwrap(), "active", ACTIVE_LIMIT),
        ACTIVE_LIMIT
    );
}

#[tokio::test]
async fn searches_and_pages_have_four_active_each_and_share_32_waiting_slots() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    let ctx = Arc::new(context(Some(settings.clone())));
    let cancel = CancellationToken::new();
    let mut active = Vec::new();
    for kind in [RequestKind::Search, RequestKind::Page] {
        for _ in 0..ACTIVE_LIMIT {
            active.push(acquire_kind(&ctx, &cancel, deadline(), kind).await.unwrap());
        }
    }
    let dir = directory(&settings).unwrap();
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), 4);
    assert_eq!(held_slots(&dir, "page-active", ACTIVE_LIMIT), 4);
    let mut pending = Vec::new();
    for index in 0..QUEUED_LIMIT {
        let ctx = ctx.clone();
        let cancel = cancel.clone();
        pending.push(tokio::spawn(async move {
            acquire_kind(
                &ctx,
                &cancel,
                deadline(),
                if index % 2 == 0 {
                    RequestKind::Search
                } else {
                    RequestKind::Page
                },
            )
            .await
        }));
    }
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == QUEUED_LIMIT).await;
    for kind in [RequestKind::Search, RequestKind::Page] {
        assert!(matches!(
            acquire_kind(&ctx, &CancellationToken::new(), deadline(), kind).await,
            Err(error) if error.kind == WebSearchErrorKind::RateLimited && !error.request_sent
        ));
    }
    cancel.cancel();
    for task in pending {
        assert!(
            matches!(task.await.unwrap(), Err(error) if error.kind == WebSearchErrorKind::Cancelled)
        );
    }
    assert_eq!(held_slots(&dir, "queued", QUEUED_LIMIT), 0);
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), 4);
    assert_eq!(held_slots(&dir, "page-active", ACTIVE_LIMIT), 4);
    drop(active);
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), 0);
    assert_eq!(held_slots(&dir, "page-active", ACTIVE_LIMIT), 0);
}

#[tokio::test]
async fn a_full_search_wait_queue_does_not_block_ready_page_capacity() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    let ctx = Arc::new(context(Some(settings.clone())));
    let cancel = CancellationToken::new();
    let mut active = Vec::new();
    for _ in 0..ACTIVE_LIMIT {
        active.push(acquire(&ctx, &cancel, deadline()).await.unwrap());
    }
    let mut pending = Vec::new();
    for _ in 0..QUEUED_LIMIT {
        let ctx = ctx.clone();
        let cancel = cancel.clone();
        pending.push(tokio::spawn(async move {
            acquire(&ctx, &cancel, deadline()).await
        }));
    }
    let dir = directory(&settings).unwrap();
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == QUEUED_LIMIT).await;
    let page = acquire_kind(
        &ctx,
        &CancellationToken::new(),
        deadline(),
        RequestKind::Page,
    )
    .await
    .unwrap();
    assert_eq!(held_slots(&dir, "page-active", ACTIVE_LIMIT), 1);
    cancel.cancel();
    for task in pending {
        let _ = task.await;
    }
    drop(page);
}

#[tokio::test]
async fn actual_admission_rotates_queued_sessions_when_capacity_returns() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    let base = context(Some(settings.clone()));
    let a = Arc::new(context(Some(settings.clone())));
    let b = Arc::new(context(Some(settings.clone())));
    let mut active = Vec::new();
    for _ in 0..ACTIVE_LIMIT {
        active.push(
            acquire(&base, &CancellationToken::new(), deadline())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let dir = directory(&settings).unwrap();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let launch = |name: &'static str, ctx: Arc<ToolContext>| {
        let events = events.clone();
        let (release, released) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let permit = acquire(&ctx, &CancellationToken::new(), deadline())
                .await
                .unwrap()
                .unwrap();
            events.send(name).unwrap();
            released.await.unwrap();
            drop(permit);
        });
        (release, task)
    };
    let (a1, a1_task) = launch("a1", a.clone());
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 1).await;
    let (a2, a2_task) = launch("a2", a);
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 2).await;
    let (b1, b1_task) = launch("b1", b.clone());
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 3).await;
    let (b2, b2_task) = launch("b2", b);
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 4).await;
    drop(active.pop());
    for (expected, release) in [("a1", a1), ("b1", b1), ("a2", a2), ("b2", b2)] {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), received.recv())
                .await
                .unwrap(),
            Some(expected)
        );
        release.send(()).unwrap();
    }
    for task in [a1_task, a2_task, b1_task, b2_task] {
        task.await.unwrap();
    }
    assert_eq!(held_slots(&dir, "queued", QUEUED_LIMIT), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn unsafe_profile_or_lock_aliases_fail_closed_without_touching_other_files() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let alias = root.path().join("alias");
    symlink(&real, &alias).unwrap();
    assert!(
        matches!(acquire(&context(Some(alias.join("settings.json"))), &CancellationToken::new(), deadline()).await, Err(error) if error.kind == WebSearchErrorKind::PolicyDenied)
    );
    let settings = real.join("settings.json");
    let _dir = directory(&settings).unwrap();
    let hash = format!(
        "{:x}",
        Sha256::digest(OsStr::new("settings.json").as_encoded_bytes())
    );
    let slot_path = real
        .join("web-search-admission-v1")
        .join(hash)
        .join("queued-0.lock");
    let foreign = root.path().join("untouched");
    std::fs::write(&foreign, "retained").unwrap();
    symlink(&foreign, &slot_path).unwrap();
    assert!(
        acquire(
            &context(Some(settings.clone())),
            &CancellationToken::new(),
            deadline()
        )
        .await
        .is_err()
    );
    std::fs::remove_file(&slot_path).unwrap();
    std::fs::hard_link(&foreign, &slot_path).unwrap();
    assert!(
        acquire(
            &context(Some(settings)),
            &CancellationToken::new(),
            deadline()
        )
        .await
        .is_err()
    );
    assert_eq!(std::fs::read_to_string(&foreign).unwrap(), "retained");
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn child(settings: &Path, marker: &Path, queued: bool) -> OwnedChild {
    OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "web_search::account_admission::tests::admission_child_process",
                "--nocapture",
            ])
            .env("KCODER_TEST_ADMISSION_SETTINGS", settings)
            .env("KCODER_TEST_ADMISSION_MARKER", marker)
            .env(
                "KCODER_TEST_ADMISSION_QUEUED",
                if queued { "1" } else { "0" },
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}
#[tokio::test]
async fn admission_child_process() {
    let Some(settings) = std::env::var_os("KCODER_TEST_ADMISSION_SETTINGS") else {
        return;
    };
    let marker = PathBuf::from(std::env::var_os("KCODER_TEST_ADMISSION_MARKER").unwrap());
    let settings = PathBuf::from(settings);
    let ctx = Arc::new(context(Some(settings.clone())));
    let cancel = CancellationToken::new();
    let mut waiting = Vec::new();
    let _active;
    if std::env::var_os("KCODER_TEST_ADMISSION_QUEUED").as_deref() == Some(OsStr::new("1")) {
        for _ in 0..QUEUED_LIMIT {
            let ctx = ctx.clone();
            let cancel = cancel.clone();
            waiting.push(tokio::spawn(async move {
                acquire(&ctx, &cancel, deadline()).await
            }));
        }
        let dir = directory(&settings).unwrap();
        until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == QUEUED_LIMIT).await;
        _active = None;
    } else {
        _active = acquire(&ctx, &cancel, deadline()).await.unwrap();
    }
    std::fs::write(&marker, b"ready").unwrap();
    // The parent owns this process. Strong termination must release its OS leases.
    let stop = marker.with_extension("stop");
    let stop_at = Instant::now() + Duration::from_secs(30);
    while !stop.exists() && Instant::now() < stop_at {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancel.cancel();
    for task in waiting {
        let _ = task.await;
    }
}
#[tokio::test]
async fn actual_processes_enforce_four_active_and_32_queued_and_kill_preserves_peers() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("profile/settings.json");
    let mut peers = Vec::new();
    for index in 0..ACTIVE_LIMIT {
        let marker = root.path().join(format!("active-{index}.ready"));
        peers.push(child(&settings, &marker, false));
        until(|| marker.exists()).await;
    }
    let dir = directory(&settings).unwrap();
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), ACTIVE_LIMIT);
    let marker = root.path().join("queued.ready");
    let mut queued = child(&settings, &marker, true);
    until(|| marker.exists()).await;
    assert_eq!(held_slots(&dir, "queued", QUEUED_LIMIT), QUEUED_LIMIT);
    let ctx = context(Some(settings));
    let result = acquire(&ctx, &CancellationToken::new(), deadline()).await;
    assert!(
        matches!(result, Err(error) if error.kind == WebSearchErrorKind::RateLimited && !error.request_sent)
    );
    queued.0.kill().unwrap();
    queued.0.wait().unwrap();
    until(|| held_slots(&dir, "queued", QUEUED_LIMIT) == 0).await;
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), ACTIVE_LIMIT);
    assert!(
        peers
            .iter_mut()
            .all(|peer| peer.0.try_wait().unwrap().is_none())
    );
    peers[0].0.kill().unwrap();
    peers[0].0.wait().unwrap();
    let replacement = acquire(&ctx, &CancellationToken::new(), deadline())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), ACTIVE_LIMIT);
    assert!(
        peers[1..]
            .iter_mut()
            .all(|peer| peer.0.try_wait().unwrap().is_none())
    );
    drop(replacement);
    drop(peers);
    assert_eq!(held_slots(&dir, "active", ACTIVE_LIMIT), 0);
    assert_eq!(held_slots(&dir, "queued", QUEUED_LIMIT), 0);
}
