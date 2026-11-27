use super::*;
use crate::{KnowledgeScope, Library};
use std::{path::PathBuf, process::Command, time::Duration};

fn fixture() -> Result<(tempfile::TempDir, PathBuf, KnowledgeScope, Library)> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("knowledge");
    PrivateDirectory::open_or_create(&root)?;
    let scope = KnowledgeScope::from_authenticated_host("owned-principal", "execution-host")?;
    let mut catalog = KnowledgeCatalog::open(&root.join("state.sqlite"))?;
    let library = catalog.create(&scope, "original", "Original library", "")?;
    drop(catalog);
    Ok((temp, root, scope, library))
}

#[test]
#[cfg(target_os = "linux")]
fn directory_move_keeps_database_and_immutable_objects_on_original_handles() -> Result<()> {
    let (temp, root, scope, library) = fixture()?;
    let replacement = temp.path().join("replacement");
    PrivateDirectory::open_or_create(&replacement)?;
    std::fs::copy(root.join("state.sqlite"), replacement.join("state.sqlite"))?;
    let writer = DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?;
    let held = temp.path().join("held-original");
    std::fs::rename(&root, &held)?;
    std::fs::rename(&replacement, &root)?;
    writer.with_catalog(|catalog| {
        catalog.update_library(
            &scope,
            &library.id,
            library.revision,
            "Original handle update",
            "",
        )?;
        let source = catalog.import_text(
            &scope,
            &library.id,
            "original-import",
            "Source",
            "Original immutable source bytes",
        )?;
        assert!(!source.revision_id.is_empty());
        Ok(())
    })?;
    let changed = KnowledgeCatalog::open(&held.join("state.sqlite"))?;
    assert_eq!(
        changed.read(&scope, &library.id)?.name,
        "Original handle update"
    );
    assert!(held.join("state.objects").join(&library.id).exists());
    assert!(!root.join("state.objects").exists());
    let untouched = KnowledgeCatalog::open(&root.join("state.sqlite"))?;
    assert_eq!(
        untouched.read(&scope, &library.id)?.name,
        "Original library"
    );
    assert!(!root.join("state.objects").join(&library.id).exists());
    Ok(())
}

