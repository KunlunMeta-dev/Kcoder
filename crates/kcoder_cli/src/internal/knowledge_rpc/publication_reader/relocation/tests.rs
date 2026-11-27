use super::*;
use crate::publication_reader::{Binding, OBJECTS, PublicationAnchors};
use kcoder_knowledge::KnowledgeCatalog;
use std::io::Write;

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    PrivateDirectory::open_or_create(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[test]
fn binding_convergence_native_publication_copies_twice_without_new_placement_history() -> Result<()>
{
    for legacy in [false, true] {
        let root = tempfile::tempdir()?;
        let mut path = root.path().join("source");
        let profile = PrivateDirectory::open_or_create(&path)?;
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&workspace)?;
        let native =
            NativeIntegrationContext::capture(&path, &workspace, "source", "configuration")?;
        let scope = native.scope().clone();
        let namespace = NativeDomainGuard::expected_namespace_id(&scope, NativeDomain::Knowledge)?;
        NativeDomainGuard::initialize(
            &profile,
            &scope,
            NativeDomain::Knowledge,
            "initialize",
            |directory| {
                let db = directory.open_read_write_file(OsStr::new(DB), true)?;
                let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
                let objects = directory.create_private_child(OsStr::new(OBJECTS))?;
                let mut file = directory.open_read_write_file(OsStr::new(BINDING), true)?;
                let binding = Binding {
                    version: 1,
                    owner: KnowledgeOwner::from(&scope),
                    namespace_identity: directory.directory_identity()?,
                    binding_identity: directory.portable_regular_handle_identity(&file)?,
                    database_identity: directory.portable_regular_handle_identity(&db)?,
                    lock_identity: directory.portable_regular_handle_identity(&lock)?,
                    objects_identity: objects.directory_identity()?,
                    relocation: None,
                };
                let catalog = KnowledgeCatalog::open_native_owned(
                    directory,
                    &binding.database_identity,
                    &binding.lock_identity,
                    &path.join(&namespace).join(OBJECTS),
                    true,
                )?;
                catalog.with_catalog(|catalog| catalog.initialize_native_publication_schema())?;
                file.write_all(&serde_json::to_vec(&binding)?)?;
                file.sync_all()?;
                Ok(())
            },
        )?;
        if legacy {
            let owner = NativePublicationRelocation::observe(
                &path,
                &scope,
                KnowledgeRelocationLimits::default(),
            )?
            .unwrap();
            let mut prior = owner.relocation_snapshot()?;
            prior.profile_identity = "historical-profile".into();
            prior.catalog.directory_identity = "historical-namespace".into();
            drop(owner);
            let directory = PrivateDirectory::open_existing(&path.join(&namespace))?;
            let mut binding = read_binding(&directory)?;
            binding.version = 2;
            binding.relocation = Some(PublicationRelocationReceipt {
                operation_id: "historical-operation".into(),
                source: prior,
            });
            directory.atomic_replace(OsStr::new(BINDING), &serde_json::to_vec(&binding)?)?;
        }
        let initial = read_binding(&PrivateDirectory::open_existing(&path.join(&namespace))?)?;
        for step in 0..2 {
            let owner = NativePublicationRelocation::observe(
                &path,
                &scope,
                KnowledgeRelocationLimits::default(),
            )?
            .unwrap();
            let prepared = owner.prepare_relocation()?;
            let snapshot = prepared.relocation_snapshot()?;
            let target = root.path().join(format!("target-{step}"));
            let operation = format!("move-{step}");
            copy_tree(&path, &target)?;
            let source_profile = PrivateDirectory::open_existing(&path)?;
            let target_profile = PrivateDirectory::open_existing(&target)?;
            ProfileIdentity::observe(&source_profile)?.relocate(
                &source_profile,
                &target_profile,
                &operation,
            )?;
            let (global, identity, epoch) =
                NativeIntegrationContext::observe_global_profile(&source_profile, "configuration")?
                    .unwrap();
            identity.relocate(
                &source_profile,
                &target_profile,
                &global,
                &operation,
                &epoch,
            )?;
            prepared.relocate(&target, &operation, &snapshot)?;
            owner.verify_relocation(&target, &operation, &snapshot)?;
            let directory = PrivateDirectory::open_existing(&target.join(&namespace))?;
            let binding = read_binding(&directory)?;
            let mut expected = initial.clone();
            expected.lock_identity = binding.lock_identity.clone();
            assert!(binding == expected);
            let anchors = PublicationAnchors::observe(&directory, &binding)?;
            KnowledgeCatalog::open_existing_native_owned(
                &directory,
                &anchors.database_identity()?,
                &binding.lock_identity,
                &target.join(&namespace).join(OBJECTS),
                &tokio_util::sync::CancellationToken::new(),
                Default::default(),
            )?
            .with_catalog(|_| Ok(()))?;
            let old = target.join("held-objects");
            std::fs::rename(target.join(&namespace).join(OBJECTS), &old)?;
            directory.create_private_child(OsStr::new(OBJECTS))?;
            assert!(anchors.verify(&directory, &binding).is_err());
            std::fs::remove_dir(target.join(&namespace).join(OBJECTS))?;
            std::fs::rename(old, target.join(&namespace).join(OBJECTS))?;
            path = target;
        }
    }
    Ok(())
}
