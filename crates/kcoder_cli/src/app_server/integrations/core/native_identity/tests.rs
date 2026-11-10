use super::*;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
};

fn scope(profile: &PrivateDirectory) -> Result<IntegrationScope> {
    let native = profile.directory_identity()?;
    let derive = |domain: &str| {
        let mut hash = Sha256::new();
        hash.update(b"kcoder-native-integrations-v1\0");
        hash.update(domain.as_bytes());
        hash.update([0]);
        hash.update(native.as_bytes());
        format!("native-{:x}", hash.finalize())
    };
    Ok(IntegrationScope {
        account_id: derive("account-profile"),
        target_id: derive("native-target"),
        workspace_id: IntegrationNullable::Null,
        identity_generation: "connection-does-not-own-epoch".into(),
        target_revision: "configuration-does-not-own-epoch".into(),
        organization_id: None,
    })
}
fn fixture() -> Result<(tempfile::TempDir, PrivateDirectory, IntegrationScope)> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(root.path())?;
    let scope = scope(&profile)?;
    Ok((root, profile, scope))
}
fn namespace(root: &Path, identity: &NativeIdentity) -> PathBuf {
    root.join(identity.guard.namespace_id())
}

#[test]
fn observation_is_pure_and_reconnect_restart_or_configuration_change_keeps_one_epoch() -> Result<()>
{
    let (root, profile, scope) = fixture()?;
    assert!(NativeIdentity::observe(&profile, &scope)?.is_none());
    assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
    let first = NativeIdentity::initialize(&profile, &scope, "real-first-handshake")?;
    let expected = first.snapshot(&profile)?;
    let mut reconnected = scope.clone();
    reconnected.identity_generation = "different-connection".into();
    reconnected.target_revision = "different-configuration".into();
    let second = NativeIdentity::observe(&profile, &reconnected)?.unwrap();
    assert_eq!(second.snapshot(&profile)?, expected);
    assert_eq!(
        NativeIdentity::initialize(&profile, &reconnected, "real-first-handshake")?
            .snapshot(&profile)?,
        expected
    );
    assert!(
        NativeIdentity::initialize(&profile, &reconnected, "unrelated-handshake-write").is_err()
    );
    drop(first);
    drop(second);
    drop(profile);
    let profile = PrivateDirectory::open_existing(root.path())?;
    assert_eq!(
        NativeIdentity::observe(&profile, &reconnected)?
            .unwrap()
            .snapshot(&profile)?,
        expected
    );
    assert_eq!(std::fs::read_dir(root.path())?.count(), 2);
    Ok(())
}

#[test]
fn disabled_epoch_invalidates_all_observers_and_same_original_intent_replays_with_new_clock()
-> Result<()> {
    let (root, profile, scope) = fixture()?;
    let first = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let second = NativeIdentity::observe(&profile, &scope)?.unwrap();
    let before = first.snapshot(&profile)?;
    let path = namespace(root.path(), &first);
    let original_record = first.header.record_identity.clone();
    let disabled = first.disable(&profile, "disable-original", before.revision, 1000)?;
    assert!(!disabled.enabled);
    assert_eq!(disabled.revision, 2);
    assert_ne!(disabled.generation, before.generation);
    assert_eq!(second.snapshot(&profile)?, disabled);
    assert_eq!(first.snapshot(&profile)?, disabled);
    let bytes = std::fs::read(path.join(RECORD))?;
    assert_eq!(
        first.disable(&profile, "disable-original", 1, 999_999)?,
        disabled
    );
    assert_eq!(std::fs::read(path.join(RECORD))?, bytes);
    assert_eq!(first.header.record_identity, original_record);
    assert!(
        first
            .disable(&profile, "disable-original", 2, 2000)
            .is_err()
    );
    assert!(first.disable(&profile, "another-disable", 2, 2000).is_err());
    drop(first);
    drop(second);
    let reopened = NativeIdentity::observe(&profile, &scope)?.unwrap();
    assert_eq!(reopened.snapshot(&profile)?, disabled);
    assert_eq!(
        NativeIdentity::initialize(&profile, &scope, "initialize")?.snapshot(&profile)?,
        disabled
    );
    Ok(())
}

