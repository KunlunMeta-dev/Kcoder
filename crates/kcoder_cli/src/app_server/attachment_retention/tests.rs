//! Real private filesystem tests for the standalone, still unadvertised service.
#[cfg(target_os = "linux")]
#[path = "namespace_lock_review.rs"]
mod namespace_lock_review;
#[path = "owner_init_v2_tests.rs"]
mod owner_init_v2_tests;
#[path = "release_consume_race_review.rs"]
pub(super) mod release_consume_race_review;
#[path = "retirement_tests.rs"]
mod retirement_tests;

use super::*;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const INIT_CRASH_CHILD_ARM_ENV: &str = "KCODER_TEST_RETENTION_INIT_CRASH_CHILD";
const INIT_CRASH_CHILD_ARM_VALUE: &str = "retention-init-crash-child-v1";
const INIT_CRASH_CHILD_ROOT_ENV: &str = "KCODER_TEST_RETENTION_INIT_CRASH_ROOT";
const INIT_CRASH_CHILD_STEP_ENV: &str = "KCODER_TEST_RETENTION_INIT_CRASH_STEP";
const INIT_CRASH_READY_FILE: &str = "retention-init-child-ready.txt";
const INIT_CRASH_CHILD_TEST: &str =
    "app_server::attachment_retention::tests::retention_owner_init_crash_child_helper";

fn owned_fixture_parent() -> PathBuf {
    let parent = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .expect("Cargo must provide the runtime manifest directory"),
    )
    .join("../..")
    .canonicalize()
    .expect("resolve source workspace")
    .join("target/test/crates/kcoder_cli/retention-fixtures");
    kcoder_config::PrivateDirectory::open_or_create(&parent)
        .expect("create owned private retention fixture parent");
    parent
        .canonicalize()
        .expect("resolve owned retention fixture parent")
}

fn owner_limit() -> Limits {
    Limits {
        owners: 1,
        ..Limits::default()
    }
}

fn fixture_scope(service: &RetentionService) -> Scope {
    service
        .scope(
            &TrustedRetentionContextV1 {
                gateway_namespace_id: "gateway-instance".into(),
                device_id: "device-a".into(),
                authorization_generation: "stable-auth-epoch".into(),
                target_fingerprint: "target-a".into(),
                principal: RetentionPrincipalV1::VerifiedAccount {
                    principal_id: "account-a".into(),
                },
            },
            &digest(b"canonical-workspace-a"),
        )
        .unwrap()
}

/// Test-only stop point for a separately spawned test-harness child. The
/// explicit child arm and exact step prevent ordinary tests from pausing.
pub(super) fn pause_owner_init_test_hook(step: &str, owner_id: &str) {
    if std::env::var_os(INIT_CRASH_CHILD_ARM_ENV).as_deref()
        != Some(OsStr::new(INIT_CRASH_CHILD_ARM_VALUE))
        || std::env::var_os(INIT_CRASH_CHILD_STEP_ENV).as_deref() != Some(OsStr::new(step))
    {
        return;
    }

    let root = PathBuf::from(
        std::env::var_os(INIT_CRASH_CHILD_ROOT_ENV)
            .expect("armed child requires its private fixture root"),
    );
    assert!(root.is_absolute(), "fixture root must be absolute");
    let root = root
        .canonicalize()
        .expect("canonicalize child fixture root");
    assert_eq!(
        root.parent(),
        Some(owned_fixture_parent().as_path()),
        "child fixture must be an owned direct child of the private test root"
    );
    let root_metadata = std::fs::symlink_metadata(&root).expect("stat child fixture root");
    assert!(root_metadata.is_dir() && !root_metadata.file_type().is_symlink());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(root_metadata.uid(), unsafe { libc::geteuid() as u32 });
        assert_eq!(
            root_metadata.mode() & 0o077,
            0,
            "fixture root must be private"
        );
    }

    assert!(
        (owner_id.len() == 32 || (step.starts_with("v2-") && owner_id.len() == 64))
            && owner_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    );
    let record = format!("{step}\n{owner_id}\n");
    assert!(record.len() <= 128, "bounded child ready record");
    let directory = PrivateDirectory::open_or_create(&root).expect("open private child fixture");
    let ready_name = OsStr::new(INIT_CRASH_READY_FILE);
    let existing = directory
        .open_regular_file(ready_name)
        .expect_err("child ready file must be new");
    assert!(
        missing(&existing),
        "unexpected child ready state: {existing:#}"
    );
    directory
        .atomic_replace(ready_name, record.as_bytes())
        .expect("atomically publish private child ready record");
    directory.sync().expect("sync child fixture directory");

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn fixture(limits: Limits) -> (TempDir, RetentionService, Scope) {
    // Put the fixture on the repository's supported local filesystem, rather
    // than silently weakening the production filesystem gate for /tmp.
    let temp = tempfile::Builder::new()
        .prefix("retention-service-test-")
        .tempdir_in(owned_fixture_parent())
        .unwrap();
    let config = temp.path().join("account");
    PrivateDirectory::open_or_create(&config).unwrap();
    let service = RetentionService::open(&config, true, limits)
        .unwrap_or_else(|error| panic!("private retention fixture open failed: {error:#}"));
    let scope = fixture_scope(&service);
    (temp, service, scope)
}

