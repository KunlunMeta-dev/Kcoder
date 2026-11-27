use super::*;
use crate::{KnowledgeCatalog, KnowledgeScope, relocated_profile_credential_file};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use rusqlite::{Connection, config::DbConfig};

struct Fixture {
    _root: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    external: PathBuf,
    library: String,
    page: String,
    job: String,
    call: String,
}
fn fixture(wal: bool) -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("source");
    let target = root.path().join("target");
    let external = root.path().join("external-project");
    for path in [&source, &target, &external] {
        PrivateDirectory::open_or_create(path)?;
    }
    PrivateDirectory::open_existing(&source)?.create_private_child(OsStr::new("knowledge"))?;
    let scope = personal_profile_scope(&source)?;
    let mut catalog = KnowledgeCatalog::open(&source.join("knowledge/state.sqlite"))?;
    if wal {
        catalog
            .connection
            .pragma_update(None, "journal_mode", "WAL")?;
        catalog
            .connection
            .pragma_update(None, "wal_autocheckpoint", 0)?;
        catalog
            .connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    }
    let library = catalog.create(&scope, "library-create", "Original Wiki", "")?;
    let input = catalog.import_text(
        &scope,
        &library.id,
        "original",
        &external.display().to_string(),
        "A durable original fact.",
    )?;
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    for (id, related) in [(&a, vec![]), (&b, vec![a.clone()])] {
        catalog.commit_generated_pages(
            &scope,
            &library.id,
            id,
            vec![KnowledgePageDraft {
                page_id: id.clone(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "Evidence".into(),
                markdown: "A durable original fact.".into(),
                citations: vec![KnowledgeCitation {
                    source_id: input.source_id.clone(),
                    revision_id: input.revision_id.clone(),
                    chunk_id: "chunk-1".into(),
                    quote: "durable".into(),
                }],
                related_page_ids: related,
            }],
        )?;
    }
    let job = catalog.enqueue_ingest(
        &scope,
        &library.id,
        "unfinished-job",
        &input.source_id,
        &input.revision_id,
        "original-recipe",
        "en",
    )?;
    let lease = catalog
        .claim_job(&scope, &library.id, &job.id)?
        .context("test lease")?;
    // Reservation is deliberately never settled: no model is created or called.
    let call = catalog
        .budget_reserve(&scope, &library.id, &lease, 3)?
        .context("test reservation")?
        .id()
        .to_owned();
    catalog.remember_json_response(
        &scope,
        &library.id,
        &lease,
        &"b".repeat(64),
        r#"{"candidate":"received, not validated"}"#,
    )?;
    let account = KnowledgeScope::from_authenticated_host("explicit-account", "execution-host")?;
    catalog.create(&account, "account-library", "Account Wiki", "")?;
    drop(catalog);
    Ok(Fixture {
        _root: root,
        source,
        target,
        external,
        library: library.id,
        page: b,
        job: job.id,
        call,
    })
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            PrivateDirectory::open_or_create(&to)?;
            copy_tree(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}
fn copy_and_map(source: &Path, target: &Path, operation: &str) -> Result<()> {
    copy_tree(source, target)?;
    let source = PrivateDirectory::open_existing(source)?;
    let target = PrivateDirectory::open_existing(target)?;
    ProfileIdentity::observe(&source)?.relocate(&source, &target, operation)?;
    Ok(())
}

#[test]
fn binding_convergence_wiki_does_not_append_a_root_for_every_move() -> Result<()> {
    let f = fixture(false)?;
    let owner = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let expected = owner.relocation_snapshot()?;
    copy_and_map(&f.source, &f.target, "first-move")?;
    owner.relocate(&f.target, "first-move", &expected)?;
    let moved = WikiRelocation::observe(&f.target, KnowledgeRelocationLimits::default())?.unwrap();
    let next = moved.relocation_snapshot()?;
    assert_eq!(next.source_profiles, expected.source_profiles);
    Ok(())
}

#[test]
fn legacy_principal_and_absent_observation_are_read_only() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(root.path())?;
    assert_eq!(
        personal_profile_scope(root.path())?.principal,
        format!("profile:{}", root.path().canonicalize()?.display())
    );
    assert!(WikiRelocation::observe(root.path(), KnowledgeRelocationLimits::default())?.is_none());
    let mut entries = 0;
    profile.visit_entry_names_bounded(1, |_| {
        entries += 1;
        Ok(())
    })?;
    assert_eq!(entries, 0);
    Ok(())
}