#[test]
#[cfg(target_os = "linux")]
fn wal_alias_survives_first_close_with_held_or_normal_peer() -> Result<()> {
    for normal in [false, true] {
        let (temp, root, _scope, _library) = fixture()?;
        let first = DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?;
        let first_connection = &first.catalog.as_ref().unwrap().connection;
        let mode: String =
            first_connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
        assert_eq!(mode, "wal");
        first_connection.execute_batch("CREATE TABLE original_wal_probe(value INTEGER); INSERT INTO original_wal_probe VALUES(1)")?;
        let second = if normal {
            None
        } else {
            Some(DirectoryKnowledgeWriter::open(
                PrivateDirectory::open_existing(&root)?,
            )?)
        };
        let plain = if normal {
            Some(Connection::open(root.join("state.sqlite"))?)
        } else {
            None
        };
        let connection = plain.as_ref().unwrap_or_else(|| {
            &second
                .as_ref()
                .unwrap()
                .catalog
                .as_ref()
                .unwrap()
                .connection
        });
        assert_eq!(
            connection.query_row("SELECT SUM(value) FROM original_wal_probe", [], |row| row
                .get::<_, i64>(
                0
            ))?,
            1
        );
        first.with_catalog(|_| Ok(()))?;
        // A new unrelated namespace must never inherit the creator's old fd.
        let unrelated = temp.path().join("unrelated");
        std::fs::create_dir(&unrelated)?;
        let mut churn = Vec::new();
        for _ in 0..16 {
            churn.push(std::fs::File::open(&unrelated)?);
        }
        connection.execute("INSERT INTO original_wal_probe VALUES(2)", [])?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        assert_eq!(
            connection.query_row("SELECT SUM(value) FROM original_wal_probe", [], |row| row
                .get::<_, i64>(
                0
            ))?,
            3
        );
        drop(plain);
        if let Some(second) = second {
            second.with_catalog(|_| Ok(()))?;
        }
        assert!(!unrelated.join("state.sqlite-shm").exists());
        assert!(!unrelated.join("state.sqlite-wal").exists());
        let final_connection = Connection::open(root.join("state.sqlite"))?;
        assert_eq!(
            final_connection.query_row("SELECT SUM(value) FROM original_wal_probe", [], |row| {
                row.get::<_, i64>(0)
            })?,
            3
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn normal_first_shm_name_never_cleans_a_replacement_namespace_on_held_close() -> Result<()> {
    let (temp, root, _scope, _library) = fixture()?;
    let first = Connection::open(root.join("state.sqlite"))?;
    first.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE normal_first_probe(value INTEGER); INSERT INTO normal_first_probe VALUES(1)")?;
    let writer = DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?;
    assert_eq!(
        writer.catalog.as_ref().unwrap().connection.query_row(
            "SELECT SUM(value) FROM normal_first_probe",
            [],
            |row| row.get::<_, i64>(0)
        )?,
        1
    );
    let replacement = temp.path().join("replacement");
    PrivateDirectory::open_or_create(&replacement)?;
    std::fs::copy(root.join("state.sqlite"), replacement.join("state.sqlite"))?;
    let sentinel = b"replacement shared-memory file must not be deleted";
    std::fs::write(replacement.join("state.sqlite-shm"), sentinel)?;
    first.close().map_err(|(_, error)| error)?;
    let held = temp.path().join("held-original");
    std::fs::rename(&root, &held)?;
    std::fs::rename(&replacement, &root)?;
    writer.with_catalog(|catalog| {
        catalog
            .connection
            .execute("INSERT INTO normal_first_probe VALUES(2)", [])?;
        catalog
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    })?;
    assert_eq!(std::fs::read(root.join("state.sqlite-shm"))?, sentinel);
    let actual = Connection::open(held.join("state.sqlite"))?;
    assert_eq!(
        actual.query_row("SELECT SUM(value) FROM normal_first_probe", [], |row| row
            .get::<_, i64>(
            0
        ))?,
        3
    );
    Ok(())
}

#[test]
fn native_locks_interoperate_with_normal_sqlite_in_another_process() -> Result<()> {
    if let Some(root) = std::env::var_os("KCODER_TEST_HELD_WIKI_LOCK_ROOT") {
        let root = PathBuf::from(root);
        let check = |connection: &Connection| -> Result<()> {
            connection.busy_timeout(Duration::ZERO)?;
            let error = connection.execute_batch("BEGIN IMMEDIATE").unwrap_err();
            assert!(
                matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DatabaseBusy)
            );
            Ok(())
        };
        if std::env::var_os("KCODER_TEST_HELD_WIKI_LOCK_NATIVE").is_some() {
            DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?
                .with_catalog(|catalog| check(&catalog.connection))?;
        } else {
            check(&Connection::open(root.join("state.sqlite"))?)?;
        }
        println!("ACTUAL_NATIVE_SQLITE_BUSY");
        return Ok(());
    }
    for wal in [false, true] {
        for native in [false, true] {
            let (_temp, root, _scope, _library) = fixture()?;
            let writer = if native {
                Some(DirectoryKnowledgeWriter::open(
                    PrivateDirectory::open_existing(&root)?,
                )?)
            } else {
                None
            };
            let plain = if native {
                None
            } else {
                Some(Connection::open(root.join("state.sqlite"))?)
            };
            let connection = plain.as_ref().unwrap_or_else(|| {
                &writer
                    .as_ref()
                    .unwrap()
                    .catalog
                    .as_ref()
                    .unwrap()
                    .connection
            });
            if wal {
                connection.execute_batch("PRAGMA journal_mode=WAL")?;
            }
            connection.execute_batch("BEGIN IMMEDIATE")?;
            let mut command = Command::new(std::env::current_exe()?);
            command.args(["directory_writer::tests::native_locks_interoperate_with_normal_sqlite_in_another_process", "--exact", "--nocapture"])
            .env("KCODER_TEST_HELD_WIKI_LOCK_ROOT", &root);
            if !native {
                command.env("KCODER_TEST_HELD_WIKI_LOCK_NATIVE", "1");
            }
            let output = command.output()?;
            connection.execute_batch("ROLLBACK")?;
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("ACTUAL_NATIVE_SQLITE_BUSY"));
            drop(plain);
            if let Some(writer) = writer {
                writer.with_catalog(|_| Ok(()))?;
            }
        }
    }
    Ok(())
}

#[test]
fn held_writer_preserves_scope_revision_and_original_import_receipts() -> Result<()> {
    let (_temp, root, scope, library) = fixture()?;
    let foreign = KnowledgeScope::from_authenticated_host("foreign", "execution-host")?;
    DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?.with_catalog(
        |catalog| {
            assert!(
                catalog
                    .update_library(&foreign, &library.id, 1, "Foreign", "")
                    .is_err()
            );
            let updated = catalog.update_library(&scope, &library.id, 1, "Current", "")?;
            assert_eq!(updated.revision, 2);
            assert!(
                catalog
                    .update_library(&scope, &library.id, 1, "Stale", "")
                    .is_err()
            );
            let first =
                catalog.import_text(&scope, &library.id, "stable", "Title", "Original body")?;
            let again =
                catalog.import_text(&scope, &library.id, "stable", "Title", "Original body")?;
            assert_eq!(first.revision_id, again.revision_id);
            assert!(
                catalog
                    .import_text(&scope, &library.id, "stable", "Title", "Different body")
                    .is_err()
            );
            Ok(())
        },
    )
}

#[cfg(target_os = "linux")]
#[test]
fn held_writer_does_not_follow_symbolic_or_hard_link_database_entries() -> Result<()> {
    use std::os::unix::fs::symlink;
    for hard in [false, true] {
        let (temp, root, _scope, _library) = fixture()?;
        let outside = temp.path().join("outside.sqlite");
        std::fs::rename(root.join("state.sqlite"), &outside)?;
        let bytes = std::fs::read(&outside)?;
        if hard {
            std::fs::hard_link(&outside, root.join("state.sqlite"))?;
        } else {
            symlink(&outside, root.join("state.sqlite"))?;
        }
        assert!(DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?).is_err());
        assert_eq!(std::fs::read(&outside)?, bytes);
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_personal_writer_keeps_native_wal_and_pins_its_actual_namespace() -> Result<()> {
    let (_temp, root, scope, library) = fixture()?;
    let writer = DirectoryKnowledgeWriter::open(PrivateDirectory::open_existing(&root)?)?;
    let moved = root.with_file_name("moved");
    assert!(std::fs::rename(&root, &moved).is_err());
    writer.with_catalog(|catalog| {
        let mode: String = catalog
            .connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
        assert_eq!(mode, "wal");
        catalog.update_library(&scope, &library.id, library.revision, "Personal write", "")?;
        catalog
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    })?;
    assert_eq!(
        KnowledgeCatalog::open(&root.join("state.sqlite"))?
            .read(&scope, &library.id)?
            .name,
        "Personal write"
    );
    std::fs::rename(&root, &moved)?;
    Ok(())
}