struct InitCrashChild {
    process: Child,
    reaped: bool,
}

impl InitCrashChild {
    fn kill_and_wait(&mut self) -> std::io::Result<ExitStatus> {
        if self.process.try_wait()?.is_none() {
            self.process.kill()?;
        }
        let status = self.process.wait()?;
        self.reaped = true;
        Ok(status)
    }
}

impl Drop for InitCrashChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        if self.process.try_wait().ok().flatten().is_none() {
            let _ = self.process.kill();
        }
        let _ = self.process.wait();
        self.reaped = true;
    }
}

fn spawn_init_crash_child(root: &std::path::Path, step: &str) -> Result<InitCrashChild> {
    anyhow::ensure!(root.is_absolute(), "child fixture root must be absolute");
    let process = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            INIT_CRASH_CHILD_TEST,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(INIT_CRASH_CHILD_ARM_ENV, INIT_CRASH_CHILD_ARM_VALUE)
        .env(INIT_CRASH_CHILD_ROOT_ENV, root)
        .env(INIT_CRASH_CHILD_STEP_ENV, step)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(InitCrashChild {
        process,
        reaped: false,
    })
}

fn wait_for_init_crash_ready(
    child: &mut InitCrashChild,
    root: &std::path::Path,
) -> Result<(String, String)> {
    let directory = PrivateDirectory::open_or_create(root)?;
    let ready_name = OsStr::new(INIT_CRASH_READY_FILE);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match directory.open_regular_file(ready_name) {
            Ok(file) => {
                anyhow::ensure!(
                    file.metadata()?.len() <= 128,
                    "child ready record exceeded bound"
                );
                let mut bytes = Vec::new();
                file.take(129).read_to_end(&mut bytes)?;
                anyhow::ensure!(bytes.len() <= 128, "child ready record exceeded bound");
                let record = String::from_utf8(bytes)?;
                let mut lines = record.lines();
                let step = lines.next().context("child ready step missing")?.to_owned();
                let owner_id = lines
                    .next()
                    .context("child ready owner id missing")?
                    .to_owned();
                anyhow::ensure!(
                    lines.next().is_none(),
                    "unexpected child ready record fields"
                );
                anyhow::ensure!(
                    (owner_id.len() == 32 || (step.starts_with("v2-") && owner_id.len() == 64))
                        && owner_id.bytes().all(|byte| byte.is_ascii_hexdigit()),
                    "child ready owner id malformed"
                );
                return Ok((step, owner_id));
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        if let Some(status) = child.process.try_wait()? {
            anyhow::bail!("init crash child exited before ready (status {status})");
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "init crash child readiness timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn start_and_kill_init_at(step: &str) -> Result<(TempDir, Scope, String)> {
    let (temp, service, scope) = fixture(owner_limit());
    drop(service);
    let mut child = spawn_init_crash_child(temp.path(), step)?;
    let (ready_step, owner_id) = wait_for_init_crash_ready(&mut child, temp.path())?;
    anyhow::ensure!(
        ready_step == step,
        "child paused at an unexpected init step"
    );
    let status = child.kill_and_wait()?;
    anyhow::ensure!(!status.success(), "SIGKILL child unexpectedly succeeded");
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        anyhow::ensure!(
            status.signal() == Some(libc::SIGKILL),
            "child did not terminate from SIGKILL"
        );
    }
    Ok((temp, scope, owner_id))
}

fn stored_owner(service: &RetentionService, id: &str) -> Result<Owner> {
    service
        .store
        .transaction()?
        .read(Area::Owners, id)?
        .context("crash fixture owner missing")
}

fn owner_charge_state(service: &RetentionService, epoch: u64) -> Result<(u64, u64, u64)> {
    let tx = service.store.transaction()?;
    let epoch = tx
        .state
        .epochs
        .get(&epoch)
        .context("crash fixture epoch missing")?
        .nonterminal_allocations;
    Ok((
        tx.state.charges.owners,
        epoch,
        tx.state.charges.owner_proofs,
    ))
}

fn assert_missing_child(parent: &PrivateDirectory, name: &str) {
    let error = parent
        .open_child(OsStr::new(name), false)
        .expect_err("fixture child must be absent");
    assert!(missing(&error), "unexpected child absence error: {error:#}");
}

fn assert_missing_regular(directory: &PrivateDirectory, name: &str) {
    let error = directory
        .open_regular_file(OsStr::new(name))
        .expect_err("fixture leaf must be absent");
    assert!(missing(&error), "unexpected leaf absence error: {error:#}");
}

fn assert_partial_initializer_files(
    service: &RetentionService,
    owner_id: &str,
    step: &str,
    foreign_marker: bool,
) -> Result<()> {
    let leases = service.store.leases()?;
    let data = service.store.data()?;
    let lease_dir = leases.open_child(OsStr::new(owner_id), false)?;
    match step {
        "lease-directory" => {
            assert_missing_regular(&lease_dir, "lock");
            assert_missing_child(&data, owner_id);
        }
        "lock-leaf" | "lease-acquired" => {
            lease_dir.open_regular_file(OsStr::new("lock"))?;
            assert_missing_child(&data, owner_id);
        }
        "data-directory" => {
            lease_dir.open_regular_file(OsStr::new("lock"))?;
            let data_dir = data.open_child(OsStr::new(owner_id), false)?;
            if foreign_marker {
                data_dir.open_regular_file(OsStr::new("marker"))?;
            } else {
                assert_missing_regular(&data_dir, "marker");
            }
        }
        "marker" => {
            lease_dir.open_regular_file(OsStr::new("lock"))?;
            data.open_child(OsStr::new(owner_id), false)?
                .open_regular_file(OsStr::new("marker"))?;
        }
        _ => anyhow::bail!("not a partial initializer step: {step}"),
    }
    Ok(())
}

#[test]
fn retention_owner_init_crash_child_helper() -> Result<()> {
    if std::env::var_os(INIT_CRASH_CHILD_ARM_ENV).as_deref()
        != Some(OsStr::new(INIT_CRASH_CHILD_ARM_VALUE))
    {
        return Ok(());
    }
    let root = PathBuf::from(
        std::env::var_os(INIT_CRASH_CHILD_ROOT_ENV).context("armed child fixture root missing")?,
    );
    anyhow::ensure!(root.is_absolute(), "child fixture root must be absolute");
    let service = RetentionService::open(&root.join("account"), true, owner_limit())?;
    let scope = fixture_scope(&service);
    let step = std::env::var(INIT_CRASH_CHILD_STEP_ENV)?;
    if step.starts_with("v2-") {
        let request = owner_init_v2_tests::request("crash-owner");
        let created = service.create_owner_with_request(&scope, &request)?;
        let lease = created.lease.context("new v2 owner lease missing")?;
        if step.starts_with("v2-retire-") {
            service.retire_owner(&scope, &lease)?;
        }
    } else {
        let _lease = service.create_owner(&scope)?;
    }
    anyhow::bail!("requested owner initialization crash hook was not reached");
}

fn assert_unresolved_allocating_owner(
    service: &RetentionService,
    scope: &Scope,
    owner_id: &str,
    epoch: u64,
) -> Result<()> {
    let owner = stored_owner(service, owner_id)?;
    assert_eq!(owner.id, owner_id);
    assert_eq!(owner.scope, *scope);
    assert_eq!(owner.phase, OwnerPhase::Allocating);
    assert!(owner.data_identity.is_none());
    assert!(owner.marker_identity.is_none());
    assert!(owner.lease_directory_identity.is_none());
    assert!(owner.lease_identity.is_none());
    assert_eq!(owner_charge_state(service, epoch)?, (1, 1, 0));
    assert!(service.recover_owner(scope, owner_id).is_err());
    assert!(
        service
            .cancel_owner_without_leaves(scope, owner_id)
            .is_err()
    );
    assert_eq!(owner_charge_state(service, epoch)?, (1, 1, 0));
    assert!(service.create_owner(scope).is_err());
    assert_eq!(owner_charge_state(service, epoch)?, (1, 1, 0));
    Ok(())
}

#[test]
fn retention_owner_init_baseline_diagnostic_crash_invariants() -> Result<()> {
    // This diagnostic describes the current limitation: a reservation with no
    // leaves can be refunded, while any partially created owner stays charged
    // and cannot be recovered or refunded. It does not claim goal completion.
    let (temp, scope, owner_id) = start_and_kill_init_at("reservation")?;
    let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let owner = stored_owner(&service, &owner_id)?;
    assert_eq!(owner.id, owner_id);
    assert_eq!(owner.scope, scope);
    assert_eq!(owner.phase, OwnerPhase::Allocating);
    assert!(owner.data_identity.is_none());
    assert!(owner.marker_identity.is_none());
    assert!(owner.lease_directory_identity.is_none());
    assert!(owner.lease_identity.is_none());
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 0));
    assert_missing_child(&service.store.leases()?, &owner_id);
    assert_missing_child(&service.store.data()?, &owner_id);
    service.cancel_owner_without_leaves(&scope, &owner_id)?;
    service.cancel_owner_without_leaves(&scope, &owner_id)?;
    assert_eq!(
        stored_owner(&service, &owner_id)?.phase,
        OwnerPhase::Cancelled
    );
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (0, 0, 1));
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (0, 0, 1));
    let replacement = reopened.create_owner(&scope)?;
    assert_ne!(
        replacement.id, owner_id,
        "cancelled owner identity is not reused"
    );
    drop(replacement);

    for step in [
        "lease-directory",
        "lock-leaf",
        "lease-acquired",
        "data-directory",
        "marker",
    ] {
        let (temp, scope, owner_id) = start_and_kill_init_at(step)?;
        let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        let owner = stored_owner(&service, &owner_id)?;
        assert_unresolved_allocating_owner(&service, &scope, &owner_id, owner.epoch)?;
        assert_partial_initializer_files(&service, &owner_id, step, false)?;
        drop(service);
        let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (1, 1, 0));
        assert_eq!(
            stored_owner(&reopened, &owner_id)?.phase,
            OwnerPhase::Allocating
        );
    }

    // A foreign marker in the private test fixture is not proof that the
    // allocating owner created it, and cannot authorize refund or reuse.
    let (temp, scope, owner_id) = start_and_kill_init_at("data-directory")?;
    let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let owner = stored_owner(&service, &owner_id)?;
    let data_dir = service
        .store
        .data()?
        .open_child(OsStr::new(&owner_id), false)?;
    data_dir.atomic_replace(OsStr::new("marker"), b"foreign-marker-fixture")?;
    drop(data_dir);
    assert_unresolved_allocating_owner(&service, &scope, &owner_id, owner.epoch)?;
    assert_partial_initializer_files(&service, &owner_id, "data-directory", true)?;
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (1, 1, 0));
    assert_eq!(
        stored_owner(&reopened, &owner_id)?.phase,
        OwnerPhase::Allocating
    );

    let (temp, scope, owner_id) = start_and_kill_init_at("active-commit")?;
    let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let owner = stored_owner(&service, &owner_id)?;
    assert_eq!(owner.id, owner_id);
    assert_eq!(owner.scope, scope);
    assert_eq!(owner.phase, OwnerPhase::Active);
    assert!(owner.data_identity.is_some());
    assert!(owner.marker_identity.is_some());
    assert!(owner.lease_directory_identity.is_some());
    assert!(owner.lease_identity.is_some());
    service.owner_data(&owner)?;
    let recovered = service
        .recover_owner(&scope, &owner_id)?
        .context("active child owner must recover after SIGKILL")?;
    assert_eq!(recovered.id, owner_id);
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 0));
    drop(recovered);
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let recovered = reopened
        .recover_owner(&scope, &owner_id)?
        .context("active owner identity must survive another restart")?;
    reopened.owner_data(&stored_owner(&reopened, &owner_id)?)?;
    assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (1, 1, 0));
    drop(recovered);
    Ok(())
}

