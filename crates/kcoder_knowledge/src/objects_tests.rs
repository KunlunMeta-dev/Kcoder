use super::*;
#[cfg(unix)]
use crate::{KnowledgeCatalog, KnowledgeScope};
#[cfg(unix)]
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
static DIRECTORY_SYNC_FAILURES: OnceLock<Mutex<std::collections::HashMap<PathBuf, usize>>> =
    OnceLock::new();

#[cfg(unix)]
struct DirectorySyncFailure(PathBuf);

#[cfg(unix)]
impl DirectorySyncFailure {
    fn install(path: PathBuf) -> Self {
        *DIRECTORY_SYNC_FAILURES
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .entry(path.clone())
            .or_default() += 1;
        Self(path)
    }
}

#[cfg(unix)]
impl Drop for DirectorySyncFailure {
    fn drop(&mut self) {
        let mut failures = DIRECTORY_SYNC_FAILURES.get().unwrap().lock().unwrap();
        let count = failures.get_mut(&self.0).unwrap();
        *count -= 1;
        if *count == 0 {
            failures.remove(&self.0);
        }
    }
}

#[cfg(unix)]
pub(super) fn before_directory_sync(path: &Path) -> Result<()> {
    if DIRECTORY_SYNC_FAILURES
        .get()
        .is_some_and(|failures| failures.lock().unwrap().contains_key(path))
    {
        anyhow::bail!("injected knowledge object directory sync failure");
    }
    Ok(())
}

#[cfg(unix)]
fn assert_no_source_publication(store: &KnowledgeCatalog, library: &str) -> Result<()> {
    for table in [
        "knowledge_sources",
        "knowledge_originals",
        "knowledge_chunks",
        "knowledge_source_lifecycle",
        "knowledge_fts",
    ] {
        let count: i64 = store.connection.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE library_id=?1"),
            [library],
            |row| row.get(0),
        )?;
        assert_eq!(count, 0, "directory sync failure must roll back {table}");
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn object_sync_retry_cannot_publish_sqlite_refs_without_directory_confirmation() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("wiki.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("fixture-owner", "local")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Durable objects", "")?;
    let directory = store.objects.directory(&library.id)?;
    let fault = DirectorySyncFailure::install(directory.clone());
    let body = "source evidence";

    let error = store
        .import_text(&scope, &library.id, "import", "source.txt", body)
        .unwrap_err();
    assert!(error.to_string().contains("directory sync failure"));
    assert_eq!(
        fs::read(directory.join(format!("{}.md", digest(body.as_bytes()))))?,
        body.as_bytes(),
        "the publication leaf exists although its directory confirmation failed"
    );
    assert_no_source_publication(&store, &library.id)?;
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;

    let error = store
        .import_text(&scope, &library.id, "import", "source.txt", body)
        .expect_err("an existing hash must still confirm its directory before publishing DB refs");
    assert!(error.to_string().contains("directory sync failure"));
    assert_no_source_publication(&store, &library.id)?;
    // Faults are scoped to one object directory, including while another library writes.
    let other = store.create(&scope, "other", "Unaffected", "")?;
    store.import_text(&scope, &other.id, "import", "other.txt", "other evidence")?;

    drop(fault);
    let source = store.import_text(&scope, &library.id, "import", "source.txt", body)?;
    drop(store);
    let mut reopened = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        reopened.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        body
    );
    assert_eq!(
        reopened
            .original_source(&scope, &library.id, &source.source_id, &source.revision_id)?
            .2,
        body.as_bytes()
    );
    assert_eq!(
        reopened
            .import_text(&scope, &library.id, "import", "source.txt", body)?
            .revision_id,
        source.revision_id
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn object_stream_retry_keeps_directory_confirmation_and_integrity_guards() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ObjectStore::open(root.path().join("objects"))?;
    let library = uuid::Uuid::new_v4().to_string();
    let body = b"stream evidence";
    let hash = store.put_bytes(&library, body)?;
    let fault = DirectorySyncFailure::install(store.directory(&library)?);
    assert!(
        store
            .put_object_reader(&library, &mut &body[..], body.len() as u64, &hash)
            .is_err()
    );
    assert!(
        store
            .put_object_reader(&library, &mut &b"wrong bytes"[..], 11, &hash)
            .is_err()
    );
    drop(fault);
    store.put_object_reader(&library, &mut &body[..], body.len() as u64, &hash)?;
    assert_eq!(store.read_bytes(&library, &hash)?, body);
    Ok(())
}

