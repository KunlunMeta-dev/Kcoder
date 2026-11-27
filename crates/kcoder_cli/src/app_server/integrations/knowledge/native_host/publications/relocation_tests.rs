use super::*;
use kcoder_config::profile_identity::ProfileIdentity;
use kcoder_knowledge::relocation::{KnowledgeRelocationLimits, WikiRelocation};
use kcoder_knowledge_rpc::publication_reader::relocation::NativePublicationRelocation;

#[test]
fn binding_convergence_publication_reads_copied_history_with_the_original_catalog_lock()
-> Result<()> {
    let (f, publication) = published(false)?;
    let target = f._root.path().join("cold-copy");
    prepare_copy(&f, &target, "cold-publication")?;
    let namespace =
        NativeDomainGuard::expected_namespace_id(f.native.scope(), NativeDomain::Knowledge)?;
    let source = f.profile.join(&namespace);
    let copied = target.join(&namespace);
    std::fs::remove_file(copied.join(LOCK))?;
    std::fs::rename(source.join(LOCK), copied.join(LOCK))?;
    let before = std::fs::read(copied.join(BINDING))?;
    let native = NativeIntegrationContext::capture_existing(
        &target,
        &f._root.path().join("workspace"),
        "copied",
        "configuration",
    )?;
    let host = NativeKnowledgeHost::new(&native, settings())?;
    let store = host.observe_publications()?.unwrap();
    store.verify(&native)?;
    let response = host.knowledge("resolvePublication", &request(&host,None,None,json!({"owner":publication.owner,"publicationId":publication.draft.publication_id,"version":1})), false, 3000, &CancellationToken::new());
    assert_eq!(
        response.status,
        IntegrationStatus::Completed,
        "{:?}",
        response.error
    );
    assert_eq!(
        response.result.as_ref().unwrap()["publication"]["pages"][0]["markdown"],
        publication.pages[0].markdown
    );
    assert_eq!(std::fs::read(copied.join(BINDING))?, before);
    Ok(())
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
fn published(revoke: bool) -> Result<(Fixture, KnowledgePublication)> {
    let f = fixture()?;
    let (source, _, draft) = seed(&f)?;
    let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
    let host =
        NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
    let cancel = CancellationToken::new();
    let result = host.knowledge(
        "publishKnowledge",
        &request(
            &host,
            Some("publish-original"),
            Some(0),
            json!({"draft":draft}),
        ),
        true,
        1000,
        &cancel,
    );
    assert_eq!(
        result.status,
        IntegrationStatus::Completed,
        "{:?}",
        result.error
    );
    let publication: KnowledgePublication =
        serde_json::from_value(result.result.as_ref().unwrap()["publication"].clone())?;
    if revoke {
        let result = host.knowledge("revokePublication", &request(&host, Some("revoke-original"), Some(1),
            json!({"owner":publication.owner,"publicationId":publication.draft.publication_id,"version":1})), true, 2000, &cancel);
        assert_eq!(result.status, IntegrationStatus::Completed);
    }
    drop(host);
    drop(source);
    Ok((f, publication))
}
fn prepare_copy(f: &Fixture, target: &Path, operation: &str) -> Result<()> {
    prepare_profile_copy(&f.profile, target, operation)
}
fn prepare_profile_copy(profile: &Path, target: &Path, operation: &str) -> Result<()> {
    PrivateDirectory::open_or_create(target)?;
    copy_tree(profile, target)?;
    let source = PrivateDirectory::open_existing(profile)?;
    let target_directory = PrivateDirectory::open_existing(target)?;
    ProfileIdentity::observe(&source)?.relocate(&source, &target_directory, operation)?;
    let (global, identity, snapshot) =
        NativeIntegrationContext::observe_global_profile(&source, "configuration")?.unwrap();
    identity.relocate(&source, &target_directory, &global, operation, &snapshot)?;
    let wiki = WikiRelocation::observe(profile, KnowledgeRelocationLimits::default())?.unwrap();
    wiki.relocate(target, operation, &wiki.relocation_snapshot()?)?;
    Ok(())
}

#[test]
fn publication_relocation_changes_only_the_writer_lock_pin_and_keeps_original_receipts()
-> Result<()> {
    for revoked in [false, true] {
        let (f, publication) = published(revoked)?;
        let source = NativePublicationRelocation::observe(
            &f.profile,
            f.native.scope(),
            KnowledgeRelocationLimits::default(),
        )?
        .unwrap();
        let prepared = source.prepare_relocation()?;
        let expected = prepared.relocation_snapshot()?;
        let target = f._root.path().join("target");
        prepare_copy(&f, &target, "publication-move")?;
        prepared.relocate(&target, "publication-move", &expected)?;
        source.verify_relocation(&target, "publication-move", &expected)?;
        let target_native = NativeIntegrationContext::capture_existing(
            &target,
            &f._root.path().join("workspace"),
            "new-connection",
            "configuration",
        )?;
        assert_eq!(target_native.scope(), f.native.scope());
        let host = NativeKnowledgeHost::new(&target_native, settings())?;
        let store = host.observe_publications()?.unwrap();
        assert_eq!(store.binding.version, 1);
        assert!(store.binding.relocation.is_none());
        let mut source_binding = read_binding(&PrivateDirectory::open_existing(&f.profile.join(
            NativeDomainGuard::expected_namespace_id(f.native.scope(), NativeDomain::Knowledge)?,
        ))?)?;
        source_binding.lock_identity = store.binding.lock_identity.clone();
        assert!(source_binding == store.binding);
        assert_eq!(store.binding.owner, publication.owner);
        let before_binding = read_binding(&store.directory)?;
        let before_identity = store
            .directory
            .portable_regular_identity(OsStr::new(BINDING))?;
        drop(store);
        source.relocate(&target, "publication-move", &expected)?;
        let store = host.observe_publications()?.unwrap();
        assert!(read_binding(&store.directory)? == before_binding);
        assert_eq!(
            store
                .directory
                .portable_regular_identity(OsStr::new(BINDING))?,
            before_identity
        );
        drop(store);
        assert!(
            source
                .relocate(&target, "unrelated-operation", &expected)
                .is_err()
        );
        let read = request(
            &host,
            None,
            None,
            json!({"owner":publication.owner,
            "publicationId":publication.draft.publication_id,"version":1}),
        );
        let result = host.knowledge(
            "resolvePublication",
            &read,
            false,
            3000,
            &CancellationToken::new(),
        );
        if revoked {
            assert_eq!(result.status, IntegrationStatus::Rejected);
            assert!(result.result.as_ref().is_none());
        } else {
            assert_eq!(
                result.status,
                IntegrationStatus::Completed,
                "{:?}",
                result.error
            );
            assert_eq!(
                result.result.as_ref().unwrap()["publication"]["pages"][0]["markdown"],
                publication.pages[0].markdown
            );
        }
        assert!(source.relocation_snapshot()? == expected);
    }
    Ok(())
}

#[test]
fn disabled_native_epoch_stays_disabled_and_stale_snapshot_never_publishes() -> Result<()> {
    let (f, _) = published(false)?;
    let scope = f.native.scope().clone();
    let owner = NativePublicationRelocation::observe(
        &f.profile,
        &scope,
        KnowledgeRelocationLimits::default(),
    )?
    .unwrap();
    let stale = owner.relocation_snapshot()?;
    let profile = PrivateDirectory::open_existing(&f.profile)?;
    let (_, identity, snapshot) =
        NativeIntegrationContext::observe_global_profile(&profile, "configuration")?.unwrap();
    identity.disable(&profile, "disable-original", snapshot.revision, 2000)?;
    let expected = owner.relocation_snapshot()?;
    let target = f._root.path().join("target");
    prepare_copy(&f, &target, "disabled-move")?;
    assert!(owner.relocate(&target, "disabled-move", &stale).is_err());
    owner.relocate(&target, "disabled-move", &expected)?;
    owner.verify_relocation(&target, "disabled-move", &expected)?;
    let (_, _, observed) = NativeIntegrationContext::observe_global_profile(
        &PrivateDirectory::open_existing(&target)?,
        "configuration",
    )?
    .unwrap();
    assert!(!observed.enabled);
    assert!(
        NativeIntegrationContext::capture_existing(
            &target,
            &f._root.path().join("workspace"),
            "connection",
            "configuration"
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn altered_copy_and_replaced_object_root_cannot_receive_publication_binding() -> Result<()> {
    let (f, _) = published(false)?;
    let owner = NativePublicationRelocation::observe(
        &f.profile,
        f.native.scope(),
        KnowledgeRelocationLimits::default(),
    )?
    .unwrap();
    let expected = owner.relocation_snapshot()?;
    let target = f._root.path().join("target");
    prepare_copy(&f, &target, "bad-copy")?;
    let namespace =
        NativeDomainGuard::expected_namespace_id(f.native.scope(), NativeDomain::Knowledge)?;
    let database = target.join(&namespace).join(DB);
    let connection = rusqlite::Connection::open(&database)?;
    connection.execute(
        "UPDATE integration_publication_receipts SET intent_json='changed'",
        [],
    )?;
    drop(connection);
    assert!(owner.relocate(&target, "bad-copy", &expected).is_err());
    assert_eq!(
        read_binding(&PrivateDirectory::open_existing(&target.join(&namespace))?)?.version,
        1
    );
    let source_objects = f.profile.join(&namespace).join(OBJECTS);
    std::fs::rename(&source_objects, f.profile.join("original-objects"))?;
    PrivateDirectory::open_or_create(&source_objects)?;
    assert!(owner.relocation_snapshot().is_err());
    Ok(())
}
