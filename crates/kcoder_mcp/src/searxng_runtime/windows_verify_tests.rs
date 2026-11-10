use super::*;
use crate::searxng_runtime::tests::sealed_fixture;

#[test]
fn failed_parallel_batch_joins_all_workers_and_releases_successful_pins() {
    let fixture = sealed_fixture();
    let parent = ReadOnlyDirectoryPin::open_existing(fixture.path()).unwrap();
    let jobs = (0..24)
        .map(|index| OpenJob {
            name: format!("owned-{index}"),
            parent: parent.clone(),
            leaf: OsString::from(if index == 9 {
                "missing-resource"
            } else {
                "launch.py"
            }),
        })
        .collect();
    assert!(open_payloads(jobs, &mut VerifyMetrics::default()).is_err());
    // A returned error is not allowed to leave another batch opening/holding
    // a leaf in the background. No sleeps or process-name cleanup are used.
    std::fs::write(fixture.path().join("launch.py"), b"released").unwrap();
    drop(parent);
    let moved = fixture.path().with_extension("released");
    std::fs::rename(fixture.path(), &moved).unwrap();
    std::fs::rename(moved, fixture.path()).unwrap();
}

#[test]
fn unsafe_inventory_paths_do_not_escape_the_pinned_tree() {
    for name in [
        "../outside",
        "/absolute",
        "source\\outside",
        "launch.py:stream",
        "CON",
        "source/../../outside",
    ] {
        let fixture = sealed_fixture();
        let inventory = fixture.path().join("files.sha256.json");
        let mut data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&inventory).unwrap()).unwrap();
        data["files"][name] = serde_json::json!({"bytes":0,"sha256":"invalid"});
        std::fs::write(inventory, data.to_string()).unwrap();
        assert!(verify(fixture.path(), &mut VerifyMetrics::default()).is_err());
    }
}

#[test]
fn full_inventory_accepts_the_fixture_and_rejects_same_length_restored_mtime_tampering() {
    let fixture = sealed_fixture();
    let mut metrics = VerifyMetrics::default();
    let verified = verify(fixture.path(), &mut metrics).unwrap();
    assert_eq!(metrics.json()["inventoryFiles"], 6);
    drop(verified);
    let path = fixture.path().join("launch.py");
    let modified = path.metadata().unwrap().modified().unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    drop(file);
    assert!(verify(fixture.path(), &mut metrics).is_err());
}

#[test]
fn missing_unlisted_required_and_budget_violations_fail_closed() {
    for variant in 0..6 {
        let fixture = sealed_fixture();
        let inventory = fixture.path().join("files.sha256.json");
        let mut data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&inventory).unwrap()).unwrap();
        match variant {
            0 => std::fs::remove_file(fixture.path().join("source/searx/webapp.py")).unwrap(),
            1 => std::fs::write(fixture.path().join("unexpected.py"), b"unlisted").unwrap(),
            2 => {
                data["files"].as_object_mut().unwrap().remove("launch.py");
            }
            3 => data["files"]["launch.py"]["bytes"] = (256u64 * 1024 * 1024 + 1).into(),
            4 => {
                let entries = data["files"].as_object_mut().unwrap();
                for index in 0..30001 {
                    entries.insert(
                        format!("extra-{index}"),
                        serde_json::json!({"bytes":0,"sha256":"invalid"}),
                    );
                }
            }
            _ => {
                for entry in data["files"].as_object_mut().unwrap().values_mut() {
                    entry["bytes"] = (256u64 * 1024 * 1024).into();
                }
            }
        }
        if variant >= 2 {
            std::fs::write(inventory, data.to_string()).unwrap();
        }
        assert!(verify(fixture.path(), &mut VerifyMetrics::default()).is_err());
    }
}

#[test]
fn bounded_directory_inventory_uses_the_same_fail_closed_predicate() {
    let fixture = sealed_fixture();
    DIRECTORY_BUDGET.with(|slot| slot.set(Some(1)));
    let error = verify(fixture.path(), &mut VerifyMetrics::default())
        .err()
        .unwrap();
    assert!(error.to_string().contains("directory budget"));
}

