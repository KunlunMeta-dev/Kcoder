use super::*;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};

fn empty() -> (
    tempfile::TempDir,
    ExternalHistoryStore,
    ExternalHistoryReader,
) {
    empty_fixture(false)
}

pub(in crate::external_history::lifecycle) fn empty_budgeted() -> (
    tempfile::TempDir,
    ExternalHistoryStore,
    ExternalHistoryReader,
) {
    empty_fixture(true)
}

fn empty_fixture(
    budgeted: bool,
) -> (
    tempfile::TempDir,
    ExternalHistoryStore,
    ExternalHistoryReader,
) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    assert!(
        store
            .directory
            .portable_retention_filesystem_supported()
            .unwrap(),
        "the owned cache fixture requires a supported native filesystem"
    );
    if budgeted {
        store
            .prepare_resource_budget(
                "owned-cache-crash",
                vec!["first".into()],
                kcoder_types::migration_resource::MigrationResourceLimits {
                    max_total_bytes: 16 * 1024 * 1024,
                    max_payload_files: 32,
                    min_free_bytes: 1024 * 1024,
                    min_free_file_nodes: 0,
                },
            )
            .unwrap();
    }
    let snapshot = ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned".into(),
            source_session_id: "source".into(),
            source_artifact_id: None,
            source_format: "fixture/1".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: 0,
        source_sha256: format!("{:x}", Sha256::digest([])),
        record_limit: 10,
        original: None,
    };
    let mut import = store.begin_managed("first", &snapshot).unwrap();
    import.stage_source(&mut &b""[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    drop(import);
    let reader = store.reader(&receipt.archive_id).unwrap();
    (root, store, reader)
}

#[test]
fn a_real_projection_has_a_fixed_birth_before_publication_and_a_streamed_seal_without_global_lock()
{
    let (_root, store, reader) = empty();
    let revision = "fixture/1";
    let name = format!(
        "normalized-{}",
        crate::external_history::hash(revision.as_bytes())
    );
    let mut projection = reader.projection(revision, true).unwrap().unwrap();
    let cache = reader
        .directory
        .open_child(OsStr::new(&name), false)
        .unwrap();
    let sqlite_identity = cache
        .portable_retention_regular_identity(OsStr::new("catalog.sqlite3"))
        .unwrap();
    let sqlite = cache
        .portable_open_verified_regular(OsStr::new("catalog.sqlite3"), &sqlite_identity)
        .unwrap();
    let mut header = [0u8; 16];
    use std::io::Read;
    let mut sqlite_file = sqlite.file();
    sqlite_file.read_exact(&mut header).unwrap();
    assert_eq!(&header, b"SQLite format 3\0");
    drop(sqlite);
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    let record = catalog.document.archives[&reader.binding.archive_id].derived[&name].clone();
    assert!(record.published && record.seal.is_none());
    assert_eq!(
        record.directory,
        reader
            .directory
            .open_child(OsStr::new(&name), false)
            .unwrap()
            .directory_identity()
            .unwrap()
    );
    drop(catalog);
    projection.finish().unwrap();
    let mut callbacks = 0;
    projection
        .seal_for_collection(|| {
            callbacks += 1;
            assert!(
                store
                    .archive_lifecycle_observation(&reader.binding.archive_id)
                    .is_ok()
            );
            true
        })
        .unwrap();
    assert!(callbacks > 0);
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    let sealed = &catalog.document.archives[&reader.binding.archive_id].derived[&name];
    assert_eq!(sealed.directory, record.directory);
    let manifest = sealed.seal.as_ref().unwrap();
    let sqlite = manifest
        .leaves
        .iter()
        .find(|leaf| leaf.name == "catalog.sqlite3")
        .expect("a real sealed projection includes its SQLite database");
    assert!(sqlite.bytes >= header.len() as u64);
    assert_eq!(sqlite.identity, sqlite_identity);
}

#[test]
fn sealed_recovery_requires_original_database_identity_and_complete_restored_bytes() {
    use std::io::{Read, Seek, SeekFrom, Write};
    let (_root, _store, reader) = empty();
    let revision = "fixture/sealed-recovery";
    let name = format!(
        "normalized-{}",
        crate::external_history::hash(revision.as_bytes())
    );
    let mut projection = reader.projection(revision, true).unwrap().unwrap();
    projection.finish().unwrap();
    projection.seal_for_collection(|| true).unwrap();
    drop(projection);
    let directory = reader
        .directory
        .open_child(OsStr::new(&name), false)
        .unwrap();
    assert!(
        reader
            .lifecycle
            .sealed_cache_recovery(&name, &directory)
            .unwrap()
            .is_none()
    );
    let mut database = directory
        .open_read_write_file(OsStr::new("catalog.sqlite3"), false)
        .unwrap();
    let mut original = Vec::new();
    database.read_to_end(&mut original).unwrap();
    directory
        .atomic_replace(
            OsStr::new("catalog.sqlite3-journal"),
            b"controlled test journal",
        )
        .unwrap();
    let checkpoint = reader
        .lifecycle
        .sealed_cache_recovery(&name, &directory)
        .unwrap()
        .unwrap();
    database.seek(SeekFrom::Start(0)).unwrap();
    database.write_all(b"damaged!").unwrap();
    database.sync_all().unwrap();
    directory
        .remove_regular_file(OsStr::new("catalog.sqlite3-journal"))
        .unwrap();
    assert!(
        checkpoint.verify_restored(&directory).is_err(),
        "a successful open cannot certify damaged bytes"
    );
    database.seek(SeekFrom::Start(0)).unwrap();
    database.write_all(&original).unwrap();
    database.sync_all().unwrap();
    checkpoint.verify_restored(&directory).unwrap();
    directory
        .atomic_replace(OsStr::new("foreign-entry"), b"not owned by the cache")
        .unwrap();
    assert!(checkpoint.verify_restored(&directory).is_err());
    assert_eq!(database.metadata().unwrap().len(), original.len() as u64);
    directory
        .remove_regular_file(OsStr::new("foreign-entry"))
        .unwrap();
    directory
        .atomic_replace(OsStr::new("catalog.sqlite3"), &original)
        .unwrap();
    let replacement = directory
        .open_single_link_regular_file(OsStr::new("catalog.sqlite3"))
        .unwrap();
    assert!(
        checkpoint
            .verify_file(&directory, "catalog.sqlite3", &replacement)
            .is_err(),
        "equal bytes in a replacement object are not the original checkpoint"
    );
    assert!(checkpoint.verify_restored(&directory).is_err());
}

#[test]
fn a_lost_directory_publication_ack_reuses_only_its_exact_native_birth_without_readonly_repair() {
    let (_root, store, reader) = empty();
    let revision = "fixture/lost-rename";
    let name = format!(
        "normalized-{}",
        crate::external_history::hash(revision.as_bytes())
    );
    let staging = format!("cache-birth-{}", uuid::Uuid::new_v4());
    let born = reader
        .directory
        .create_private_child(OsStr::new(&staging))
        .unwrap();
    let identity = born.directory_identity().unwrap();
    let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
    catalog
        .document
        .archives
        .get_mut(&reader.binding.archive_id)
        .unwrap()
        .derived
        .insert(
            name.clone(),
            Derived {
                name: name.clone(),
                directory: identity.clone(),
                staging: staging.clone(),
                published: false,
                seal: None,
            },
        );
    catalog.save().unwrap();
    reader
        .directory
        .rename_no_replace(OsStr::new(&staging), OsStr::new(&name))
        .unwrap();
    drop(catalog);
    assert!(reader.projection(revision, false).unwrap().is_none());
    assert!(
        !Catalog::open_readonly(&store.directory)
            .unwrap()
            .unwrap()
            .document
            .archives[&reader.binding.archive_id]
            .derived[&name]
            .published
    );
    let projection = reader.projection(revision, true).unwrap().unwrap();
    assert_eq!(projection.progress().unwrap().source_records, 0);
    assert_eq!(
        reader
            .directory
            .open_child(OsStr::new(&name), false)
            .unwrap()
            .directory_identity()
            .unwrap(),
        identity
    );
    assert!(
        Catalog::open_readonly(&store.directory)
            .unwrap()
            .unwrap()
            .document
            .archives[&reader.binding.archive_id]
            .derived[&name]
            .published
    );
}

#[test]
fn matching_cache_names_cannot_adopt_an_unowned_or_replaced_directory() {
    let (_root, store, reader) = empty();
    let revision = "fixture/foreign";
    let name = format!(
        "normalized-{}",
        crate::external_history::hash(revision.as_bytes())
    );
    let unowned = reader
        .directory
        .create_private_child(OsStr::new(&name))
        .unwrap();
    unowned
        .atomic_replace(OsStr::new("user-data.md"), b"keep this")
        .unwrap();
    assert!(reader.projection(revision, true).is_err());
    assert!(
        Catalog::open_readonly(&store.directory)
            .unwrap()
            .unwrap()
            .document
            .archives[&reader.binding.archive_id]
            .derived
            .is_empty()
    );
    assert_eq!(
        crate::external_history::read_optional(&unowned, "user-data.md", 100)
            .unwrap()
            .unwrap(),
        b"keep this"
    );
    let revision = "fixture/replaced";
    let name = format!(
        "normalized-{}",
        crate::external_history::hash(revision.as_bytes())
    );
    drop(reader.projection(revision, true).unwrap().unwrap());
    let original = reader
        .directory
        .open_child(OsStr::new(&name), false)
        .unwrap()
        .directory_identity()
        .unwrap();
    reader
        .directory
        .rename_no_replace(OsStr::new(&name), OsStr::new("saved-cache"))
        .unwrap();
    let replacement = reader
        .directory
        .create_private_child(OsStr::new(&name))
        .unwrap();
    let replacement_identity = replacement.directory_identity().unwrap();
    assert_ne!(replacement_identity, original);
    assert!(reader.projection(revision, true).is_err());
    assert_eq!(
        reader
            .directory
            .open_child(OsStr::new("saved-cache"), false)
            .unwrap()
            .directory_identity()
            .unwrap(),
        original
    );
    assert_eq!(
        replacement.directory_identity().unwrap(),
        replacement_identity
    );
    assert!(
        replacement
            .open_single_link_regular_file(OsStr::new("catalog.sqlite3"))
            .is_err(),
        "refusing an unowned cache must not initialize it"
    );
}

#[test]
fn sealed_projection_tree_is_collected_after_all_native_reader_descendants_leave() {
    let (root, store, reader) = empty();
    let archive = reader.binding.archive_id.clone();
    let mut projection = reader
        .projection("fixture/collection", true)
        .unwrap()
        .unwrap();
    projection.finish().unwrap();
    projection.seal_for_collection(|| true).unwrap();
    let prepared = store
        .prepare_archive_retirement("retire-normalized", "first")
        .unwrap();
    let blocked = store
        .run_archive_retirement("retire-normalized", prepared.sequence, || true)
        .unwrap();
    assert!(!blocked.logical_retired);
    drop(reader);
    let blocked = store
        .run_archive_retirement("retire-normalized", blocked.sequence, || true)
        .unwrap();
    assert_eq!(
        blocked.failure_code.as_deref(),
        Some("external_history_retirement_readers_busy")
    );
    drop(projection);
    let collected = store
        .run_archive_retirement("retire-normalized", blocked.sequence, || true)
        .unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
    assert!(collected.collected_bytes > 0);
    assert!(!root.path().join("external-history").join(archive).exists());
}

#[test]
fn changed_sealed_cache_and_unknown_attachment_subtree_are_retained_before_logical_retirement() {
    for injected in ["cache-file", "replaced-sqlite", "unknown-subtree"] {
        let (_root, store, reader) = empty();
        let archive = reader.binding.archive_id.clone();
        let revision = "fixture/preserve-user-change";
        let mut projection = reader.projection(revision, true).unwrap().unwrap();
        projection.finish().unwrap();
        projection.seal_for_collection(|| true).unwrap();
        drop(projection);
        if injected == "cache-file" || injected == "replaced-sqlite" {
            let name = format!(
                "normalized-{}",
                crate::external_history::hash(revision.as_bytes())
            );
            let cache = reader
                .directory
                .open_child(OsStr::new(&name), false)
                .unwrap();
            if injected == "replaced-sqlite" {
                let original = cache
                    .portable_retention_regular_identity(OsStr::new("catalog.sqlite3"))
                    .unwrap();
                let bytes = crate::external_history::read_optional(
                    &cache,
                    "catalog.sqlite3",
                    16 * 1024 * 1024,
                )
                .unwrap()
                .unwrap();
                cache
                    .atomic_replace(OsStr::new("catalog.sqlite3"), &bytes)
                    .unwrap();
                assert_ne!(
                    cache
                        .portable_retention_regular_identity(OsStr::new("catalog.sqlite3"))
                        .unwrap(),
                    original,
                    "equal bytes at a new native identity must not inherit the old seal"
                );
            } else {
                cache
                    .atomic_replace(OsStr::new("user-notes.md"), b"keep this user addition")
                    .unwrap();
            }
        } else {
            reader
                .directory
                .create_private_child(OsStr::new("attachments-v1"))
                .unwrap()
                .atomic_replace(OsStr::new("user-notes.md"), b"never adopt this directory")
                .unwrap();
        }
        let prepared = store
            .prepare_archive_retirement("preserve", "first")
            .unwrap();
        drop(reader);
        let blocked = store
            .run_archive_retirement("preserve", prepared.sequence, || true)
            .unwrap();
        assert!(!blocked.logical_retired);
        assert!(matches!(blocked.phase, ArchiveRetirementPhase::Blocked));
        assert!(store.reader(&archive).is_ok());
    }
}
