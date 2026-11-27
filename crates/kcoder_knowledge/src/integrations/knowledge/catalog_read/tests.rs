use super::*;
use crate::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use std::collections::BTreeMap;

fn bytes(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    fn visit(root: &Path, at: &Path, output: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
        for entry in std::fs::read_dir(at)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                visit(root, &path, output)?;
            } else {
                output.insert(
                    path.strip_prefix(root)?.to_string_lossy().into_owned(),
                    std::fs::read(path)?,
                );
            }
        }
        Ok(())
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output)?;
    Ok(output)
}

#[test]
fn held_directory_reader_keeps_database_and_object_parent_and_never_writes() -> Result<()> {
    let root = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(root.path())?;
    parent.create_private_child(std::ffi::OsStr::new("knowledge"))?;
    let wiki = root.path().join("knowledge");
    let mut writer = KnowledgeCatalog::open(&wiki.join("state.sqlite"))?;
    let (scope, library, page, revision) = seed(&mut writer)?;
    let before = bytes(root.path())?;
    let reader = KnowledgeCatalog::open_existing_native_directory(
        parent.open_child(std::ffi::OsStr::new("knowledge"), false)?,
        std::ffi::OsStr::new("state.sqlite"),
        std::ffi::OsStr::new("state.objects"),
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    let (actual, proof) =
        reader.with_catalog(|reader| reader.read_page(&scope, &library, &page, Some(&revision)))?;
    assert!(actual.draft.markdown.contains("committed WAL"));
    assert_eq!(proof.source_write_attempts, 0);
    assert_eq!(bytes(root.path())?, before);
    let reader = KnowledgeCatalog::open_existing_native_directory(
        parent.open_child(std::ffi::OsStr::new("knowledge"), false)?,
        std::ffi::OsStr::new("state.sqlite"),
        std::ffi::OsStr::new("state.objects"),
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    std::fs::rename(
        wiki.join("state.objects"),
        wiki.join("original-held-objects"),
    )?;
    PrivateDirectory::open_or_create(&wiki.join("state.objects"))?;
    let error = reader
        .with_catalog(|reader| reader.read_page(&scope, &library, &page, Some(&revision)))
        .unwrap_err();
    assert!(error.to_string().contains("object root changed"), "{error}");
    Ok(())
}
fn seed(store: &mut KnowledgeCatalog) -> Result<(KnowledgeScope, String, String, String)> {
    let scope =
        KnowledgeScope::from_authenticated_host("existing-actual-wiki-owner", "execution-host")?;
    let library = store.create(&scope, "library", "Actual source library", "")?;
    let text = "A fixed source visible only in the committed WAL revision.";
    let source = store.import_text(&scope, &library.id, "source", "source.md", text)?;
    let refs = store.commit_generated_pages(
        &scope,
        &library.id,
        "page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Actual committed page".into(),
            markdown: text.into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id,
                revision_id: source.revision_id,
                chunk_id: "chunk-1".into(),
                quote: text.into(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    Ok((
        scope,
        library.id,
        refs[0].page_id.clone(),
        refs[0].revision_id.clone(),
    ))
}

#[test]
fn live_committed_wal_and_original_objects_are_read_without_source_side_effects() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let path = root.path().join("state.sqlite");
    let mut writer = KnowledgeCatalog::open(&path)?;
    let mode: String = writer
        .connection
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    assert_eq!(mode, "wal");
    writer
        .connection
        .execute_batch("PRAGMA wal_autocheckpoint=0;")?;
    let (scope, library, page, revision) = seed(&mut writer)?;
    assert!(root.path().join("state.sqlite-wal").metadata()?.len() > 32);
    let before = bytes(root.path())?;
    let observed = KnowledgeCatalog::open_existing_native(
        &path,
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    let (actual, proof) = observed
        .with_catalog(|reader| reader.read_page(&scope, &library, &page, Some(&revision)))?;
    assert_eq!(
        actual.draft.markdown,
        "A fixed source visible only in the committed WAL revision."
    );
    assert!(proof.wal_bytes > 32);
    assert!(proof.actual_reads > 0);
    assert_eq!(proof.source_write_attempts, 0);
    assert_eq!(bytes(root.path())?, before);
    Ok(())
}

#[test]
fn rollback_mode_missing_sources_and_attempted_mutations_do_not_create_or_repair_files()
-> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let missing = root.path().join("missing.sqlite");
    assert!(
        KnowledgeCatalog::open_existing_native(
            &missing,
            &CancellationToken::new(),
            CatalogReadLimits::default()
        )
        .is_err()
    );
    assert!(std::fs::read_dir(root.path())?.next().is_none());
    let path = root.path().join("state.sqlite");
    let mut writer = KnowledgeCatalog::open(&path)?;
    let (scope, library, page, revision) = seed(&mut writer)?;
    drop(writer);
    let before = bytes(root.path())?;
    let read = KnowledgeCatalog::open_existing_native(
        &path,
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    assert!(
        read.with_catalog(|reader| reader.read_page(&scope, &library, &page, Some(&revision)))
            .is_ok()
    );
    let read = KnowledgeCatalog::open_existing_native(
        &path,
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    assert!(
        read.with_catalog(|reader| {
            reader
                .connection
                .execute("CREATE TABLE forbidden_write(value TEXT)", [])?;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(bytes(root.path())?, before);
    Ok(())
}

#[test]
fn old_schema_missing_objects_cancellation_or_exhausted_budget_stays_unavailable() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let path = root.path().join("state.sqlite");
    let catalog = KnowledgeCatalog::open(&path)?;
    catalog
        .connection
        .execute_batch("PRAGMA user_version=17;")?;
    drop(catalog);
    let before = bytes(root.path())?;
    assert!(
        KnowledgeCatalog::open_existing_native(
            &path,
            &CancellationToken::new(),
            CatalogReadLimits::default()
        )
        .is_err()
    );
    assert_eq!(bytes(root.path())?, before);
    // Restore only the metadata deliberately changed by this fixture; the observed
    // source implementation must never run a migration to make the assertion pass.
    let connection = Connection::open(&path)?;
    connection.execute_batch("PRAGMA user_version=18;")?;
    drop(connection);
    let token = CancellationToken::new();
    token.cancel();
    assert!(
        KnowledgeCatalog::open_existing_native(&path, &token, CatalogReadLimits::default())
            .is_err()
    );
    assert!(
        KnowledgeCatalog::open_existing_native(
            &path,
            &CancellationToken::new(),
            CatalogReadLimits {
                read_bytes: 1,
                ..Default::default()
            }
        )
        .is_err()
    );
    std::fs::remove_dir(path.with_extension("objects"))?;
    let before = bytes(root.path())?;
    assert!(
        KnowledgeCatalog::open_existing_native(
            &path,
            &CancellationToken::new(),
            CatalogReadLimits::default()
        )
        .is_err()
    );
    assert!(!path.with_extension("objects").exists());
    assert_eq!(bytes(root.path())?, before);
    Ok(())
}

#[test]
fn cancellation_after_the_last_sql_read_never_publishes_a_completed_observation() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let path = root.path().join("state.sqlite");
    drop(KnowledgeCatalog::open(&path)?);
    let cancel = CancellationToken::new();
    let observed =
        KnowledgeCatalog::open_existing_native(&path, &cancel, CatalogReadLimits::default())?;
    let result = observed.with_catalog(|_| {
        cancel.cancel();
        Ok(())
    });
    assert!(result.is_err());
    Ok(())
}
