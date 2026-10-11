use super::*;
use std::os::unix::fs::PermissionsExt;

fn owned_shell(root: &Path, body: &str) -> PathBuf {
    let path = root.join("fixture-bash");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn owned_command(shell: &Path, root: &Path) -> Command {
    let mut command = snapshot_command(shell, root);
    command
        .env_clear()
        .env("HOME", root)
        .env("PATH", "/usr/bin:/bin");
    command
}

#[tokio::test]
async fn validation_timeout_cleans_every_owned_temporary_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let snapshots = temp.path().join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    let shell = owned_shell(
        temp.path(),
        "if [ \"$1\" = -l ]; then printf '%s\\n' 'export SNAPSHOT_OWNED=yes'; else sleep 0.4; fi",
    );
    let result = build_snapshot_in(
        &snapshots,
        "owned",
        "export SAFE=yes\n",
        "export SAFE=yes\n",
        || owned_command(&shell, temp.path()),
        Duration::from_millis(150),
    )
    .await;
    // A short-lived fixture needs no unowned PID or process-name cleanup.
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_dir(&snapshots).unwrap().count(),
        0,
        "failed validation must leave no temporary snapshots"
    );
}

#[tokio::test]
async fn snapshot_timeout_stops_the_owned_background_descendant() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("descendant-finished");
    let shell = owned_shell(
        temp.path(),
        "(sleep 0.35; printf done > descendant-finished) </dev/null >/dev/null 2>&1 &\nwait",
    );
    let mut command = owned_command(&shell, temp.path());
    command.args(["-l", "-c", SNAPSHOT_SCRIPT]);
    let result = process::run(command, Duration::from_millis(150), true).await;
    assert!(result.is_err());
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert!(
        !marker.exists(),
        "snapshot cancellation must terminate its own background descendant"
    );
}

#[tokio::test]
async fn snapshot_output_over_the_isolated_copy_budget_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let snapshots = temp.path().join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    let shell = owned_shell(
        temp.path(),
        "if [ \"$1\" = -l ]; then head -c 1048577 /dev/zero; else exit 0; fi",
    );
    let result = build_snapshot_in(
        &snapshots,
        "owned",
        "",
        "",
        || owned_command(&shell, temp.path()),
        Duration::from_secs(2),
    )
    .await;
    let rejected = result.is_err();
    // The unfixed builder publishes the oversized fixture. Remove only our own files.
    if let Ok(paths) = result {
        for path in [paths.0, paths.1, paths.2] {
            std::fs::remove_file(path).unwrap();
        }
    }
    assert!(
        rejected,
        "oversized source must fall back rather than publishing a truncated or oversized snapshot"
    );
    assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 0);
}

#[tokio::test]
async fn successful_snapshots_are_complete_private_and_validated_with_owned_environment() {
    let temp = tempfile::tempdir().unwrap();
    let snapshots = temp.path().join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    let source = "export SNAPSHOT_OWNED=yes\n";
    let shell = owned_shell(
        temp.path(),
        "if [ \"$1\" = -l ]; then printf '%s\\n' 'export SNAPSHOT_OWNED=yes'; else exec /bin/bash --noprofile --norc \"$@\"; fi",
    );
    let paths = build_snapshot_in(
        &snapshots,
        "owned",
        "export SAFE=yes\n",
        "export SAFE=yes\n",
        || owned_command(&shell, temp.path()),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&paths.0).unwrap(), source);
    for path in [&paths.0, &paths.1, &paths.2] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 3);
}

#[test]
fn temporary_file_is_private_before_content_is_written_and_rolls_back_on_drop() {
    use std::io::Write;
    let temp = tempfile::tempdir().unwrap();
    let mut file = files::private_file(temp.path(), b"").unwrap();
    let path = file.path().to_path_buf();
    assert_eq!(
        file.as_file().metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    file.write_all(b"owned fixture only").unwrap();
    drop(file);
    assert!(!path.exists());
}

#[tokio::test]
async fn stderr_over_budget_fails_without_publishing_or_echoing_raw_output() {
    let temp = tempfile::tempdir().unwrap();
    let snapshots = temp.path().join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    let shell = owned_shell(temp.path(), "head -c 65537 /dev/zero >&2");
    let result = build_snapshot_in(
        &snapshots,
        "owned",
        "",
        "",
        || owned_command(&shell, temp.path()),
        Duration::from_secs(2),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("stderr exceeds"));
    assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 0);
}

#[tokio::test]
async fn task_abort_during_validation_removes_temp_files_and_kills_only_its_group() {
    let temp = tempfile::tempdir().unwrap();
    let snapshots = temp.path().join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    let shell = owned_shell(
        temp.path(),
        "if [ \"$1\" = -l ]; then printf '%s\\n' 'export OWNED=yes'; else printf started > validating; (sleep 0.35; printf done > cancelled-descendant) </dev/null >/dev/null 2>&1 & wait; fi",
    );
    let root = temp.path().to_path_buf();
    let snapshots_clone = snapshots.clone();
    let pending = tokio::spawn(async move {
        build_snapshot_in(
            &snapshots_clone,
            "owned",
            "",
            "",
            || owned_command(&shell, &root),
            Duration::from_secs(2),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !temp.path().join("validating").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    // This separately owned sibling must survive snapshot cancellation.
    let mut sibling = Command::new("/bin/sh")
        .args(["-c", "sleep 0.3; printf sibling > sibling-completed"])
        .current_dir(temp.path())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert!(sibling.wait().await.unwrap().success());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(temp.path().join("sibling-completed").exists());
    assert!(!temp.path().join("cancelled-descendant").exists());
    assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 0);
}

#[test]
fn failed_or_abandoned_publication_rolls_back_only_owned_files() {
    let temp = tempfile::tempdir().unwrap();
    let existing = temp.path().join("existing.sh");
    std::fs::write(&existing, "keep existing").unwrap();
    let owned = temp.path().join("owned.sh");
    let files = vec![
        (
            files::private_file(temp.path(), b"first").unwrap(),
            owned.clone(),
        ),
        (
            files::private_file(temp.path(), b"second").unwrap(),
            existing.clone(),
        ),
        (
            files::private_file(temp.path(), b"third").unwrap(),
            temp.path().join("last.sh"),
        ),
    ];
    assert!(files::Publication::publish(files).is_err());
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "keep existing");
    assert!(!owned.exists());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    let publication = files::Publication::publish(vec![(
        files::private_file(temp.path(), b"new").unwrap(),
        owned.clone(),
    )])
    .unwrap();
    drop(publication);
    assert!(!owned.exists());
}

#[tokio::test]
async fn stale_snapshot_retention_stays_three_days_and_preserves_fresh_files() {
    let temp = tempfile::tempdir().unwrap();
    let stale = temp.path().join("old.sh");
    let fresh = temp.path().join("fresh.sh");
    std::fs::write(&stale, "old fixture").unwrap();
    std::fs::write(&fresh, "fresh fixture").unwrap();
    std::fs::File::open(&stale)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(SystemTime::now() - SNAPSHOT_RETENTION - Duration::from_secs(1)),
        )
        .unwrap();
    cleanup_stale_snapshots(temp.path()).await;
    assert!(!stale.exists());
    assert!(fresh.exists());
}
