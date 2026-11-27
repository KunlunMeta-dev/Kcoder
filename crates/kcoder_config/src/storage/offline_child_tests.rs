use super::*;
use crate::storage::{StorageInstance, StorageResolveInput, resolve_storage_paths};
use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent};
use std::{collections::BTreeMap, fs, io::BufReader};

fn plan(home: &Path) -> StorageMigrationPlan {
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        ..Default::default()
    })
    .unwrap();
    fs::create_dir_all(&from.temporary_root).unwrap();
    let data_root = home.join("TargetData");
    let cache_root = home.join("TargetCache");
    fs::create_dir(&data_root).unwrap();
    fs::create_dir(&cache_root).unwrap();
    let source_identity = PrivateDirectory::open_existing(&from.data_root)
        .unwrap()
        .directory_identity()
        .unwrap();
    StorageMigrationPlan {
        version: 1,
        operation_id: "owned-child-operation".into(),
        original: None,
        components: vec![StorageMigrationComponent {
            domain: "owned-native".into(),
            source: from.data_root.clone(),
            destination: data_root.clone(),
            source_identity,
            estimated_bytes: 0,
        }],
        from,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root,
            cache_root,
            operation_id: Some("owned-child-operation".into()),
        },
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    }
}

fn stopped(home: &Path, plan: &StorageMigrationPlan) -> StorageCoordinator {
    let mut coordinator = StorageCoordinator::acquire(home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance(&plan.operation_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(&plan.operation_id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
}

fn explicit(home: &Path, profile: &Path) -> StorageResolveInput {
    StorageResolveInput {
        home: Some(home.into()),
        env: BTreeMap::from([
            ("KCODER_HOME".into(), profile.as_os_str().to_owned()),
            (
                "KCODER_CACHE_DIR".into(),
                home.join("ExplicitCache").into_os_string(),
            ),
        ]),
        ..Default::default()
    }
}

#[test]
fn orphan_child_fence_blocks_same_root_nested_startup_and_another_coordinator() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let mut parent = stopped(owned.path(), &plan);
    let original = parent
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
    parent
        .validate_offline_child_fences(&plan.operation_id, &original)
        .unwrap();
    let directory = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    let child = directory
        .try_exclusive_lock(OsStr::new(INSTANCES))
        .unwrap()
        .unwrap();
    // A live delegate must not make its own parent's fresh check deadlock.
    parent
        .validate_offline_child_fences(&plan.operation_id, &original)
        .unwrap();
    drop(parent);
    for profile in [&plan.from.data_root, &plan.from.data_root.join("Nested")] {
        assert_eq!(
            StorageInstance::open(explicit(owned.path(), profile))
                .err()
                .unwrap()
                .to_string(),
            "STORAGE_MIGRATION_BUSY"
        );
    }
    let mut replacement = StorageCoordinator::acquire(owned.path()).unwrap();
    assert_eq!(
        replacement
            .prepare_offline_child_fences(&plan.operation_id)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    drop(replacement);
    drop(child);
    // Kernel release does not settle the original Active operation.
    assert_eq!(
        StorageInstance::open(explicit(owned.path(), &plan.from.data_root))
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    let mut replacement = StorageCoordinator::acquire(owned.path()).unwrap();
    replacement
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
}

#[test]
fn global_instances_lock_is_not_an_unregistered_ancestor_child_fence() {
    let owned = tempfile::tempdir().unwrap();
    let control = PrivateDirectory::open_config_root(&owned.path().join(".config")).unwrap();
    let _global = control
        .try_exclusive_lock(OsStr::new(INSTANCES))
        .unwrap()
        .unwrap();
    let instance = StorageInstance::open(explicit(
        owned.path(),
        &owned.path().join(".config/Explicit"),
    ))
    .unwrap();
    assert!(
        !owned
            .path()
            .join(".config/kcoder-storage-writers.lock")
            .exists()
    );
    drop(instance);
}

#[test]
fn nonempty_primary_is_unknown_payload_and_never_becomes_a_copy_exclusion() {
    use std::io::Write;
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let directory = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    let mut payload = directory
        .open_read_write_file(OsStr::new(crate::storage::writers::WRITERS), true)
        .unwrap();
    payload.write_all(b"unknown persistent data").unwrap();
    drop(payload);
    assert_eq!(
        StorageInstance::open(explicit(owned.path(), &plan.from.data_root))
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    let mut parent = StorageCoordinator::acquire(owned.path()).unwrap();
    parent.begin(plan.clone()).unwrap();
    parent
        .advance(&plan.operation_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    assert_eq!(
        parent
            .advance(&plan.operation_id, Phase::Stopping, Phase::Stopped)
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    assert_eq!(
        fs::read(plan.from.data_root.join("kcoder-storage-writers.lock")).unwrap(),
        b"unknown persistent data"
    );
}

#[test]
fn personal_control_fences_reject_nonempty_payloads_while_queries_remain_read_only() {
    use std::io::Write;
    for name in [LOCK, INSTANCES] {
        let owned = tempfile::tempdir().unwrap();
        let control = PrivateDirectory::open_config_root(&owned.path().join(".config")).unwrap();
        let mut payload = control
            .open_read_write_file(OsStr::new(name), true)
            .unwrap();
        payload
            .write_all(b"unknown personal control payload")
            .unwrap();
        drop(payload);
        assert_eq!(read_storage_migration(owned.path()).unwrap(), None);
        assert_eq!(
            StorageStartupLease::acquire(owned.path())
                .err()
                .unwrap()
                .to_string(),
            "STORAGE_CONTROL_CHANGED"
        );
        assert_eq!(
            StorageCoordinator::acquire(owned.path())
                .err()
                .unwrap()
                .to_string(),
            "STORAGE_CONTROL_CHANGED"
        );
        assert_eq!(
            fs::read(owned.path().join(".config").join(name)).unwrap(),
            b"unknown personal control payload"
        );
        assert!(!owned.path().join(".config/kcoder").exists());
    }
}

#[test]
fn nonempty_secondary_is_preserved_and_not_adopted_by_preparation_or_inventory() {
    use std::io::Write;
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let mut parent = stopped(owned.path(), &plan);
    let directory = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    let mut payload = directory
        .open_read_write_file(OsStr::new(INSTANCES), true)
        .unwrap();
    payload.write_all(b"unknown secondary payload").unwrap();
    drop(payload);
    assert_eq!(
        parent
            .prepare_offline_child_fences(&plan.operation_id)
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    let inventory = parent
        .inventory_source(&plan.operation_id, "owned-native", &Default::default())
        .unwrap();
    let entry = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new(INSTANCES))
        .unwrap();
    assert!(!entry.excluded && entry.sha256.is_some());
    assert_eq!(
        fs::read(plan.from.data_root.join(INSTANCES)).unwrap(),
        b"unknown secondary payload"
    );
}

#[test]
fn inventory_excludes_prepared_secondary_identity_and_preserves_unknown_same_named_payloads() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let unknown = plan.from.data_root.join("Unknown");
    fs::create_dir(&unknown).unwrap();
    fs::write(
        unknown.join(INSTANCES),
        b"persistent payload with the same leaf name",
    )
    .unwrap();
    let mut parent = stopped(owned.path(), &plan);
    let original = parent
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
    let inventory = parent
        .inventory_source(&plan.operation_id, "owned-native", &Default::default())
        .unwrap();
    let secondary = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new(INSTANCES))
        .unwrap();
    assert!(secondary.excluded && secondary.sha256.is_none());
    assert_eq!(
        secondary.identity,
        original
            .roots
            .iter()
            .find(|root| root.root == plan.from.data_root)
            .unwrap()
            .secondary_identity
    );
    let unknown = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("Unknown").join(INSTANCES))
        .unwrap();
    assert!(!unknown.excluded && unknown.sha256.is_some());
}

#[test]
fn fresh_parent_checks_reject_changed_facts_and_committed_or_deferred_operations() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let mut parent = stopped(owned.path(), &plan);
    let original = parent
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
    let mut forged = original.clone();
    forged.roots[0].secondary_identity.push('x');
    assert!(
        parent
            .validate_offline_child_fences(&plan.operation_id, &forged)
            .is_err()
    );
    parent
        .validate_offline_child_fences(&plan.operation_id, &original)
        .unwrap();
    parent
        .defer_after_cleanup(&plan.operation_id, "STORAGE_TEST_DEFERRED")
        .unwrap();
    assert_eq!(
        parent
            .validate_offline_child_fences(&plan.operation_id, &original)
            .unwrap_err()
            .to_string(),
        "STORAGE_PHASE_INVALID"
    );
    parent.retry_deferred(&plan.operation_id).unwrap();
    for (before, after) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        if before == Phase::Stopped {
            parent
                .prepare_source_retirements(&plan.operation_id)
                .unwrap();
        }
        parent.advance(&plan.operation_id, before, after).unwrap();
    }
    parent
        .validate_offline_child_fences(&plan.operation_id, &original)
        .unwrap();
    parent.commit(&plan.operation_id).unwrap();
    assert_eq!(
        parent
            .validate_offline_child_fences(&plan.operation_id, &original)
            .unwrap_err()
            .to_string(),
        "STORAGE_PHASE_INVALID"
    );
}

#[cfg(unix)]
#[test]
fn replacing_secondary_invalidates_the_original_parent_even_with_identical_bytes() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path());
    let mut parent = stopped(owned.path(), &plan);
    let original = parent
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
    let path = plan.from.data_root.join(INSTANCES);
    fs::remove_file(&path).unwrap();
    let directory = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    drop(
        directory
            .try_shared_lock(OsStr::new(INSTANCES))
            .unwrap()
            .unwrap(),
    );
    assert!(
        parent
            .validate_offline_child_fences(&plan.operation_id, &original)
            .is_err()
    );
}

