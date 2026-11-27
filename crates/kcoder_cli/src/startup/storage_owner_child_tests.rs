use super::run_offline_owner_child;
use anyhow::{Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    storage::{StorageCoordinator, StorageResolveInput, resolve_storage_paths},
};
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
    StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tempfile::TempDir;
use tokio::process::Command;

const OPERATION_ID: &str = "offline-owner-pump-test";

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
        operation_id: OPERATION_ID.into(),
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
            operation_id: Some(OPERATION_ID.into()),
        },
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    }
}

fn stopped(home: &Path, plan: &StorageMigrationPlan) -> StorageCoordinator {
    let mut coordinator = StorageCoordinator::acquire(home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance(OPERATION_ID, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(OPERATION_ID, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
}

fn repository_root() -> PathBuf {
    kcoder_test_harness::workspace_root().unwrap()
}

fn node() -> PathBuf {
    which::which("node").expect("Node.js is required for offline owner subprocess tests")
}

fn fake_child(root: &Path, scenario: &str) -> Command {
    let mut command = Command::new(node());
    command
        .arg(root.join("crates/kcoder_cli/src/startup/fixtures/offline-owner-child-probe.mjs"))
        .arg(scenario)
        .env(
            "KCODER_OFFLINE_OWNER_CHILD_MODULE",
            root.join("apps/kcoder-studio/src/migrations/offline-owner-child.mjs"),
        )
        .env("KCODER_TARGET_DIR", root.join("target"))
        .current_dir(root)
        .stderr(Stdio::inherit());
    command
}

fn assert_stopped(coordinator: &StorageCoordinator) {
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt.phase, Phase::Stopped);
}

fn fixture_payload(plan: &StorageMigrationPlan, business: &Path) -> Value {
    json!({
        "business": business,
        "facts": {
            "domain": "owned-fixture",
            "operationId": OPERATION_ID,
            "source": plan.from.data_root,
            "finalTarget": plan.target.data_root,
        },
    })
}

#[tokio::test]
async fn actual_gateway_node_owner_and_native_fences_complete_with_empty_domains() {
    let root = repository_root();
    let home = tempfile::tempdir().unwrap();
    let plan = plan(home.path());
    let mut coordinator = stopped(home.path(), &plan);
    let script = root.join("apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs");
    let mut command = Command::new(node());
    command
        .arg(script)
        .current_dir(&root)
        .env("KCODER_TARGET_DIR", root.join("target"))
        .stderr(Stdio::inherit());
    let mut domain_checks = 0;
    let result = run_offline_owner_child(
        &mut coordinator,
        OPERATION_ID,
        &mut command,
        json!({ "version": 1, "phase": "relocate", "domains": [] }),
        Duration::from_secs(20),
        |_| {
            domain_checks += 1;
            anyhow::bail!("empty domain list must not request owner facts")
        },
    )
    .await
    .unwrap();

    assert_eq!(
        result,
        json!({ "version": 1, "operationId": OPERATION_ID, "phase": "relocate", "domains": [] })
    );
    assert_eq!(domain_checks, 0);
    assert_stopped(&coordinator);
}

#[tokio::test]
async fn completed_frame_is_not_success_until_the_node_process_exits_zero() {
    let root = repository_root();
    let home = tempfile::tempdir().unwrap();
    let plan = plan(home.path());
    let mut coordinator = stopped(home.path(), &plan);
    let business = plan.from.data_root.join("business.txt");
    fs::write(&business, b"original").unwrap();
    let mut command = fake_child(&root, "nonzero-after-completed");
    let error = run_offline_owner_child(
        &mut coordinator,
        OPERATION_ID,
        &mut command,
        fixture_payload(&plan, &business),
        Duration::from_secs(10),
        |facts| {
            ensure!(
                facts["source"] == json!(plan.from.data_root),
                "STORAGE_TEST_DOMAIN_REJECTED"
            );
            ensure!(
                facts["finalTarget"] == json!(plan.target.data_root),
                "STORAGE_TEST_DOMAIN_REJECTED"
            );
            Ok(())
        },
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("STORAGE_OFFLINE_CHILD_FAILED"));
    assert_eq!(
        fs::read(&business).unwrap(),
        b"written by the offline owner"
    );
    assert_stopped(&coordinator);
}

#[tokio::test]
async fn child_domain_facts_must_match_the_parent_scope_before_business_writes() {
    let root = repository_root();
    let home = tempfile::tempdir().unwrap();
    let plan = plan(home.path());
    let mut coordinator = stopped(home.path(), &plan);
    let business = plan.from.data_root.join("business.txt");
    fs::write(&business, b"original").unwrap();
    let mut command = fake_child(&root, "domain-facts-out-of-scope");
    let mut checks = 0;
    let error = run_offline_owner_child(
        &mut coordinator,
        OPERATION_ID,
        &mut command,
        fixture_payload(&plan, &business),
        Duration::from_secs(10),
        |facts| {
            checks += 1;
            ensure!(
                facts["source"] == json!(plan.from.data_root),
                "STORAGE_TEST_DOMAIN_REJECTED"
            );
            Ok(())
        },
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("STORAGE_TEST_DOMAIN_REJECTED"));
    assert_eq!(checks, 1);
    assert_eq!(fs::read(&business).unwrap(), b"original");
    assert_stopped(&coordinator);
}

#[tokio::test]
async fn malformed_oversized_forged_facts_and_missing_completion_fail_closed() {
    let root = repository_root();
    for (scenario, expected) in [
        ("malformed-frame", "STORAGE_OFFLINE_CHILD_FRAME_INVALID"),
        ("oversized-frame", "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"),
        ("forged-fences", "STORAGE_OFFLINE_CHILD_FENCE_CHANGED"),
        (
            "ready-without-completed",
            "STORAGE_OFFLINE_CHILD_RESULT_MISSING",
        ),
    ] {
        let home = tempfile::tempdir().unwrap();
        let plan = plan(home.path());
        let mut coordinator = stopped(home.path(), &plan);
        let business = plan.from.data_root.join("business.txt");
        fs::write(&business, b"original").unwrap();
        let mut command = fake_child(&root, scenario);
        let error = run_offline_owner_child(
            &mut coordinator,
            OPERATION_ID,
            &mut command,
            fixture_payload(&plan, &business),
            Duration::from_secs(10),
            |_| Ok(()),
        )
        .await
        .unwrap_err();

        assert!(
            error.to_string().contains(expected),
            "{scenario}: {error:#}"
        );
        assert_eq!(fs::read(&business).unwrap(), b"original", "{scenario}");
        assert_stopped(&coordinator);
    }
}

#[tokio::test]
async fn timeout_reaps_only_the_owned_node_process_group() {
    let root = repository_root();
    let home = tempfile::tempdir().unwrap();
    let plan = plan(home.path());
    let mut coordinator = stopped(home.path(), &plan);
    let business = plan.from.data_root.join("business.txt");
    let started = home.path().join("owned-started");
    let owned_marker = home.path().join("owned-descendant-marker");
    let unrelated_marker = home.path().join("unrelated-marker");
    fs::write(&business, b"original").unwrap();
    let mut unrelated = Command::new(node());
    unrelated
        .args([
            "-e",
            "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'alive'), 1200)",
        ])
        .env("MARKER", &unrelated_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut unrelated = unrelated.spawn().unwrap();
    let mut command = fake_child(&root, "hang-with-descendant");
    let mut payload = fixture_payload(&plan, &business);
    payload["started"] = json!(started);
    payload["ownedMarker"] = json!(owned_marker);
    let error = run_offline_owner_child(
        &mut coordinator,
        OPERATION_ID,
        &mut command,
        payload,
        Duration::from_millis(800),
        |_| Ok(()),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("STORAGE_OFFLINE_CHILD_TIMEOUT"));
    assert!(
        started.is_file(),
        "the timed-out child must have reached its owned work boundary"
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert!(
        unrelated_marker.is_file(),
        "a process outside the owned group must remain alive"
    );
    assert!(
        !owned_marker.exists(),
        "the owned process group must be terminated"
    );
    assert_eq!(fs::read(&business).unwrap(), b"original");
    assert!(unrelated.try_wait().unwrap().is_some());
    assert_stopped(&coordinator);
}

#[cfg(unix)]
#[tokio::test]
async fn invalidated_live_parent_fence_prevents_child_business_work() {
    let root = repository_root();
    let home = tempfile::tempdir().unwrap();
    let plan = plan(home.path());
    let mut coordinator = stopped(home.path(), &plan);
    let business = plan.from.data_root.join("business.txt");
    fs::write(&business, b"original").unwrap();
    let mut command = fake_child(&root, "invalidate-parent-fence");
    let result = run_offline_owner_child(
        &mut coordinator,
        OPERATION_ID,
        &mut command,
        fixture_payload(&plan, &business),
        Duration::from_secs(10),
        |_| Ok(()),
    )
    .await;

    assert!(result.is_err());
    assert_eq!(fs::read(&business).unwrap(), b"original");
}