#[test]
fn stale_cas_or_reusing_initialization_operation_never_changes_identity_bytes() -> Result<()> {
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let directory = namespace(root.path(), &identity);
    let record = std::fs::read(directory.join(RECORD))?;
    let head = std::fs::read(directory.join(HEAD))?;
    assert!(identity.disable(&profile, "disable", 0, 1000).is_err());
    assert!(identity.disable(&profile, "initialize", 1, 1000).is_err());
    assert_eq!(std::fs::read(directory.join(RECORD))?, record);
    assert_eq!(std::fs::read(directory.join(HEAD))?, head);
    assert!(identity.snapshot(&profile)?.enabled);
    Ok(())
}

#[test]
fn committed_disable_record_truncated_in_place_to_complete_genesis_never_reenables() -> Result<()> {
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let directory = identity.guard.directory(&profile)?;
    let genesis = std::fs::read(namespace(root.path(), &identity).join(RECORD))?;
    identity.disable(&profile, "disable", 1, 1000)?;
    let record = directory.open_read_write_file(OsStr::new(RECORD), false)?;
    let original_id = directory.portable_regular_handle_identity(&record)?;
    record.set_len(genesis.len() as u64)?;
    record.sync_all()?;
    assert_eq!(
        directory.portable_regular_handle_identity(&record)?,
        original_id
    );
    assert!(identity.snapshot(&profile).is_err());
    assert!(NativeIdentity::observe(&profile, &scope).is_err());
    assert!(NativeIdentity::initialize(&profile, &scope, "initialize").is_err());
    assert_eq!(
        std::fs::read(namespace(root.path(), &identity).join(RECORD))?,
        genesis
    );
    Ok(())
}

#[test]
fn head_truncated_to_complete_genesis_or_interrupted_after_witness_is_fail_closed() -> Result<()> {
    for interrupt in [false, true] {
        let (root, profile, scope) = fixture()?;
        let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
        let path = namespace(root.path(), &identity);
        let genesis = std::fs::read(path.join(HEAD))?;
        if interrupt {
            identity
                .stop_after_revocation_witness
                .store(true, Ordering::SeqCst);
            assert!(identity.disable(&profile, "disable", 1, 1000).is_err());
        } else {
            identity.disable(&profile, "disable", 1, 1000)?;
            let head = identity
                .guard
                .directory(&profile)?
                .open_read_write_file(OsStr::new(HEAD), false)?;
            head.set_len(genesis.len() as u64)?;
            head.sync_all()?;
        }
        assert!(identity.snapshot(&profile).is_err());
        assert!(NativeIdentity::observe(&profile, &scope).is_err());
        assert!(NativeIdentity::initialize(&profile, &scope, "fresh-handshake").is_err());
    }
    Ok(())
}

#[test]
fn missing_truncated_or_replaced_record_head_or_lock_is_never_adopted_or_repaired() -> Result<()> {
    for name in [RECORD, HEAD, LOCK] {
        for failure in ["missing", "truncated", "replaced"] {
            let (root, profile, scope) = fixture()?;
            let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
            let directory = identity.guard.directory(&profile)?;
            let path = namespace(root.path(), &identity).join(name);
            let bytes = std::fs::read(&path)?;
            match failure {
                "missing" => std::fs::remove_file(&path)?,
                "truncated" if name == LOCK => {
                    // Lock files contain no journal; replacement must still fail by native identity.
                    directory.atomic_replace(OsStr::new(name), b"")?;
                }
                "truncated" => {
                    let file = directory.open_read_write_file(OsStr::new(name), false)?;
                    file.set_len(1)?;
                    file.sync_all()?;
                }
                _ => directory.atomic_replace(OsStr::new(name), &bytes)?,
            }
            assert!(
                identity.snapshot(&profile).is_err(),
                "live observer accepted {name}/{failure}"
            );
            assert!(
                NativeIdentity::observe(&profile, &scope).is_err(),
                "fresh observer accepted {name}/{failure}"
            );
            assert!(NativeIdentity::initialize(&profile, &scope, "initialize").is_err());
            if failure == "missing" {
                assert!(!path.exists());
            }
        }
    }
    Ok(())
}