#[test]
fn wiki_created_after_an_empty_profile_move_uses_its_actual_legacy_principal() -> Result<()> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("empty-source");
    let target = root.path().join("new-wiki");
    let source_directory = PrivateDirectory::open_or_create(&source)?;
    let target_directory = PrivateDirectory::open_or_create(&target)?;
    ProfileIdentity::observe(&source_directory)?.relocate(
        &source_directory,
        &target_directory,
        "empty-profile-move",
    )?;
    let scope = personal_profile_scope(&target)?;
    target_directory.create_private_child(OsStr::new("knowledge"))?;
    let mut catalog = KnowledgeCatalog::open(&target.join("knowledge/state.sqlite"))?;
    let library = catalog.create(&scope, "first-after-move", "New Wiki", "")?;
    assert_eq!(personal_profile_scope(&target)?.principal, scope.principal);
    assert_eq!(
        catalog
            .read(&personal_profile_scope(&target)?, &library.id)?
            .id,
        library.id
    );
    assert!(!target.join("knowledge/.profile-scope.json").exists());
    Ok(())
}

#[test]
fn offline_wiki_move_preserves_graph_unknown_calls_and_exact_principals() -> Result<()> {
    for wal in [false, true] {
        let f = fixture(wal)?;
        let original = personal_profile_scope(&f.source)?.principal;
        let owner =
            WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
        let snapshot = owner.relocation_snapshot()?;
        let source_bytes = std::fs::read(f.source.join("knowledge/state.sqlite"))?;
        copy_and_map(&f.source, &f.target, "wiki-move")?;
        assert_eq!(
            personal_profile_scope(&f.target)?.principal,
            format!("profile:{}", f.target.canonicalize()?.display())
        );
        assert!(
            owner
                .verify_relocation(&f.target, "wiki-move", &snapshot)
                .is_err()
        );
        owner.relocate(&f.target, "wiki-move", &snapshot)?;
        let receipt = std::fs::read(f.target.join("knowledge/.profile-scope.json"))?;
        owner.relocate(&f.target, "wiki-move", &snapshot)?;
        owner.verify_relocation(&f.target, "wiki-move", &snapshot)?;
        assert_eq!(
            receipt,
            std::fs::read(f.target.join("knowledge/.profile-scope.json"))?
        );
        assert!(
            owner
                .relocate(&f.target, "new-operation", &snapshot)
                .is_err()
        );
        assert_eq!(
            std::fs::read(f.source.join("knowledge/state.sqlite"))?,
            source_bytes
        );
        assert_eq!(personal_profile_scope(&f.target)?.principal, original);
        let directory = PrivateDirectory::open_existing(&f.target.join("knowledge"))?;
        let reader = KnowledgeCatalog::open_existing_native_directory(
            directory,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            &tokio_util::sync::CancellationToken::new(),
            crate::integrations::knowledge::CatalogReadLimits::default(),
        )?;
        reader.with_catalog(|catalog| {
            let personal = personal_profile_scope(&f.target)?;
            assert_eq!(catalog.read_page(&personal, &f.library, &f.page, None)?.draft.related_page_ids.len(), 1);
            let job = catalog.read_job(&personal, &f.library, &f.job)?;
            assert_eq!(job.status, "running");
            assert_eq!(job.recipe_key, "original-recipe");
            let facts: (i64, Option<i64>, Option<i64>) = catalog.connection.query_row(
                "SELECT completed,input_tokens,output_tokens FROM knowledge_job_calls WHERE call_id=?1",
                [&f.call], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            assert_eq!(facts, (0, None, None));
            let cached: String = catalog.connection.query_row("SELECT body_json FROM knowledge_stage_cache WHERE library_id=?1", [&f.library], |row| row.get(0))?;
            assert_eq!(cached, r#"{"candidate":"received, not validated"}"#);
            let title: String = catalog.connection.query_row("SELECT title FROM knowledge_sources WHERE library_id=?1", [&f.library], |row| row.get(0))?;
            assert_eq!(title, f.external.display().to_string());
            let account = KnowledgeScope::from_authenticated_host("explicit-account", "execution-host")?;
            assert_eq!(catalog.list(&account, None, 10)?.len(), 1);
            assert!(catalog.read(&account, &f.library).is_err());
            Ok(())
        })?;
        assert_eq!(owner.relocation_snapshot()?, snapshot);
    }
    Ok(())
}

#[test]
fn worker_credential_address_maps_across_moves_without_rewriting_frozen_snapshot() -> Result<()> {
    let f = fixture(false)?;
    let profile = PrivateDirectory::open_existing(&f.source)?;
    profile.atomic_replace(OsStr::new("provider.env"), b"fixture-source-reference-only")?;
    let original = f.source.join("provider.env");
    let models = PrivateDirectory::open_existing(&f.source.join("knowledge"))?
        .create_private_child(OsStr::new("worker-models"))?;
    let frozen =
        serde_json::to_vec(&serde_json::json!({"credential":{"credential_file":original}}))?;
    let name = format!("{}.json", "a".repeat(64));
    models.atomic_replace(OsStr::new(&name), &frozen)?;
    let first = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let first_snapshot = first.relocation_snapshot()?;
    copy_and_map(&f.source, &f.target, "move-one")?;
    first.relocate(&f.target, "move-one", &first_snapshot)?;
    assert_eq!(
        relocated_profile_credential_file(&f.target, &original)?,
        f.target.join("provider.env")
    );
    assert_eq!(
        relocated_profile_credential_file(&f.target, &f.external.join("external.env"))?,
        f.external.join("external.env")
    );
    let later_address = f.target.join("provider.env");
    let later_snapshot =
        serde_json::to_vec(&serde_json::json!({"credential":{"credential_file":later_address}}))?;
    let later_name = format!("{}.json", "c".repeat(64));
    PrivateDirectory::open_existing(&f.target.join("knowledge/worker-models"))?
        .atomic_replace(OsStr::new(&later_name), &later_snapshot)?;
    let third = f._root.path().join("third");
    PrivateDirectory::open_or_create(&third)?;
    let second = WikiRelocation::observe(&f.target, KnowledgeRelocationLimits::default())?.unwrap();
    let second_snapshot = second.relocation_snapshot()?;
    copy_and_map(&f.target, &third, "move-two")?;
    second.relocate(&third, "move-two", &second_snapshot)?;
    assert_eq!(
        relocated_profile_credential_file(&third, &original)?,
        third.join("provider.env")
    );
    assert_eq!(
        relocated_profile_credential_file(&third, &later_address)?,
        third.join("provider.env")
    );
    assert_eq!(
        std::fs::read(third.join("knowledge/worker-models").join(&later_name))?,
        later_snapshot
    );
    let record =
        profile_scope::read_record(&PrivateDirectory::open_existing(&third.join("knowledge"))?)?
            .unwrap()
            .0;
    assert_eq!(record.source_profiles.len(), 1);
    assert_eq!(record.credential_files.len(), 2);
    assert_eq!(
        std::fs::read(third.join("knowledge/worker-models").join(&name))?,
        frozen
    );
    std::fs::remove_file(third.join("provider.env"))?;
    assert!(relocated_profile_credential_file(&third, &original).is_err());
    Ok(())
}

#[test]
fn altered_copy_corrupt_source_and_unknown_entries_block_without_scope_publication() -> Result<()> {
    let f = fixture(false)?;
    let owner = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let expected = owner.relocation_snapshot()?;
    copy_and_map(&f.source, &f.target, "move")?;
    let target = Connection::open(f.target.join("knowledge/state.sqlite"))?;
    target.execute(
        "UPDATE libraries SET name='altered' WHERE id=?1",
        [&f.library],
    )?;
    drop(target);
    assert!(owner.relocate(&f.target, "move", &expected).is_err());
    assert!(!f.target.join("knowledge/.profile-scope.json").exists());
    std::fs::write(f.source.join("knowledge/unknown-owner.json"), b"preserve")?;
    assert!(owner.preview_relocation().is_err());
    assert!(owner.relocation_snapshot().is_err());
    std::fs::remove_file(f.source.join("knowledge/unknown-owner.json"))?;
    let db = Connection::open(f.source.join("knowledge/state.sqlite"))?;
    db.execute_batch("PRAGMA user_version=999;")?;
    assert!(owner.relocation_snapshot().is_err());
    Ok(())
}

#[test]
fn preview_and_normal_scope_do_not_hash_revision_objects() -> Result<()> {
    let f = fixture(false)?;
    let owner = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let before = owner.preview_relocation()?;
    let object = std::fs::read_dir(f.source.join("knowledge/state.objects").join(&f.library))?
        .next()
        .unwrap()?
        .path();
    std::fs::write(object, b"damaged original object")?;
    assert_eq!(
        personal_profile_scope(&f.source)?.principal,
        format!("profile:{}", f.source.display())
    );
    assert!(owner.preview_relocation()?.entries == before.entries);
    assert!(owner.relocation_snapshot().is_err());
    Ok(())
}

#[test]
fn prepared_source_excludes_independent_sqlite_writers_and_reuses_same_lease_for_wal_and_delete()
-> Result<()> {
    for wal in [false, true] {
        let f = fixture(wal)?;
        let owner =
            WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
        let prepared = owner.prepare_relocation()?;
        let contender = Connection::open(f.source.join("knowledge/state.sqlite"))?;
        contender.busy_timeout(std::time::Duration::ZERO)?;
        contender.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
        let failure = contender
            .execute(
                "UPDATE libraries SET name='unaccepted writer' WHERE id=?1",
                [&f.library],
            )
            .unwrap_err();
        assert!(matches!(failure, rusqlite::Error::SqliteFailure(error, _)
            if matches!(error.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)));
        drop(contender);
        // WAL-absent source locks are exclusive. Reopening a second VFS lease
        // here would self-conflict; the prepared path shares the original FD.
        let expected = prepared.relocation_snapshot()?;
        copy_and_map(&f.source, &f.target, "prepared-move")?;
        prepared.relocate(&f.target, "prepared-move", &expected)?;
        owner.verify_relocation(&f.target, "prepared-move", &expected)?;
        let writer = Connection::open(f.source.join("knowledge/state.sqlite"))?;
        writer.busy_timeout(std::time::Duration::ZERO)?;
        assert_eq!(
            writer.execute(
                "UPDATE libraries SET name='after lease release' WHERE id=?1",
                [&f.library]
            )?,
            1
        );
    }
    Ok(())
}

#[test]
fn copied_scope_receipt_profile_replacement_and_small_budget_fail_closed() -> Result<()> {
    let f = fixture(false)?;
    let owner = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let expected = owner.relocation_snapshot()?;
    copy_and_map(&f.source, &f.target, "move")?;
    owner.relocate(&f.target, "move", &expected)?;
    let third = f._root.path().join("third");
    PrivateDirectory::open_or_create(&third)?;
    copy_tree(&f.target, &third)?;
    assert_eq!(
        personal_profile_scope(&third)?.principal,
        personal_profile_scope(&f.target)?.principal
    );
    assert!(
        WikiRelocation::observe(
            &f.source,
            KnowledgeRelocationLimits {
                entries: 1,
                ..KnowledgeRelocationLimits::default()
            }
        )?
        .unwrap()
        .relocation_snapshot()
        .is_err()
    );
    std::fs::rename(&f.target, f._root.path().join("old-target"))?;
    PrivateDirectory::open_or_create(&f.target)?;
    assert!(
        owner
            .verify_relocation(&f.target, "move", &expected)
            .is_err()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn external_symlink_and_hardlinked_objects_are_never_followed() -> Result<()> {
    let f = fixture(false)?;
    let owner = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    std::os::unix::fs::symlink(&f.external, f.source.join("knowledge/worker-models"))?;
    assert!(owner.relocation_snapshot().is_err());
    std::fs::remove_file(f.source.join("knowledge/worker-models"))?;
    let object_dir = f.source.join("knowledge/state.objects").join(&f.library);
    let object = std::fs::read_dir(&object_dir)?.next().unwrap()?.path();
    std::fs::hard_link(&object, f.external.join("peer"))?;
    assert!(owner.relocation_snapshot().is_err());
    Ok(())
}

#[test]
fn legacy_64_root_record_can_move_repeatedly_without_extending_compatibility_history() -> Result<()>
{
    let f = fixture(false)?;
    let first = WikiRelocation::observe(&f.source, KnowledgeRelocationLimits::default())?.unwrap();
    let snapshot = first.relocation_snapshot()?;
    copy_and_map(&f.source, &f.target, "initial")?;
    first.relocate(&f.target, "initial", &snapshot)?;
    let knowledge = PrivateDirectory::open_existing(&f.target.join("knowledge"))?;
    let mut legacy = profile_scope::read_record(&knowledge)?.unwrap().0;
    legacy.version = 1;
    while legacy.source_profiles.len() < 63 {
        let n = legacy.source_profiles.len();
        legacy.source_profiles.push(ProfileAddress {
            path: f._root.path().join(format!("historical-{n}")),
            identity: format!("historical-{n}"),
        });
    }
    legacy.source_profiles.push(ProfileAddress {
        path: f._root.path().join("historical-last"),
        identity: legacy.source_profile_identity.clone(),
    });
    knowledge.atomic_replace(
        OsStr::new(profile_scope::RECORD),
        &serde_json::to_vec(&legacy)?,
    )?;
    let mut current = f.target.clone();
    let mut frozen = None;
    for n in 0..5 {
        let op = format!("later-{n}");
        let next = f._root.path().join(&op);
        PrivateDirectory::open_or_create(&next)?;
        let owner =
            WikiRelocation::observe(&current, KnowledgeRelocationLimits::default())?.unwrap();
        owner.preview_relocation()?;
        let snapshot = owner.relocation_snapshot()?;
        copy_and_map(&current, &next, &op)?;
        owner.relocate(&next, &op, &snapshot)?;
        let (record, bytes) =
            profile_scope::read_record(&PrivateDirectory::open_existing(&next.join("knowledge"))?)?
                .unwrap();
        assert_eq!(record.source_profiles.len(), 64);
        assert_eq!(record.principal, legacy.principal);
        if let Some(original) = &frozen {
            assert_eq!(&bytes, original);
        } else {
            frozen = Some(bytes);
        }
        current = next;
    }
    Ok(())
}
