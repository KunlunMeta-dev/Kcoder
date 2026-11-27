use super::*;
struct OwnedBudgetChild(std::process::Child);
impl OwnedBudgetChild {
    fn finish(&mut self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned budget child exceeded deadline"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedBudgetChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
#[test]
fn budget_worker() {
    let Ok(root) = std::env::var("KCODER_BUDGET_OWNED_TEST_ROOT") else {
        return;
    };
    let id = std::env::var("KCODER_BUDGET_OWNED_TEST_ID").unwrap();
    let root = PathBuf::from(root);
    for _ in 0..500 {
        if root.join("go").exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(root.join("go").exists());
    let store = NativeBudgetStore::open_in(
        &PrivateDirectory::open_existing(&root).unwrap(),
        OsStr::new("budgets"),
        &scope(),
    )
    .unwrap()
    .unwrap();
    let mut proposed = request(&id, 70);
    if std::env::var("KCODER_BUDGET_OWNED_TEST_DISTINCT_MEMBER").as_deref() == Ok("1") {
        proposed.principal = NativeBudgetPrincipal::from_native_facts(
            id.clone(),
            Some("organization".into()),
            Some(format!("workspace-{id}")),
            None,
        )
        .unwrap();
        proposed.task.root_operation_id = format!("member-operation-{id}");
    }
    let mut outcome = "busy";
    for _ in 0..200 {
        match store.reserve(&proposed, &[policy(1, 100, 4, "first")], 100) {
            Ok(_) => {
                outcome = "reserved";
                break;
            }
            Err(error) if error.to_string() == "BUDGET_BUSY" => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(error) if error.to_string() == "BUDGET_EXHAUSTED" => {
                outcome = "denied";
                break;
            }
            Err(error) => panic!("unexpected native budget error: {error}"),
        }
    }
    assert_ne!(outcome, "busy");
    std::fs::write(root.join(format!("result-{id}")), outcome).unwrap();
}
#[test]
fn independent_processes_cannot_both_reserve_the_same_remaining_balance() {
    concurrent_reservations(false);
}

#[test]
fn different_members_and_workspaces_share_one_original_organization_balance() {
    concurrent_reservations(true);
}

#[test]
fn atomic_budget_snapshot_survives_cross_process_journal_replacement() {
    use kcoder_config::PrivateLeaseMode;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    use std::{io::Read, path::Path};

    fn wait_for_marker(path: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !path.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "owned journal-replacement process did not reach its marker"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    if let Some(root) = std::env::var_os("KCODER_BUDGET_SNAPSHOT_TEST_ROOT") {
        let root = PathBuf::from(root);
        let directory = PrivateDirectory::open_existing(&root.join("budgets")).unwrap();
        let bytes = std::fs::read(root.join("budgets/ledger.json")).unwrap();
        let lock = directory
            .open_single_link_regular_file(OsStr::new("budgets.lock"))
            .unwrap();
        let lock_identity = directory.portable_regular_handle_identity(&lock).unwrap();
        let publish = || {
            let _lease = directory
                .try_existing_portable_lock(
                    OsStr::new("budgets.lock"),
                    &lock_identity,
                    PrivateLeaseMode::Exclusive,
                )
                .unwrap()
                .expect("the original journal lock must be available");
            directory
                .atomic_replace(OsStr::new("ledger.json"), &bytes)
                .unwrap();
        };
        publish();
        std::fs::write(root.join("snapshot-first-replaced"), b"ready").unwrap();
        wait_for_marker(&root.join("snapshot-race-start"));
        for _ in 0..128 {
            publish();
        }
        std::fs::write(root.join("snapshot-race-done"), b"done").unwrap();
        return;
    }

    let fixture = Fixture::new();
    let directory = PrivateDirectory::open_existing(&fixture.root.join("budgets")).unwrap();
    let mut original = directory
        .open_regular_file(OsStr::new("ledger.json"))
        .unwrap();
    #[cfg(unix)]
    assert_eq!(original.metadata().unwrap().nlink(), 1);
    let original_bytes = std::fs::read(fixture.root.join("budgets/ledger.json")).unwrap();
    let mut child = OwnedBudgetChild(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "integrations::core::budgets::tests::process_tests::atomic_budget_snapshot_survives_cross_process_journal_replacement",
                "--nocapture",
            ])
            .env("KCODER_BUDGET_SNAPSHOT_TEST_ROOT", &fixture.root)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for_marker(&fixture.root.join("snapshot-first-replaced"));
    #[cfg(unix)]
    assert_eq!(
        original.metadata().unwrap().nlink(),
        0,
        "the original opened inode is unlinked by the real child rename"
    );
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FILE_STANDARD_INFO, FileIdInfo,
            FileStandardInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        };
        let handle = original.as_raw_handle().cast();
        let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut standard: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
        let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: the original file owns a live handle and each output has the
        // size and alignment required by its corresponding Windows query.
        let basic_ok = unsafe { GetFileInformationByHandle(handle, &mut basic) } != 0;
        let standard_ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileStandardInfo,
                (&mut standard as *mut FILE_STANDARD_INFO).cast(),
                std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
            )
        } != 0;
        let id_ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0;
        println!(
            "held replaced file: basic_ok={basic_ok}, links={}, standard_ok={standard_ok}, standard_links={}, delete_pending={}, file_id_ok={id_ok}",
            basic.nNumberOfLinks, standard.NumberOfLinks, standard.DeletePending
        );
    }
    let mut held_bytes = Vec::new();
    original.read_to_end(&mut held_bytes).unwrap();
    assert_eq!(held_bytes, original_bytes);
    std::fs::write(fixture.root.join("snapshot-race-start"), b"go").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
    let mut reads = 0;
    let mut busy = 0;
    while !fixture.root.join("snapshot-race-done").exists() {
        match fixture.store.read_reservation("never-reserved") {
            Ok(None) => {}
            Err(error) if error.to_string() == "BUDGET_BUSY" => busy += 1,
            other => panic!("unexpected journal observation during replacement: {other:?}"),
        }
        reads += 1;
        assert!(
            std::time::Instant::now() < deadline,
            "owned journal-replacement race exceeded its deadline"
        );
    }
    child.finish();
    assert!(reads > 0, "the reader must overlap the child writer");
    assert!(
        fixture
            .store
            .read_reservation("never-reserved")
            .unwrap()
            .is_none()
    );
    println!("overlapping observations={reads}, bounded busy results={busy}");
}