#[test]
fn other_profile_and_non_global_scope_do_not_inherit_identity() -> Result<()> {
    let (_root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let (_other, other_profile, _) = fixture()?;
    assert!(identity.snapshot(&other_profile).is_err());
    let mut workspace_scope = scope.clone();
    workspace_scope.workspace_id = IntegrationNullable::Value("workspace".into());
    assert!(NativeIdentity::observe(&other_profile, &workspace_scope).is_err());
    assert!(NativeIdentity::initialize(&other_profile, &workspace_scope, "operation").is_err());
    Ok(())
}

#[test]
fn lost_disable_ack_preserves_original_generation_receipt_after_reopen() -> Result<()> {
    let (_root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    identity.lose_disable_ack.store(true, Ordering::SeqCst);
    assert!(
        identity
            .disable(&profile, "disable", 1, 1000)
            .unwrap_err()
            .to_string()
            .contains("UNCONFIRMED")
    );
    let expected = identity.snapshot(&profile)?;
    assert!(!expected.enabled);
    let reopened = NativeIdentity::observe(&profile, &scope)?.unwrap();
    assert_eq!(reopened.disable(&profile, "disable", 1, 2000)?, expected);
    Ok(())
}

#[test]
fn concurrent_shared_snapshots_use_independent_record_cursors() -> Result<()> {
    let (_root, profile, scope) = fixture()?;
    let identity = Arc::new(NativeIdentity::initialize(&profile, &scope, "initialize")?);
    let expected = identity.snapshot(&profile)?;
    let profile = Arc::new(profile);
    let threads = (0..8)
        .map(|_| {
            let identity = identity.clone();
            let profile = profile.clone();
            let expected = expected.clone();
            std::thread::spawn(move || -> Result<()> {
                for _ in 0..32 {
                    ensure!(
                        identity.snapshot(&profile)? == expected,
                        "snapshot changed without write"
                    );
                }
                Ok(())
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().expect("reader thread panicked")?;
    }
    Ok(())
}

#[test]
fn warm_snapshot_rejects_oversized_current_record_or_head() -> Result<()> {
    for (name, code) in [
        (RECORD, "INTEGRATION_IDENTITY_RECORD_INVALID"),
        (HEAD, "INTEGRATION_IDENTITY_HEAD_INVALID"),
    ] {
        let (_root, profile, scope) = fixture()?;
        let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
        assert!(identity.snapshot(&profile)?.enabled);
        let file = identity
            .directory
            .open_read_write_file(OsStr::new(name), false)?;
        file.set_len(MAX_RECORD_BYTES + 1)?;
        assert!(
            identity
                .snapshot(&profile)
                .unwrap_err()
                .to_string()
                .contains(code)
        );
        assert_eq!(file.metadata()?.len(), MAX_RECORD_BYTES + 1);
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn held_identity_namespace_cannot_survive_replacement() -> Result<()> {
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let original = namespace(root.path(), &identity);
    let detached = root.path().join("detached-identity");
    std::fs::rename(&original, &detached)?;
    profile.create_private_child(OsStr::new(identity.guard.namespace_id()))?;
    assert!(identity.snapshot(&profile).is_err());
    assert!(NativeIdentity::observe(&profile, &scope).is_err());
    std::fs::remove_dir(&original)?;
    std::fs::rename(detached, original)?;
    assert!(identity.snapshot(&profile)?.enabled);
    Ok(())
}

#[cfg(windows)]
#[test]
fn pinned_namespace_blocks_rename_and_fresh_observer_rejects_replacement() -> Result<()> {
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let expected = identity.snapshot(&profile)?;
    let name = identity.guard.namespace_id().to_owned();
    let original = namespace(root.path(), &identity);
    let detached = root.path().join("detached-identity");
    let error = std::fs::rename(&original, &detached)
        .expect_err("Windows must keep the live identity namespace pinned");
    assert!(matches!(error.raw_os_error(), Some(5 | 32)));
    assert!(original.is_dir() && !detached.exists());
    assert_eq!(identity.snapshot(&profile)?, expected);

    // After the pin closes, a replacement must not acquire the original identity.
    drop(identity);
    std::fs::rename(&original, &detached)?;
    profile.create_private_child(OsStr::new(&name))?;
    assert!(NativeIdentity::observe(&profile, &scope).is_err());
    assert!(NativeIdentity::initialize(&profile, &scope, "initialize").is_err());
    Ok(())
}

#[test]
fn complete_initial_record_comparison_keeps_compatible_encodings_and_checks_the_head() -> Result<()>
{
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let expected = identity.snapshot(&profile)?;
    let directory = namespace(root.path(), &identity);
    let record = directory.join(RECORD);
    let head = directory.join(HEAD);
    let original_record = std::fs::read(&record)?;
    let original_head = std::fs::read(&head)?;

    let formatted = |bytes: &[u8]| [b" ".as_slice(), bytes].concat();
    std::fs::write(&head, formatted(&original_head))?;
    assert_eq!(identity.snapshot(&profile)?, expected);
    std::fs::write(&record, formatted(&original_record))?;
    assert_eq!(identity.snapshot(&profile)?, expected);

    std::fs::write(&record, &original_record)?;
    let mut invalid_head = identity.initial.head.clone();
    invalid_head.epoch_hash = "0".repeat(64);
    let mut bytes = Vec::new();
    append_json(&mut bytes, &invalid_head)?;
    std::fs::write(&head, bytes)?;
    assert!(identity.snapshot(&profile).is_err());

    std::fs::write(&head, &original_head)?;
    assert_eq!(identity.snapshot(&profile)?, expected);
    Ok(())
}

#[test]
fn real_child_process_reopens_the_original_epoch_before_and_after_permanent_disable() -> Result<()>
{
    const PROFILE_ENV: &str = "KCODER_NATIVE_IDENTITY_REOPEN_TEST_DIRECTORY";
    const EXPECTED_ENV: &str = "KCODER_NATIVE_IDENTITY_REOPEN_TEST_EXPECTED";
    if let Some(path) = std::env::var_os(PROFILE_ENV) {
        let profile = PrivateDirectory::open_existing(Path::new(&path))?;
        let scope = scope(&profile)?;
        let snapshot = NativeIdentity::observe(&profile, &scope)?
            .context("child observation unexpectedly missing")?
            .snapshot(&profile)?;
        let expected: serde_json::Value = serde_json::from_str(&std::env::var(EXPECTED_ENV)?)?;
        ensure!(
            serde_json::json!({"generation":snapshot.generation,"revision":snapshot.revision,
            "enabled":snapshot.enabled})
                == expected,
            "child read another identity epoch"
        );
        println!("NATIVE_IDENTITY_CHILD_OBSERVED");
        return Ok(());
    }
    let (root, profile, scope) = fixture()?;
    let identity = NativeIdentity::initialize(&profile, &scope, "initialize")?;
    let observe_in_child = |expected: NativeIdentitySnapshot| -> Result<()> {
        let test_name = format!(
            "{}::real_child_process_reopens_the_original_epoch_before_and_after_permanent_disable",
            module_path!().split_once("::").unwrap().1
        );
        let result = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", test_name.as_str(), "--nocapture"])
            .env(PROFILE_ENV, root.path())
            .env(
                EXPECTED_ENV,
                serde_json::to_string(&serde_json::json!({"generation":expected.generation,
                "revision":expected.revision,"enabled":expected.enabled}))?,
            )
            .output()?;
        ensure!(
            result.status.success()
                && String::from_utf8_lossy(&result.stdout)
                    .contains("NATIVE_IDENTITY_CHILD_OBSERVED"),
            "owned identity child did not verify its original epoch"
        );
        Ok(())
    };
    observe_in_child(identity.snapshot(&profile)?)?;
    let disabled = identity.disable(&profile, "disable", 1, 1000)?;
    observe_in_child(disabled)?;
    Ok(())
}