fn upload(
    service: &RetentionService,
    scope: &Scope,
    lease: &OwnerLease,
    id: &str,
) -> RetentionStageRefV1 {
    let payload = b"attachment payload";
    let entry = service
        .allocate_upload(scope, lease, id, payload.len() as u64, &digest(payload))
        .unwrap();
    service
        .seal_bytes(scope, lease, &entry.id, payload)
        .unwrap()
}
fn reserve(
    service: &RetentionService,
    scope: &Scope,
    reference: RetentionStageRefV1,
) -> RetentionReceiptV1 {
    service
        .reserve(
            scope,
            &wire_id(service.namespace(), reference.epoch),
            "thread-a",
            &[reference],
        )
        .unwrap()
}
#[test]
fn retention_ledger_restarts_with_ready_receipt_and_preserved_data() {
    let (temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload-a");
    let receipt = reserve(&service, &scope, reference.clone());
    assert!(service.recover_owner(&scope, &lease.id).unwrap().is_none());
    drop(lease);
    let reopened =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert_eq!(reopened.namespace(), service.namespace());
    let recovered = reopened
        .recover_owner(&scope, &reference.owner_id)
        .unwrap()
        .unwrap();
    let result = reopened
        .read(
            &scope,
            &RetentionReceiptSelectorV1::ClientRequestId {
                client_request_id: receipt.client_request_id.clone(),
            },
        )
        .unwrap();
    assert_eq!(result.receipt, Some(receipt));
    let owner = {
        let tx = reopened.store.transaction().unwrap();
        reopened.leased_owner(&tx, &scope, &recovered).unwrap()
    };
    let data = reopened.owner_data(&owner).unwrap();
    let entry: Entry = reopened
        .store
        .transaction()
        .unwrap()
        .read(Area::Entries, &reference.entry_id)
        .unwrap()
        .unwrap();
    data.open_verified_child(
        OsStr::new(&entry.id),
        entry.directory_identity.as_ref().unwrap(),
    )
    .unwrap()
    .open_verified_regular(
        OsStr::new("payload"),
        entry.payload_identity.as_ref().unwrap(),
    )
    .unwrap();
}
#[test]
fn retention_upload_finish_and_reserve_ack_loss_reuses_exact_ids() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "stable-upload");
    assert_eq!(upload(&service, &scope, &lease, "stable-upload"), reference);
    assert!(
        service
            .allocate_upload(&scope, &lease, "stable-upload", 5, &digest(b"other"))
            .is_err()
    );
    let receipt = reserve(&service, &scope, reference.clone());
    let replay = service
        .reserve(
            &scope,
            &receipt.client_request_id,
            "thread-a",
            std::slice::from_ref(&reference),
        )
        .unwrap();
    assert_eq!(replay, receipt);
    assert!(
        service
            .reserve(
                &scope,
                &receipt.client_request_id,
                "thread-b",
                std::slice::from_ref(&reference)
            )
            .is_err()
    );
    assert!(
        service
            .reserve(
                &scope,
                &wire_id(service.namespace(), reference.epoch),
                "thread-a",
                &[reference]
            )
            .is_err()
    );
}
#[test]
fn retention_global_budget_spans_workspace_and_recovery_is_not_recharged() {
    let limits = Limits {
        receipt_slots: 1,
        ..Default::default()
    };
    let (temp, service, scope) = fixture(limits.clone());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload-a");
    let receipt = reserve(&service, &scope, reference);
    let scope_b = service
        .scope(&scope.context, &digest(b"different workspace"))
        .unwrap();
    let owner_b = service.create_owner(&scope_b).unwrap();
    assert!(
        service
            .allocate_upload(&scope_b, &owner_b, "upload-b", 2, &digest(b"ab"))
            .is_err()
    );
    drop(owner_b);
    drop(lease);
    let service = RetentionService::open(&temp.path().join("account"), true, limits).unwrap();
    assert_eq!(
        service
            .read(
                &scope,
                &RetentionReceiptSelectorV1::RetentionId {
                    retention_id: receipt.retention_id
                }
            )
            .unwrap()
            .receipt
            .unwrap()
            .state,
        RetentionReceiptStateV1::Ready
    );
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .receipt_slots,
        1
    );
}
#[test]
fn retention_redo_recovers_crash_before_any_projection_without_null_or_duplicate() {
    let (temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let id = wire_id(service.namespace(), reference.epoch);
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    assert!(
        service
            .reserve(&scope, &id, "thread-a", std::slice::from_ref(&reference))
            .is_err()
    );
    drop(lease);
    let reopened =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    let receipt = reopened
        .read(
            &scope,
            &RetentionReceiptSelectorV1::ClientRequestId {
                client_request_id: id.clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(
        reopened
            .reserve(&scope, &id, "thread-a", &[reference])
            .unwrap(),
        receipt
    );
}
#[test]
fn retention_missing_lease_and_scope_change_never_claim_old_owner() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference);
    let mut changed = scope.context.clone();
    changed.authorization_generation = "another-account-login".into();
    let other_scope = service.scope(&changed, &scope.workspace_identity).unwrap();
    assert!(
        service
            .read(
                &other_scope,
                &RetentionReceiptSelectorV1::RetentionId {
                    retention_id: receipt.retention_id
                }
            )
            .is_err()
    );
    let owner_id = lease.id.clone();
    drop(lease);
    let owner: Owner = service
        .store
        .transaction()
        .unwrap()
        .read(Area::Owners, &owner_id)
        .unwrap()
        .unwrap();
    let directory = service
        .store
        .leases()
        .unwrap()
        .open_verified_child(
            OsStr::new(&owner_id),
            owner.lease_directory_identity.as_ref().unwrap(),
        )
        .unwrap();
    directory.remove_regular_file(OsStr::new("lock")).unwrap();
    assert!(service.recover_owner(&scope, &owner_id).is_err());
    assert!(directory.open_regular_file(OsStr::new("lock")).is_err());
}
#[test]
fn retention_original_owner_release_and_consume_are_durable_and_idempotent() {
    let (temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference);
    let released = service
        .release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)
        .unwrap();
    assert_eq!(released.state, RetentionReceiptStateV1::Released);
    let ack = RetentionConsumeAckV1 {
        retention_id: receipt.retention_id,
        terminal_revision: released.revision,
        client_ack_id: "local-durable-retire-a".into(),
    };
    assert_eq!(
        service.consume(&scope, &ack, &NoAcceptedTurnProof).unwrap(),
        RetentionConsumeStatusV1::Consumed
    );
    drop(lease);
    let reopened =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert_eq!(
        reopened
            .consume(&scope, &ack, &NoAcceptedTurnProof)
            .unwrap(),
        RetentionConsumeStatusV1::Consumed
    );
    let tx = reopened.store.transaction().unwrap();
    assert_eq!(tx.state.charges.staged_bytes, 0);
    assert_eq!(tx.state.charges.receipt_slots, 0);
    assert_eq!(tx.state.charges.tombstones, 1);
}
#[test]
fn retention_quarantined_phase_recovers_unlink_before_terminal_journal() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    reserve(&service, &scope, reference.clone());
    let (owner, mut entry) = {
        let tx = service.store.transaction().unwrap();
        (
            service.leased_owner(&tx, &scope, &lease).unwrap(),
            tx.read::<Entry>(Area::Entries, &reference.entry_id)
                .unwrap()
                .unwrap(),
        )
    };
    entry.phase = EntryPhase::RenamePending;
    service.entry_commit(&scope, &lease, &entry).unwrap();
    let data = service.owner_data(&owner).unwrap();
    data.quarantine_verified_entry(
        OsStr::new(&entry.id),
        entry.directory_identity.as_ref().unwrap(),
        OsStr::new(&entry.quarantine),
    )
    .unwrap();
    entry.phase = EntryPhase::Quarantined;
    service.entry_commit(&scope, &lease, &entry).unwrap();
    let q = data
        .open_verified_child(
            OsStr::new(&entry.quarantine),
            entry.directory_identity.as_ref().unwrap(),
        )
        .unwrap();
    let outcome = q
        .remove_verified_manifest(&[PrivateRemovalEntry {
            name: "payload".into(),
            identity: entry.payload_identity.clone().unwrap(),
        }])
        .unwrap();
    assert!(outcome.failure.is_none());
    // Simulated crash after unlink: durable journal still Quarantined.
    service.release_entry(&scope, &lease, &entry.id).unwrap();
    let restored: Entry = service
        .store
        .transaction()
        .unwrap()
        .read(Area::Entries, &entry.id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.phase, EntryPhase::Released);
}
#[test]
fn retention_ephemeral_and_corrupt_account_state_fail_closed() {
    let (temp, service, _) = fixture(Limits::default());
    assert!(
        RetentionService::open(&temp.path().join("account"), false, Limits::default()).is_err()
    );
    service.store.inject_state(b"corrupt").unwrap();
    assert!(RetentionService::open(&temp.path().join("account"), true, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(temp.path().join("account/attachment-retention-v1/state")).unwrap(),
        b"corrupt"
    );
}
#[test]
fn retention_unknown_oldest_epochs_block_instead_of_clearing_records() {
    let limits = Limits {
        epoch_allocations: 1,
        epochs: 2,
        ..Default::default()
    };
    let (_temp, service, scope) = fixture(limits);
    let first = service.create_owner(&scope).unwrap();
    let second = service.create_owner(&scope).unwrap();
    assert!(service.create_owner(&scope).is_err());
    let tx = service.store.transaction().unwrap();
    assert_eq!(tx.state.charges.owners, 2);
    assert_eq!(tx.state.epochs.len(), 2);
    assert_eq!(
        service.leased_owner(&tx, &scope, &first).unwrap().phase,
        OwnerPhase::Active
    );
    assert_eq!(
        service.leased_owner(&tx, &scope, &second).unwrap().phase,
        OwnerPhase::Active
    );
}
#[test]
fn retention_unknown_and_transferred_without_exact_turn_proof_cannot_consume() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference.clone());
    let ack = RetentionConsumeAckV1 {
        retention_id: receipt.retention_id.clone(),
        terminal_revision: receipt.revision,
        client_ack_id: "retire".into(),
    };
    assert!(service.consume(&scope, &ack, &NoAcceptedTurnProof).is_err());
    // A simulated transferred projection alone, without the private exact
    // authoritative acceptance adapter, must never be a consume proof.
    let mut tx = service.store.transaction().unwrap();
    let mut entry: Entry = tx
        .read(Area::Entries, &reference.entry_id)
        .unwrap()
        .unwrap();
    entry.phase = EntryPhase::Transferred;
    entry.transfer = Some(TransferBinding {
        thread_id: "thread-a".into(),
        client_message_id: "message-a".into(),
        attempt_id: "attempt-a".into(),
        input_sha256: digest(b"input"),
        artifact_identity: entry.payload_identity.clone().unwrap(),
        artifact_sha256: entry.content_sha256.clone(),
        artifact_size: entry.size,
    });
    let mut stored: Receipt = tx
        .read(Area::Receipts, &receipt.retention_id)
        .unwrap()
        .unwrap();
    stored.wire.state = RetentionReceiptStateV1::Transferred;
    tx.put(Area::Entries, &entry.id, entry.epoch, &entry)
        .unwrap();
    tx.put(Area::Receipts, &receipt.retention_id, stored.epoch, &stored)
        .unwrap();
    tx.commit().unwrap();
    assert!(service.consume(&scope, &ack, &NoAcceptedTurnProof).is_err());
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .receipt_slots,
        1
    );
}
fn expect_sync_eio(result: Result<impl Sized>) {
    let error = result.err().expect("injected pre-fsync EIO must fail");
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .and_then(|error| error.raw_os_error()),
        Some(libc::EIO),
        "expected injected pre-fsync EIO; actual error: {error:#}"
    );
}
#[test]
fn retention_redo_visible_rename_must_sync_before_state_or_journal_commit() {
    let (temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let directory = service.store.testing_area(Area::Entries).unwrap();
    let path = temp.path().join("account/attachment-retention-v1");
    let prior_state = std::fs::read(path.join("state")).unwrap();
    let mut tx = service.store.transaction().unwrap();
    let mut entry: Entry = tx
        .read(Area::Entries, &reference.entry_id)
        .unwrap()
        .unwrap();
    entry.phase = EntryPhase::Unknown;
    tx.put(Area::Entries, &entry.id, entry.epoch, &entry)
        .unwrap();
    directory.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(tx.commit()); // Actual rename is visible; its fsync was skipped.
    let visible: Entry = serde_json::from_slice(
        &std::fs::read(path.join("entries").join(storage::leaf(&entry.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(visible.phase, EntryPhase::Unknown);
    assert_eq!(std::fs::read(path.join("state")).unwrap(), prior_state);
    assert!(path.join("transaction").is_file());
    directory.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.store.transaction()); // current==next must retry fsync.
    assert_eq!(std::fs::read(path.join("state")).unwrap(), prior_state);
    assert!(path.join("transaction").is_file());
    let reopened =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert!(!path.join("transaction").exists());
    let tx = reopened.store.transaction().unwrap();
    assert_eq!(
        tx.read::<Entry>(Area::Entries, &entry.id)
            .unwrap()
            .unwrap()
            .phase,
        EntryPhase::Unknown
    );
    assert_eq!(tx.state.charges.receipt_slots, 1);
}
#[test]
fn retention_redo_visible_unlink_must_sync_before_state_or_journal_commit() {
    let (temp, service, _) = fixture(Limits::default());
    let mut tx = service.store.transaction().unwrap();
    tx.put(
        Area::Index,
        "test-unlink-projection",
        1,
        &IndexPage::default(),
    )
    .unwrap();
    tx.commit().unwrap();
    let path = temp.path().join("account/attachment-retention-v1");
    let prior_state = std::fs::read(path.join("state")).unwrap();
    let directory = service.store.testing_area(Area::Index).unwrap();
    let mut tx = service.store.transaction().unwrap();
    tx.delete_record_for_test(Area::Index, "test-unlink-projection")
        .unwrap();
    directory.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(tx.commit()); // Actual unlink before failed directory fsync.
    assert!(
        !path
            .join("index")
            .join(storage::leaf("test-unlink-projection"))
            .exists()
    );
    assert_eq!(std::fs::read(path.join("state")).unwrap(), prior_state);
    directory.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.store.transaction()); // current==next==None.
    assert_eq!(std::fs::read(path.join("state")).unwrap(), prior_state);
    assert!(path.join("transaction").is_file());
    RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert!(!path.join("transaction").exists());
}
#[test]
fn retention_failed_rename_sync_never_quarantines_or_unlinks_until_parent_sync() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference.clone());
    let owner = {
        let tx = service.store.transaction().unwrap();
        service.leased_owner(&tx, &scope, &lease).unwrap()
    };
    let data = service.owner_data(&owner).unwrap();
    data.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.release_original_owner(
        &scope,
        &lease,
        &receipt.retention_id,
        receipt.revision,
    ));
    let entry: Entry = service
        .store
        .transaction()
        .unwrap()
        .read(Area::Entries, &reference.entry_id)
        .unwrap()
        .unwrap();
    assert_eq!(entry.phase, EntryPhase::RenamePending);
    assert!(data.open_child(OsStr::new(&entry.id), false).is_err());
    let quarantine = data
        .open_verified_child(
            OsStr::new(&entry.quarantine),
            entry.directory_identity.as_ref().unwrap(),
        )
        .unwrap();
    quarantine
        .open_verified_regular(
            OsStr::new("payload"),
            entry.payload_identity.as_ref().unwrap(),
        )
        .unwrap();
    data.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.release_original_owner(
        &scope,
        &lease,
        &receipt.retention_id,
        receipt.revision,
    ));
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .read::<Entry>(Area::Entries, &entry.id)
            .unwrap()
            .unwrap()
            .phase,
        EntryPhase::RenamePending
    );
    quarantine
        .open_verified_regular(
            OsStr::new("payload"),
            entry.payload_identity.as_ref().unwrap(),
        )
        .unwrap();
    // Now parent sync succeeds and Quarantined is committed, but actual payload
    // unlink is followed by an injected pre-fsync EIO in the quarantine directory.
    quarantine.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.release_original_owner(
        &scope,
        &lease,
        &receipt.retention_id,
        receipt.revision,
    ));
    assert!(quarantine.open_regular_file(OsStr::new("payload")).is_err());
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .read::<Entry>(Area::Entries, &entry.id)
            .unwrap()
            .unwrap()
            .phase,
        EntryPhase::Quarantined
    );
    quarantine.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.release_original_owner(
        &scope,
        &lease,
        &receipt.retention_id,
        receipt.revision,
    ));
    let tx = service.store.transaction().unwrap();
    assert_eq!(
        tx.read::<Entry>(Area::Entries, &entry.id)
            .unwrap()
            .unwrap()
            .phase,
        EntryPhase::Quarantined
    );
    assert_eq!(tx.state.charges.staged_bytes, entry.size);
    drop(tx);
    assert_eq!(
        service
            .release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)
            .unwrap()
            .state,
        RetentionReceiptStateV1::Released
    );
}
#[test]
fn retention_missing_projection_by_both_ids_is_reconciliation_not_absence() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference);
    let unknown = service
        .read(
            &scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: wire_id(service.namespace(), 1),
            },
        )
        .unwrap();
    assert!(unknown.receipt.is_none() && unknown.epoch_retired.is_none());
    let entries = service.store.transaction().unwrap().state.charges.entries;
    service
        .store
        .testing_area(Area::Receipts)
        .unwrap()
        .remove_regular_file(OsStr::new(&storage::leaf(&receipt.retention_id)))
        .unwrap();
    let selectors = [
        RetentionReceiptSelectorV1::ClientRequestId {
            client_request_id: receipt.client_request_id.clone(),
        },
        RetentionReceiptSelectorV1::RetentionId {
            retention_id: receipt.retention_id.clone(),
        },
    ];
    for selector in &selectors {
        assert!(
            service
                .read(&scope, selector)
                .err()
                .unwrap()
                .to_string()
                .contains("reconciliation")
        );
    }
    // Simulate loss of the inverse index too: bounded, previously registered
    // entry authority still proves this issued ID is not absent.
    service
        .store
        .testing_area(Area::Intents)
        .unwrap()
        .remove_regular_file(OsStr::new(&storage::leaf(&format!(
            "retention:{}",
            receipt.retention_id
        ))))
        .unwrap();
    service
        .store
        .testing_area(Area::Intents)
        .unwrap()
        .remove_regular_file(OsStr::new(&storage::leaf(&intent_key(
            &scope,
            &receipt.client_request_id,
        ))))
        .unwrap();
    {
        let tx = service.store.transaction().unwrap();
        assert!(
            tx.read::<Intent>(
                Area::Intents,
                &intent_key(&scope, &receipt.client_request_id)
            )
            .unwrap()
            .is_none()
        );
        assert!(
            tx.read::<Intent>(
                Area::Intents,
                &format!("retention:{}", receipt.retention_id)
            )
            .unwrap()
            .is_none()
        );
        let entry: Entry = tx
            .read(Area::Entries, &receipt.entries[0].stage_ref.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            entry.retention_id.as_deref(),
            Some(receipt.retention_id.as_str())
        );
        // Both Intent records are gone. This successful bound-scope lookup
        // comes from the registered Entry itself, not a missing-Intent error.
        assert_eq!(
            tx.registered_binding_scope(entry.epoch, &selectors[1])
                .unwrap(),
            Some(scope.hash.clone())
        );
    }
    assert!(
        service
            .read(&scope, &selectors[1])
            .err()
            .unwrap()
            .to_string()
            .contains("reconciliation")
    );
    assert_eq!(
        service.store.transaction().unwrap().state.charges.entries,
        entries
    );
}
#[test]
fn retention_release_unknown_child_does_not_quarantine_or_unlink_any_payload() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "upload");
    let receipt = reserve(&service, &scope, reference.clone());
    let (owner, entry) = {
        let tx = service.store.transaction().unwrap();
        (
            service.leased_owner(&tx, &scope, &lease).unwrap(),
            tx.read::<Entry>(Area::Entries, &reference.entry_id)
                .unwrap()
                .unwrap(),
        )
    };
    let data = service.owner_data(&owner).unwrap();
    let directory = data
        .open_verified_child(
            OsStr::new(&entry.id),
            entry.directory_identity.as_ref().unwrap(),
        )
        .unwrap();
    directory
        .atomic_replace(OsStr::new("unregistered"), b"preserve this object")
        .unwrap();
    assert!(
        service
            .release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)
            .err()
            .unwrap()
            .to_string()
            .contains("unknown children")
    );
    directory
        .open_verified_regular(
            OsStr::new("payload"),
            entry.payload_identity.as_ref().unwrap(),
        )
        .unwrap();
    assert!(
        directory
            .open_regular_file(OsStr::new("unregistered"))
            .is_ok()
    );
    assert!(
        data.open_child(OsStr::new(&entry.quarantine), false)
            .is_err()
    );
    let tx = service.store.transaction().unwrap();
    assert_eq!(
        tx.read::<Entry>(Area::Entries, &entry.id)
            .unwrap()
            .unwrap()
            .phase,
        EntryPhase::ReleasePending
    );
    assert_eq!(tx.state.charges.staged_bytes, entry.size);
}
#[test]
fn retention_pre_sync_failure_is_one_shot_exact_directory_and_thread() {
    let (_temp, service, _) = fixture(Limits::default());
    let wanted = service.store.testing_area(Area::Entries).unwrap();
    let other = service.store.testing_area(Area::Owners).unwrap();
    wanted.inject_pre_sync_failure_once().unwrap();
    other.sync().unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| wanted.sync().unwrap()).join().unwrap();
    });
    expect_sync_eio(wanted.sync());
    wanted.sync().unwrap();
}

#[path = "upload_producer_review.rs"]
mod upload_producer_review;

#[path = "reserve_failure_review.rs"]
mod reserve_failure_review;