#[test]
fn concurrent_leaf_and_directory_replacement_are_blocked_by_the_owned_pins() {
    let fixture = sealed_fixture();
    let root = fixture.path().to_owned();
    FINAL_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            assert!(std::fs::rename(root.join("launch.py"), root.join("moved.py")).is_err());
            assert!(std::fs::rename(root.join("source"), root.join("moved-source")).is_err());
            assert!(std::fs::write(root.join("launch.py"), b"changed").is_err());
        }))
    });
    assert!(verify(fixture.path(), &mut VerifyMetrics::default()).is_ok());
}

#[test]
fn unlisted_insertion_at_final_validation_is_rejected_and_all_pins_release() {
    let fixture = sealed_fixture();
    let unexpected = fixture.path().join("late.py");
    FINAL_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::write(unexpected, b"late unlisted input").unwrap();
        }))
    });
    assert!(verify(fixture.path(), &mut VerifyMetrics::default()).is_err());
    let moved = fixture.path().with_extension("released");
    std::fs::rename(fixture.path(), &moved).unwrap();
    std::fs::rename(moved, fixture.path()).unwrap();
}

#[test]
fn verified_lease_blocks_mutation_until_every_peer_releases() {
    let fixture = sealed_fixture();
    let path = fixture.path().join("launch.py");
    let first = verify(fixture.path(), &mut VerifyMetrics::default()).unwrap();
    let peer = verify(fixture.path(), &mut VerifyMetrics::default()).unwrap();
    assert!(std::fs::write(&path, b"changed").is_err());
    assert!(std::fs::rename(fixture.path(), fixture.path().with_extension("moved")).is_err());
    drop(first);
    assert!(std::fs::write(&path, b"changed").is_err());
    drop(peer);
    std::fs::write(path, b"changed").unwrap();
}

#[test]
fn outside_hardlink_alias_is_not_a_verified_resource() {
    let fixture = sealed_fixture();
    let outside = tempfile::tempdir().unwrap();
    std::fs::hard_link(
        fixture.path().join("launch.py"),
        outside.path().join("alias"),
    )
    .unwrap();
    assert!(verify(fixture.path(), &mut VerifyMetrics::default()).is_err());
}

#[tokio::test]
async fn spawn_failure_releases_the_unstarted_verification_lease() {
    let fixture = sealed_fixture();
    {
        let _verified = verify(fixture.path(), &mut VerifyMetrics::default()).unwrap();
        let result = crate::StdioTransport::new_owned_private(
            fixture.path().join("missing-worker.exe").to_str().unwrap(),
            &[],
            &std::collections::HashMap::new(),
            &std::env::current_exe().unwrap(),
        )
        .await;
        assert!(result.is_err());
    }
    std::fs::write(fixture.path().join("launch.py"), b"released").unwrap();
}

#[tokio::test]
async fn invalid_ready_keeps_pins_until_the_original_job_exit_receipt() {
    use crate::McpTransport;
    let fixture = sealed_fixture();
    let profile = tempfile::tempdir().unwrap();
    let workspace =
        kcoder_config::create_private_temp_dir_in(profile.path(), "kcoder-searxng").unwrap();
    let workspace_path = workspace.path().to_owned();
    let verified = verify(fixture.path(), &mut VerifyMetrics::default()).unwrap();
    let system = std::env::var_os("SystemRoot").expect("Native Windows SystemRoot required");
    let command = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let arguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::Out.WriteLine('not-json'); [Console]::Out.Flush(); $null=[Console]::In.ReadLine(); $null=[Console]::In.ReadLine()"]
        .map(str::to_owned);
    let (mut owner, exit) = crate::StdioTransport::new_owned_private(
        command.to_str().unwrap(),
        &arguments,
        &std::collections::HashMap::new(),
        &std::env::current_exe().unwrap(),
    )
    .await
    .unwrap();
    let retained = crate::searxng_runtime::retain_windows_runtime(workspace, verified, exit);
    crate::searxng_runtime::start(
        &mut owner,
        "owned-test-authority",
        &workspace_path,
        &kcoder_config::WebFetchSettings::default(),
        None,
    )
    .await
    .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(10), owner.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&ready).is_err());
    assert!(owner.is_healthy());
    assert!(workspace_path.exists());
    assert!(std::fs::write(fixture.path().join("launch.py"), b"early mutation").is_err());
    drop(owner);
    tokio::time::timeout(Duration::from_secs(10), retained)
        .await
        .unwrap()
        .unwrap();
    assert!(!workspace_path.exists());
    std::fs::write(fixture.path().join("launch.py"), b"released after exit").unwrap();
}
