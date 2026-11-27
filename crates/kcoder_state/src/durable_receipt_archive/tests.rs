use super::*;
use std::io::{Seek, SeekFrom, Write};
use std::{io::Read, process::Command};

fn initialized(root: &PrivateDirectory) -> Result<DurableReceiptArchiveBinding> {
    let binding =
        DurableReceiptArchiveBinding::reserve(root, "owned-archive-test", b"seed checkpoint")?;
    assert!(DurableReceiptArchive::open(root, &binding, false).is_err());
    DurableReceiptArchive::initialize(root, &binding, b"seed checkpoint")?;
    DurableReceiptArchive::initialize(root, &binding, b"seed checkpoint")?;
    Ok(binding)
}
fn row(key: &str) -> DurableReceiptArchiveRow {
    DurableReceiptArchiveRow {
        request_key: key.into(),
        message_id: format!("message-{key}"),
        body: format!("permanent exact receipt {key}").into_bytes(),
    }
}

#[test]
fn binding_convergence_archive_keeps_logical_receipts_and_original_setup_lock() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("receipt-archive-copy")?;
    let source =
        PrivateDirectory::open_existing(root.path())?.create_private_child(OsStr::new("source"))?;
    let binding = initialized(&source)?;
    let binding_bytes = serde_json::to_vec(&binding)?;
    let mut archive = DurableReceiptArchive::open(&source, &binding, true)?;
    archive.access(|tx| {
        tx.insert_with_payload(&row("original"), 100, b"unknown external outcome")?;
        tx.set_checkpoint(b"original committed checkpoint")
    })?;
    drop(archive);
    let target =
        PrivateDirectory::open_existing(root.path())?.create_private_child(OsStr::new("target"))?;
    let copied = target.create_private_child(OsStr::new(&binding.child))?;
    let source_path = root.path().join("source").join(&binding.child);
    let target_path = root.path().join("target").join(&binding.child);
    for entry in std::fs::read_dir(&source_path)? {
        let entry = entry?;
        std::fs::copy(entry.path(), target_path.join(entry.file_name()))?;
    }
    // The actual writer fence cannot be replaced by a byte-identical new lock.
    assert!(DurableReceiptArchive::open(&target, &binding, true).is_err());
    std::fs::remove_file(target_path.join(SETUP))?;
    std::fs::rename(source_path.join(SETUP), target_path.join(SETUP))?;
    let before = std::fs::read(target_path.join(DATABASE))?;
    let mut observed = DurableReceiptArchive::open(&target, &binding, false)?;
    observed.access(|tx| {
        assert_eq!(tx.checkpoint()?, b"original committed checkpoint");
        assert_eq!(tx.get("original")?.unwrap().body, row("original").body);
        assert_eq!(
            tx.payload("original")?.unwrap().1,
            b"unknown external outcome"
        );
        Ok(())
    })?;
    // Bootstrap cannot initialize a replacement original object after a move.
    assert!(DurableReceiptArchive::initialize(&target, &binding, b"seed checkpoint").is_err());
    let owner = std::fs::read(target_path.join(OWNER))?;
    copied.atomic_replace(OsStr::new(OWNER), &owner)?;
    assert!(observed.access(|_| Ok(())).is_err());
    drop(observed);
    let mut reopened = DurableReceiptArchive::open(&target, &binding, true)?;
    reopened.access(|tx| {
        assert!(!tx.insert(&row("original"))?);
        Ok(())
    })?;
    assert_eq!(std::fs::read(target_path.join(DATABASE))?, before);
    assert_eq!(serde_json::to_vec(&binding)?, binding_bytes);
    drop(reopened);
    let foreign = PrivateDirectory::open_existing(root.path())?
        .create_private_child(OsStr::new("foreign"))?;
    let other = initialized(&foreign)?;
    let bytes = std::fs::read(root.path().join("foreign").join(other.child).join(DATABASE))?;
    copied.atomic_replace(OsStr::new(DATABASE), &bytes)?;
    assert!(DurableReceiptArchive::open(&target, &binding, false).is_err());
    assert!(DurableReceiptArchive::open(&target, &binding, true).is_err());
    assert_eq!(std::fs::read(target_path.join(DATABASE))?, bytes);
    Ok(())
}

