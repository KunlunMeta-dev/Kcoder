use super::*;

fn fixture() -> Result<(
    tempfile::TempDir,
    PrivateDirectory,
    PortableLeaseIdentity,
    PortableLeaseIdentity,
)> {
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    let db = directory.open_read_write_file(OsStr::new("catalog.sqlite"), true)?;
    db.sync_all()?;
    let lock = directory.open_read_write_file(OsStr::new("catalog.lock"), true)?;
    lock.sync_all()?;
    let db_id = directory.portable_regular_handle_identity(&db)?;
    let lock_id = directory.portable_regular_handle_identity(&lock)?;
    directory.create_private_child(OsStr::new("catalog.objects"))?;
    directory.sync()?;
    Ok((root, directory, db_id, lock_id))
}

#[test]
fn actual_owned_vfs_initializes_authorized_schema_and_preserves_original_db_identity() -> Result<()>
{
    let (root, directory, db_id, lock_id) = fixture()?;
    let catalog = KnowledgeCatalog::open_native_owned(
        &directory,
        &db_id,
        &lock_id,
        &root.path().join("catalog.objects"),
        true,
    )?;
    catalog.with_catalog(|catalog| {
        catalog.connection.execute_batch("CREATE TABLE native_probe(value TEXT NOT NULL); INSERT INTO native_probe VALUES('actual owned DB write');")?;
        Ok(())
    })?;
    assert_eq!(
        directory.portable_regular_identity(OsStr::new("catalog.sqlite"))?,
        db_id
    );
    let catalog = KnowledgeCatalog::open_native_owned(
        &directory,
        &db_id,
        &lock_id,
        &root.path().join("catalog.objects"),
        false,
    )?;
    let value = catalog.with_catalog(|catalog| {
        Ok(catalog
            .connection
            .query_row("SELECT value FROM native_probe", [], |row| {
                row.get::<_, String>(0)
            })?)
    })?;
    assert_eq!(value, "actual owned DB write");
    assert!(!root.path().join("catalog.sqlite-journal").exists());
    assert!(!root.path().join("catalog.sqlite-wal").exists());
    Ok(())
}

#[test]
fn owned_vfs_missing_or_same_byte_replaced_database_never_creates_or_adopts_it() -> Result<()> {
    for remove in [false, true] {
        let (root, directory, db_id, lock_id) = fixture()?;
        KnowledgeCatalog::open_native_owned(
            &directory,
            &db_id,
            &lock_id,
            &root.path().join("catalog.objects"),
            true,
        )?
        .with_catalog(|_| Ok(()))?;
        let bytes = std::fs::read(root.path().join("catalog.sqlite"))?;
        if remove {
            std::fs::remove_file(root.path().join("catalog.sqlite"))?;
        } else {
            directory.atomic_replace(OsStr::new("catalog.sqlite"), &bytes)?;
        }
        assert!(
            KnowledgeCatalog::open_native_owned(
                &directory,
                &db_id,
                &lock_id,
                &root.path().join("catalog.objects"),
                false
            )
            .is_err()
        );
        if remove {
            assert!(!root.path().join("catalog.sqlite").exists());
        }
    }
    Ok(())
}

#[test]
fn owned_vfs_keeps_its_original_directory_and_refuses_concurrent_writer() -> Result<()> {
    let (root, directory, db_id, lock_id) = fixture()?;
    let first = KnowledgeCatalog::open_native_owned(
        &directory,
        &db_id,
        &lock_id,
        &root.path().join("catalog.objects"),
        true,
    )?;
    assert!(
        KnowledgeCatalog::open_native_owned(
            &directory,
            &db_id,
            &lock_id,
            &root.path().join("catalog.objects"),
            false
        )
        .is_err()
    );
    first.with_catalog(|_| Ok(()))?;
    let catalog = KnowledgeCatalog::open_native_owned(
        &directory,
        &db_id,
        &lock_id,
        &root.path().join("catalog.objects"),
        false,
    )?;
    catalog.with_catalog(|catalog| {
        let failed = catalog
            .connection
            .execute("ATTACH DATABASE 'outside.sqlite' AS outside", []);
        assert!(failed.is_err());
        Ok(())
    })?;
    assert!(!root.path().join("outside.sqlite").exists());
    Ok(())
}