#[test]
fn private_frames_are_bounded_and_invalid_utf8_or_non_objects_fail_closed() {
    let mut input = std::io::Cursor::new(b"{\"type\":\"first\"}\n{\"type\":\"second\"}\n");
    assert_eq!(
        read_storage_offline_child_frame(&mut input).unwrap()["type"],
        "first"
    );
    assert_eq!(
        read_storage_offline_child_frame(&mut input).unwrap()["type"],
        "second"
    );
    for bytes in [
        b"[]\n".to_vec(),
        vec![b'{', b'"', 255, b'"', b':', b'0', b'}', b'\n'],
        vec![b'x'; STORAGE_OFFLINE_CHILD_FRAME_LIMIT + 1],
    ] {
        assert!(read_storage_offline_child_frame(&mut std::io::Cursor::new(bytes)).is_err());
    }
    let mut output = Vec::new();
    write_storage_offline_child_frame(&mut output, &serde_json::json!({"type":"owned"})).unwrap();
    assert_eq!(
        read_storage_offline_child_frame(&mut std::io::Cursor::new(output)).unwrap()["type"],
        "owned"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn parent_death_keeps_actual_node_child_fenced_until_its_kernel_exit() {
    const CHILD_HOME: &str = "KCODER_STORAGE_OFFLINE_CHILD_TEST_HOME";
    if let Some(home) = std::env::var_os(CHILD_HOME) {
        run_owner_parent(&PathBuf::from(home));
        return;
    }
    use std::io::BufRead;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;
    let owned = tempfile::tempdir().unwrap();
    let filter = format!(
        "{}::parent_death_keeps_actual_node_child_fenced_until_its_kernel_exit",
        module_path!().split_once("::").unwrap().1
    );
    struct OwnerParent(Child);
    impl Drop for OwnerParent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut parent = OwnerParent(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &filter, "--nocapture"])
            .env(CHILD_HOME, owned.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = parent.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                let _ = send.send(frame);
            }
        }
    });
    let spawned = match receive.recv_timeout(Duration::from_secs(15)) {
        Ok(frame) => frame,
        Err(error) => {
            let _ = parent.0.kill();
            let _ = parent.0.wait();
            reader.join().unwrap();
            panic!("owned Rust parent must report its exact spawned child: {error}");
        }
    };
    let pid = spawned["nodePid"].as_u64().unwrap() as libc::pid_t;
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(
        descriptor >= 0,
        "actual child pidfd is required for exact cleanup"
    );
    struct NodeExit(OwnedFd);
    impl NodeExit {
        fn exited(&self, timeout: i32) -> bool {
            let mut entry = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut entry, 1, timeout) > 0 && entry.revents & libc::POLLIN != 0 }
        }
        fn stop(&self) {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.0.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
            assert!(
                self.exited(5000),
                "owned Node must actually exit before roots can reopen"
            );
        }
    }
    impl Drop for NodeExit {
        fn drop(&mut self) {
            self.stop();
        }
    }
    let node = NodeExit(unsafe { OwnedFd::from_raw_fd(descriptor as i32) });
    let ready = match receive.recv_timeout(Duration::from_secs(15)) {
        Ok(frame) => frame,
        Err(error) => {
            let _ = parent.0.kill();
            let _ = parent.0.wait();
            reader.join().unwrap();
            panic!("owned Rust/Node parent must reach its guarded business boundary: {error}");
        }
    };
    parent.0.kill().unwrap();
    parent.0.wait().unwrap();
    reader.join().unwrap();
    assert!(
        !node.exited(0),
        "parent death must leave the deliberately active owned child alive"
    );
    let source = PathBuf::from(ready["source"].as_str().unwrap());
    let before = fs::read(source.join("business.txt")).unwrap();
    let directory = PrivateDirectory::open_existing(&source).unwrap();
    let primary = directory
        .try_exclusive_lock(OsStr::new(crate::storage::writers::WRITERS))
        .unwrap()
        .expect(
            "the original primary is gone; the child independently retains the secondary fence",
        );
    drop(primary);
    assert_eq!(
        StorageInstance::open(explicit(owned.path(), &source))
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_BUSY"
    );
    let mut replacement = StorageCoordinator::acquire(owned.path()).unwrap();
    assert_eq!(
        replacement
            .prepare_offline_child_fences("owned-child-operation")
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    drop(replacement);
    assert_eq!(fs::read(source.join("business.txt")).unwrap(), before);
    node.stop();
    // Actual child exit releases its fence, while Active still refuses business.
    assert_eq!(
        StorageInstance::open(explicit(owned.path(), &source))
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    let mut replacement = StorageCoordinator::acquire(owned.path()).unwrap();
    replacement
        .prepare_offline_child_fences("owned-child-operation")
        .unwrap();
}

#[cfg(target_os = "linux")]
fn run_owner_parent(home: &Path) {
    use std::io::Write;
    use std::process::{Child, Command, Stdio};
    let plan = plan(home);
    let mut coordinator = stopped(home, &plan);
    let original = coordinator
        .prepare_offline_child_fences(&plan.operation_id)
        .unwrap();
    let source = plan.from.data_root.clone();
    fs::write(source.join("business.txt"), b"original").unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/kcoder-studio/src/migrations/offline-owner-child.test.mjs");
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(
        Command::new("node")
            .arg(fixture)
            .arg("--owned-child")
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    println!("\n{}", serde_json::json!({"nodePid":child.0.id()}));
    std::io::stdout().flush().unwrap();
    let mut input = child.0.stdin.take().unwrap();
    let mut output = BufReader::new(child.0.stdout.take().unwrap());
    write_storage_offline_child_frame(&mut input, &serde_json::json!({"type":"initialize","version":1,
        "operationId":plan.operation_id,"roots":original.roots,"payload":{"source":source,
        "finalTarget":plan.target.data_root,"business":source.join("business.txt"),"pauseMs":30000}})).unwrap();
    loop {
        let frame = read_storage_offline_child_frame(&mut output).unwrap();
        match frame["type"].as_str().unwrap() {
            "validateFences" | "validateOffline" => {
                coordinator
                    .validate_offline_child_fences(&plan.operation_id, &original)
                    .unwrap();
                if frame["type"] == "validateFences" {
                    assert_eq!(
                        frame["facts"],
                        serde_json::to_value(&original.roots).unwrap()
                    );
                } else {
                    assert_eq!(
                        frame["facts"],
                        serde_json::json!({"domain":"owned-fixture","operationId":plan.operation_id,
                    "source":source,"finalTarget":plan.target.data_root})
                    );
                }
                write_storage_offline_child_frame(
                    &mut input,
                    &serde_json::json!({"type":"validated","version":1,
                    "operationId":plan.operation_id,"sequence":frame["sequence"]}),
                )
                .unwrap();
            }
            "ready" => {}
            "fixtureAlive" => {
                println!(
                    "\n{}",
                    serde_json::json!({"nodePid":child.0.id(),"source":source})
                );
                std::io::stdout().flush().unwrap();
                loop {
                    std::thread::park();
                }
            }
            other => panic!("offline child failed before business handoff: {other}: {frame}"),
        }
    }
}