#[test]
fn checkpoint_and_tombstones_commit_or_rollback_together_and_payload_never_erases_ids() -> Result<()>
{
    let root = kcoder_config::create_private_temp_dir("receipt-archive-atomic")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    let mut archive = DurableReceiptArchive::open(&parent, &binding, true)?;
    let failed: Result<()> = archive.access(|tx| {
        tx.insert_with_payload(&row("aborted"), 100, b"original private body")?;
        tx.set_checkpoint(b"uncommitted")?;
        anyhow::bail!("owned injected failure before commit")
    });
    assert!(failed.is_err());
    archive.access(|tx| {
        assert!(tx.get("aborted")?.is_none());
        assert_eq!(tx.checkpoint()?, b"seed checkpoint");
        Ok(())
    })?;
    archive.access(|tx| {
        assert!(tx.insert_with_payload(&row("original"), 100, b"original private body")?);
        tx.set_checkpoint(b"advanced checkpoint")
    })?;
    assert!(DurableReceiptArchive::initialize(&parent, &binding, b"seed checkpoint").is_err());
    archive.access(|tx| {
        assert!(!tx.insert_with_payload(
            &row("original"),
            200,
            b"different body cannot extend retention"
        )?);
        assert_eq!(
            tx.payload("original")?.unwrap(),
            (100, b"original private body".to_vec())
        );
        assert_eq!(tx.purge_payloads(100, 1)?, 1);
        assert!(tx.payload("original")?.is_none());
        assert!(!tx.insert_with_payload(&row("original"), 300, b"cannot recreate retired body")?);
        assert!(tx.payload("original")?.is_none());
        assert_eq!(
            tx.get_by_message_id("message-original")?.unwrap().body,
            row("original").body
        );
        let mut conflict = row("original");
        conflict.body = b"a different operation".to_vec();
        assert!(tx.insert(&conflict).is_err());
        Ok(())
    })?;
    drop(archive);
    let database = root.path().join(&binding.child).join(DATABASE);
    let before = std::fs::read(&database)?;
    let mut observed = DurableReceiptArchive::open(&parent, &binding, false)?;
    for _ in 0..10 {
        observed.access(|tx| {
            assert_eq!(tx.checkpoint()?, b"advanced checkpoint");
            assert!(tx.get("original")?.is_some());
            Ok(())
        })?;
    }
    drop(observed);
    assert_eq!(
        std::fs::read(database)?,
        before,
        "ordinary observation never writes"
    );
    Ok(())
}

#[test]
fn large_archive_point_reads_are_bounded_and_missing_or_replaced_files_never_initialize_empty()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("receipt-archive-point")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    let mut archive = DurableReceiptArchive::open(&parent, &binding, true)?;
    archive.access(|tx| {
        for n in 0..600 {
            let mut value = row(&format!("r-{n}"));
            value.body = vec![b'x'; 4096];
            tx.insert(&value)?;
        }
        Ok(())
    })?;
    drop(archive);
    let directory = root.path().join(&binding.child);
    assert!(std::fs::metadata(directory.join(DATABASE))?.len() > 1024 * 1024);
    files::READ_BYTES.with(|bytes| bytes.set(0));
    let mut archive = DurableReceiptArchive::open(&parent, &binding, false)?;
    for _ in 0..10 {
        archive.access(|tx| {
            assert_eq!(tx.get("r-599")?.unwrap().body.len(), 4096);
            Ok(())
        })?;
    }
    let reads = files::READ_BYTES.with(|bytes| bytes.get());
    assert!(
        reads < 256 * 1024,
        "point lookup read {reads} SQLite bytes instead of hashing the complete archive"
    );
    drop(archive);
    let held = parent
        .open_entry_handle(OsStr::new(&binding.child))?
        .open_child_directory()?;
    let mut observed = DurableReceiptArchive::open(&parent, &binding, false)?;
    let owner = std::fs::read(directory.join(OWNER))?;
    held.atomic_replace(OsStr::new(OWNER), &owner)?;
    assert!(observed.access(|_| Ok(())).is_err());
    drop(observed);
    let mut reopened = DurableReceiptArchive::open(&parent, &binding, false)?;
    reopened.access(|tx| {
        assert_eq!(tx.get("r-599")?.unwrap().body.len(), 4096);
        Ok(())
    })?;
    drop(reopened);
    assert!(DurableReceiptArchive::initialize(&parent, &binding, b"seed checkpoint").is_err());
    let root = kcoder_config::create_private_temp_dir("receipt-archive-lost")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    let database = root.path().join(&binding.child).join(DATABASE);
    std::fs::remove_file(&database)?;
    assert!(DurableReceiptArchive::initialize(&parent, &binding, b"seed checkpoint").is_err());
    assert!(DurableReceiptArchive::open(&parent, &binding, true).is_err());
    assert!(
        !database.exists(),
        "missing authority must never be recreated as an empty database"
    );
    Ok(())
}