#[test]
fn budget_ledger_header_and_lock_still_reject_hard_link_aliases() {
    let fixture = Fixture::new();
    for name in ["ledger.json", "owner.json", "budgets.lock"] {
        let alias = fixture.root.join(format!("alias-{name}"));
        std::fs::hard_link(fixture.root.join("budgets").join(name), &alias).unwrap();
        assert!(
            fixture.store.read_reservation("never-reserved").is_err(),
            "a multiply linked {name} must not be accepted"
        );
        std::fs::remove_file(alias).unwrap();
        assert!(
            fixture
                .store
                .read_reservation("never-reserved")
                .unwrap()
                .is_none()
        );
    }
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn deleting_the_data_after_snapshot_read_fails_without_recreating_it() {
    if let Some(root) = std::env::var_os("KCODER_BUDGET_DELETE_SNAPSHOT_ROOT") {
        std::fs::remove_file(PathBuf::from(root).join("budgets/ledger.json")).unwrap();
        return;
    }

    let fixture = Fixture::new();
    let root = fixture.root.clone();
    super::super::storage::after_snapshot_read_once(move || {
        let mut child = OwnedBudgetChild(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "integrations::core::budgets::tests::process_tests::deleting_the_data_after_snapshot_read_fails_without_recreating_it",
                ])
                .env("KCODER_BUDGET_DELETE_SNAPSHOT_ROOT", root)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        child.finish();
    });
    assert!(fixture.store.read_reservation("never-reserved").is_err());
    let path = fixture.root.join("budgets/ledger.json");
    assert!(!path.exists());
    assert!(
        fixture
            .store
            .install_policies(&[policy(1, 100, 4, "first")])
            .is_err()
    );
    assert!(
        !path.exists(),
        "a missing original ledger must not be recreated"
    );
}

fn concurrent_reservations(distinct_members: bool) {
    let fixture = Fixture::new();
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    for id in ["process-a", "process-b"] {
        children.push(OwnedBudgetChild(
            std::process::Command::new(&executable)
                .args([
                    "--exact",
                    "integrations::core::budgets::tests::process_tests::budget_worker",
                    "--nocapture",
                ])
                .env("KCODER_BUDGET_OWNED_TEST_ROOT", &fixture.root)
                .env("KCODER_BUDGET_OWNED_TEST_ID", id)
                .env(
                    "KCODER_BUDGET_OWNED_TEST_DISTINCT_MEMBER",
                    if distinct_members { "1" } else { "0" },
                )
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        ));
    }
    std::fs::write(fixture.root.join("go"), b"start").unwrap();
    for child in &mut children {
        child.finish();
    }
    let mut outcomes = [
        std::fs::read_to_string(fixture.root.join("result-process-a")).unwrap(),
        std::fs::read_to_string(fixture.root.join("result-process-b")).unwrap(),
    ];
    outcomes.sort();
    assert_eq!(outcomes, ["denied", "reserved"]);
    let observed = fixture
        .store
        .observe_policy(&policy(1, 100, 4, "first"))
        .unwrap()
        .unwrap();
    assert_eq!(observed.charged.tokens, 70);
    assert_eq!(observed.active_calls, 1);
}