#[test]
fn object_parent_sync_failure_keeps_library_retry_unpublished_until_confirmation() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("parent-sync.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("fixture-owner", "local")?;
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let library = catalog.create(&scope, "library", "Parent barrier", "")?;
    let object_root = catalog.objects.root.clone();
    let library_directory = object_root.join(&library.id);
    assert!(!library_directory.exists());
    let fault = DirectorySyncFailure::install(object_root);
    let body = "source with a newly created library directory";

    let error = catalog
        .import_text(&scope, &library.id, "source", "source.txt", body)
        .expect_err("library mkdir must confirm its parent before publishing object refs");
    assert!(error.to_string().contains("directory sync failure"));
    assert!(
        library_directory.is_dir(),
        "mkdir is visible although parent confirmation failed"
    );
    assert_eq!(
        fs::read_dir(&library_directory)?.count(),
        0,
        "parent failure must stop before leaf publication"
    );
    assert_no_source_publication(&catalog, &library.id)?;
    drop(catalog);
    let mut catalog = KnowledgeCatalog::open(&path)?;
    assert!(
        catalog
            .import_text(&scope, &library.id, "source", "source.txt", body)
            .is_err(),
        "an existing library directory must retry a failed parent confirmation"
    );
    assert_no_source_publication(&catalog, &library.id)?;

    // Only the exact object root is faulted, not other temporary catalogs.
    let mut other = KnowledgeCatalog::open(&temp.path().join("unaffected.sqlite"))?;
    let other_library = other.create(&scope, "library", "Unaffected", "")?;
    other.import_text(
        &scope,
        &other_library.id,
        "source",
        "other.txt",
        "other evidence",
    )?;
    drop(fault);
    let source = catalog.import_text(&scope, &library.id, "source", "source.txt", body)?;
    drop(catalog);
    let mut reopened = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        reopened.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        body
    );
    assert_eq!(
        reopened
            .original_source(&scope, &library.id, &source.source_id, &source.revision_id)?
            .2,
        body.as_bytes()
    );
    assert_eq!(
        reopened
            .import_text(&scope, &library.id, "source", "source.txt", body)?
            .revision_id,
        source.revision_id
    );
    Ok(())
}

#[test]
fn object_parent_sync_failure_also_gates_stream_publication_into_existing_library() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let store = ObjectStore::open(temp.path().join("objects"))?;
    let library = uuid::Uuid::new_v4().to_string();
    let body = b"immutable streamed content";
    let hash = store.put_bytes(&library, body)?;
    let fault = DirectorySyncFailure::install(store.root.clone());
    assert!(
        store
            .put_object_reader(&library, &mut &body[..], body.len() as u64, &hash)
            .is_err(),
        "stream publication cannot bypass parent confirmation for an existing directory"
    );
    drop(fault);
    store.put_object_reader(&library, &mut &body[..], body.len() as u64, &hash)?;
    assert_eq!(store.read_bytes(&library, &hash)?, body);
    Ok(())
}

fn current_schema_object_root_confirmation(mode: &str) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("root-confirmation.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("fixture-owner", "local")?;
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let library = catalog.create(&scope, "library", "Current schema", "")?;
    let object_root = catalog.objects.root.clone();
    let parent = object_root.parent().unwrap().to_path_buf();
    drop(catalog);

    // Keep an initialized journal/WAL alive: the next open does no DDL or
    // schema migration, and cannot rely on creating a new journal as a barrier.
    let keeper = rusqlite::Connection::open(&path)?;
    let journal: String =
        keeper.query_row(&format!("PRAGMA journal_mode={mode}"), [], |row| row.get(0))?;
    assert_eq!(journal, mode);
    keeper.execute(
        "UPDATE libraries SET name='Journal initialized' WHERE id=?1",
        [&library.id],
    )?;
    let version: i64 = keeper.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    assert_eq!(version, 18);
    assert_eq!(fs::read_dir(&object_root)?.count(), 0);
    fs::remove_dir(&object_root)?;
    let fault = DirectorySyncFailure::install(parent.clone());

    let error = match KnowledgeCatalog::open(&path) {
        Err(error) => error,
        Ok(_) => panic!("current-schema open must confirm the recreated object-root entry"),
    };
    assert!(error.to_string().contains("directory sync failure"));
    assert!(
        object_root.is_dir(),
        "creation remains visible after failed parent sync"
    );
    assert!(
        KnowledgeCatalog::open(&path).is_err(),
        "the existing-root retry must not bypass the previous failed confirmation"
    );
    let source_rows: i64 =
        keeper.query_row("SELECT COUNT(*) FROM knowledge_sources", [], |row| {
            row.get(0)
        })?;
    assert_eq!(source_rows, 0);

    let unrelated = tempfile::tempdir()?;
    assert!(KnowledgeCatalog::open(&unrelated.path().join("unaffected.sqlite")).is_ok());
    drop(fault);
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let retained_mode: String = catalog
        .connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    assert_eq!(
        retained_mode, mode,
        "opening must not rewrite the journal configuration"
    );
    let source = catalog.import_text(
        &scope,
        &library.id,
        "source",
        "source.txt",
        "root entry evidence",
    )?;
    drop(catalog);
    let mut reopened = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        reopened.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        "root entry evidence"
    );
    assert_eq!(
        reopened
            .original_source(&scope, &library.id, &source.source_id, &source.revision_id)?
            .2,
        b"root entry evidence"
    );
    // This instance already confirmed its parent. Reads and subsequent writes
    // do not repeatedly sync that higher directory or change its configuration.
    let _later_parent_failure = DirectorySyncFailure::install(parent);
    assert_eq!(
        reopened.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        "root entry evidence"
    );
    reopened.import_text(
        &scope,
        &library.id,
        "second-source",
        "second.txt",
        "continued evidence",
    )?;
    assert!(
        KnowledgeCatalog::open(&path).is_err(),
        "a new open must confirm again rather than cache readiness permanently"
    );
    Ok(())
}

#[test]
fn object_root_confirmation_current_schema_delete_retry() -> Result<()> {
    current_schema_object_root_confirmation("delete")
}

#[test]
fn object_root_confirmation_current_schema_wal_retry() -> Result<()> {
    current_schema_object_root_confirmation("wal")
}