#[test]
fn quota_refuses_new_ids_without_removing_original_receipts_or_checkpoint() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("receipt-archive-quota")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    let mut archive = DurableReceiptArchive::open(&parent, &binding, true)?;
    archive.access(|tx| {
        tx.insert(&row("original"))?;
        Ok(())
    })?;
    // The unit seam places the real SQL quota counter at its boundary; the
    // production API does not expose this connection or a counter setter.
    archive.opened.connection.execute(
        "UPDATE receipt_archive_header SET row_count=?1 WHERE id=1",
        [MAX_ROWS],
    )?;
    let failed: Result<()> = archive.access(|tx| {
        tx.set_checkpoint(b"must roll back")?;
        tx.insert(&row("over-limit"))?;
        Ok(())
    });
    assert!(failed.is_err());
    archive.access(|tx| {
        assert!(tx.get("original")?.is_some());
        assert!(tx.get("over-limit")?.is_none());
        assert_eq!(tx.checkpoint()?, b"seed checkpoint");
        Ok(())
    })?;
    Ok(())
}

#[test]
#[ignore = "owned crash fixture is executed by the parent regression"]
fn interrupted_writer_child() {
    let path = std::env::var_os("KCODER_OWNED_RECEIPT_ARCHIVE_ROOT").unwrap();
    let parent = PrivateDirectory::open_existing(std::path::Path::new(&path)).unwrap();
    let binding: DurableReceiptArchiveBinding = serde_json::from_slice(
        &std::fs::read(std::path::Path::new(&path).join("fixture-binding.json")).unwrap(),
    )
    .unwrap();
    let mut archive = DurableReceiptArchive::open(&parent, &binding, true).unwrap();
    archive
        .opened
        .connection
        .execute_batch("PRAGMA cache_size=1;")
        .unwrap();
    let _: Result<()> = archive.access(|tx| {
        for n in 0..100 {
            let mut value = row(&format!("crash-{n}"));
            value.body = vec![b'z'; 4096];
            tx.insert(&value)?;
        }
        tx.set_checkpoint(b"uncommitted crash checkpoint")?;
        std::process::exit(86)
    });
    panic!("owned crash fixture did not exit");
}

#[test]
fn original_namespace_fence_can_finish_only_its_exact_prefix_and_never_downgrade_after_commit()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("receipt-archive-fence")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    let file = parent.open_read_write_file(OsStr::new("namespace.lock"), true)?;
    let identity = parent.portable_regular_handle_identity(&file)?;
    drop(file);
    let lease = parent
        .try_existing_portable_lock(
            OsStr::new("namespace.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    DurableReceiptArchiveBinding::verify_unbound_anchor(&lease)?;
    binding.prepare_bootstrap_anchor(&lease)?;
    binding.verify_bootstrap_anchor(&lease)?;
    let mut file = lease.file();
    file.seek(SeekFrom::Start(0))?;
    let mut base = Vec::new();
    file.read_to_end(&mut base)?;
    file.set_len((base.len() / 2) as u64)?;
    assert!(
        binding.verify_bootstrap_anchor(&lease).is_err(),
        "ordinary observation cannot repair a partial fence"
    );
    binding.prepare_bootstrap_anchor(&lease)?;
    file.seek(SeekFrom::End(0))?;
    file.write_all(b"\nrece")?;
    file.sync_all()?;
    binding.verify_committed_anchor(&lease)?;
    assert!(binding.verify_bootstrap_anchor(&lease).is_err());
    binding.finish_commit_anchor(&lease)?;
    binding.verify_committed_anchor(&lease)?;
    assert!(DurableReceiptArchiveBinding::verify_unbound_anchor(&lease).is_err());
    assert!(binding.prepare_bootstrap_anchor(&lease).is_err());
    let mut other = binding.clone();
    other.scope = "another scope".into();
    assert!(other.finish_commit_anchor(&lease).is_err());
    Ok(())
}

#[test]
fn actual_writer_crash_requires_owner_recovery_and_never_publishes_a_partial_batch() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("receipt-archive-crash")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let binding = initialized(&parent)?;
    parent.atomic_replace(
        OsStr::new("fixture-binding.json"),
        &serde_json::to_vec(&binding)?,
    )?;
    let status = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "durable_receipt_archive::tests::interrupted_writer_child",
            "--ignored",
            "--nocapture",
        ])
        .env("KCODER_OWNED_RECEIPT_ARCHIVE_ROOT", root.path())
        .status()?;
    assert_eq!(status.code(), Some(86));
    let mut journal = File::open(
        root.path()
            .join(&binding.child)
            .join("catalog.sqlite3-journal"),
    )?;
    let mut magic = [0u8; 8];
    journal.read_exact(&mut magic)?;
    assert_eq!(
        magic,
        [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7],
        "fixture must leave an actual hot rollback journal"
    );
    assert!(
        DurableReceiptArchive::open(&parent, &binding, false).is_err(),
        "read-only observation cannot repair a hot journal"
    );
    let mut recovered = DurableReceiptArchive::open(&parent, &binding, true)?;
    recovered.access(|tx| {
        assert_eq!(tx.checkpoint()?, b"seed checkpoint");
        assert!(tx.get("crash-99")?.is_none());
        Ok(())
    })?;
    Ok(())
}
