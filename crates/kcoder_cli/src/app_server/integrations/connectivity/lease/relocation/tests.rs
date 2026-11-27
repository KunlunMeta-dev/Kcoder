use super::*;
use kcoder_config::storage::{StorageCoordinator, StorageResolveInput, resolve_storage_paths};
use kcoder_native_scope::NativeIdentity;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use std::collections::BTreeSet;

fn global_scope(context: &NativeIntegrationContext) -> IntegrationScope {
    let mut scope = context.scope().clone();
    scope.workspace_id = IntegrationNullable::Null;
    scope.organization_id = None;
    scope
}

fn copy_owned_tree(source: &Path, target: &Path) -> Result<()> {
    let directory = PrivateDirectory::open_existing(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            directory.create_private_child(&entry.file_name())?;
            copy_owned_tree(&entry.path(), &path)?;
        } else {
            ensure!(
                entry.file_type()?.is_file(),
                "owned fixture contains an unsupported entry"
            );
            std::fs::copy(entry.path(), path)?;
        }
    }
    Ok(())
}

async fn source_fixture() -> Result<(
    tempfile::TempDir,
    NativeIntegrationContext,
    NativeConnectivityLeaseFacade,
    tokio::process::Child,
    Arc<NativeConnectivityParent>,
)> {
    let (owned, context) = super::super::test_support::fixture()?;
    let facade = NativeConnectivityLeaseFacade::initialize(&context, "original-initialization")?;
    let (child, parent) = super::super::test_support::owned_parent(&context).await?;
    let lease = facade.acquire(&context, Some(parent.clone()))?;
    let hash = super::super::tests::initialize_node_files(&facade, &context)?;
    facade.commit_ready(
        &context,
        Some(&parent),
        &NativeConnectivityReadyInput {
            lease_id: lease.lease_id,
            namespace_id: lease.namespace_id,
            initialization_id: lease.initialization_id,
            binding_hash: hash,
        },
    )?;
    Ok((owned, context, facade, child, parent))
}

async fn stop_owned(
    facade: &NativeConnectivityLeaseFacade,
    context: &NativeIntegrationContext,
    child: &mut tokio::process::Child,
    parent: &NativeConnectivityParent,
) -> Result<()> {
    child.kill().await?;
    child.wait().await?;
    facade.release_exited_parent(parent)?;
    facade.relocation_source_ready(context)?;
    Ok(())
}

fn target_context(
    owned: &tempfile::TempDir,
    source: &NativeIntegrationContext,
) -> Result<NativeIntegrationContext> {
    let parent = PrivateDirectory::open_existing(owned.path())?;
    let target = parent.create_private_child(OsStr::new("target-profile"))?;
    let path = owned.path().join("target-profile");
    copy_owned_tree(source.captured_profile_path(), &path)?;
    let scope = global_scope(source);
    let identity = NativeIdentity::observe(source.profile()?, &scope)?.unwrap();
    let snapshot = identity.snapshot(source.profile()?)?;
    identity.relocate(
        source.profile()?,
        &target,
        &scope,
        "profile-relocation",
        &snapshot,
    )?;
    NativeIntegrationContext::capture_existing(
        &path,
        &owned.path().join("workspace"),
        "target-reader",
        &source.scope().target_revision,
    )
}

fn node_convert(transaction: &NativeConnectivityRelocation<'_>) -> Result<String> {
    transaction.verify()?;
    let mut verified_paths: Vec<PathBuf> = Vec::new();
    for root in [
        transaction.source_data_path()?,
        transaction.target_data_path()?,
    ] {
        let mut paths = vec![root.clone(), root.with_extension("binding.json")];
        paths.extend(
            [
                "connectivity.sqlite3",
                "connectivity.lock",
                "connectivity.ready.json",
                "connectivity.sqlite3-wal",
                "connectivity.sqlite3-shm",
                "connectivity.sqlite3-journal",
            ]
            .into_iter()
            .map(|name| root.join(name))
            .filter(|path| path.exists()),
        );
        let prior = root.with_extension("relocation.json");
        if prior.exists() {
            paths.push(prior);
        }
        for path in paths {
            transaction.verify_private_path(&path)?;
            verified_paths.push(path);
        }
    }
    let module = kcoder_test_harness::workspace_root()?
        .join("apps/kcoder-channel-host/src/applications/store-bootstrap.mjs")
        .canonicalize()?;
    let url = reqwest::Url::from_file_path(module)
        .map_err(|_| anyhow::anyhow!("fixture URL unavailable"))?;
    let script = "const{relocateStoreFiles}=await import(process.argv[1]);const{resolve}=await import('node:path');const proofs=new Set(JSON.parse(process.argv[7]).map(path=>resolve(path)));const value=relocateStoreFiles({source:process.argv[2],finalTarget:process.argv[3],expectedNamespaceId:process.argv[4],expectedInitializationId:process.argv[5],operationId:process.argv[6],validateOffline(){},nativeWindowsProof:path=>proofs.has(resolve(path)),assertExclusiveLease:()=>true});console.log(value.bindingHash);";
    // This owned fixture retains the real Rust authority across the exact child.
    // Production IPC must call transaction.verify for its callbacks, not accept JSON flags.
    let node = which::which(
        std::env::var_os("KCODER_CONNECTIVITY_TEST_NODE").unwrap_or_else(|| "node".into()),
    )?;
    let output = std::process::Command::new(node)
        .args(["--input-type=module", "-e", script, url.as_str()])
        .arg(transaction.source_data_path()?)
        .arg(transaction.target_data_path()?)
        .arg(transaction.namespace_id())
        .arg(transaction.initialization_id())
        .arg(
            &transaction
                .initial
                .relocation
                .as_ref()
                .unwrap()
                .operation_id,
        )
        .arg(serde_json::to_string(&verified_paths)?)
        .output()?;
    ensure!(
        output.status.success(),
        "owned Node relocation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    transaction.verify()?;
    for path in verified_paths {
        transaction.verify_private_path(&path)?;
    }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}

fn publish_offline_profile(
    outer: &Path,
    source: &Path,
    operation_id: &str,
) -> Result<StoragePublishedComponent> {
    PrivateDirectory::open_existing(outer)?.create_private_child(OsStr::new("operation-home"))?;
    let home = outer.join("operation-home");
    let target = outer.join("offline-target");
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(StorageMigrationPlan {
        version: 1,
        operation_id: operation_id.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.clone(),
            cache_root: outer.join("offline-cache"),
            operation_id: Some(operation_id.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target,
            source_identity: PrivateDirectory::open_existing(source)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })?;
    coordinator.advance(operation_id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(operation_id, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(operation_id, Phase::Stopped, Phase::Copying)?;
    coordinator.publish_component(
        operation_id,
        STORAGE_PERSISTENT_ROOT_DOMAIN,
        &BTreeSet::new(),
    )?;
    coordinator.open_published_component(operation_id, STORAGE_PERSISTENT_ROOT_DOMAIN)
}

#[tokio::test]
async fn offline_registered_owner_preserves_disabled_data_without_a_workspace_context() -> Result<()>
{
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let profile = PrivateDirectory::open_existing(source.captured_profile_path())?;
    let (_, identity, _) =
        NativeIntegrationContext::observe_global_profile(&profile, "offline-revision")?.unwrap();
    identity.disable(&profile, "preserved-disabled-source", 1, 1000)?;
    let expected = identity.snapshot(&profile)?;
    let (global, _, _) =
        NativeIntegrationContext::observe_global_profile(&profile, "offline-revision")?.unwrap();
    let inventory = identity.observe_domains(&profile, "offline-revision")?;
    let entry = inventory
        .domains()
        .iter()
        .find(|entry| entry.domain() == NativeDomain::Connectivity)
        .unwrap();
    let original_log = control::read_bytes(&facade.log_anchor)?;
    let original_initialization = facade.initial.initialization_id.clone();
    std::fs::rename(
        owned.path().join("workspace"),
        owned.path().join("unavailable-workspace"),
    )?;
    assert!(source.verify().is_err());
    let owner = NativeConnectivityLeaseFacade::observe_for_relocation(
        entry,
        &identity,
        &profile,
        source.captured_profile_path(),
    )?;
    let operation_id = "offline-disabled-native-move";
    let published =
        publish_offline_profile(owned.path(), source.captured_profile_path(), operation_id)?;
    let target_identity = identity.relocate(
        &profile,
        published.directory(),
        &global,
        operation_id,
        &expected,
    )?;
    let transaction = owner.prepare_relocation_offline(
        entry,
        &identity,
        &profile,
        &target_identity,
        &published,
    )?;
    assert_eq!(transaction.initialization_id(), original_initialization);
    let hash = node_convert(&transaction)?;
    transaction.commit(&hash)?;
    assert_eq!(target_identity.snapshot(published.directory())?, expected);
    assert!(!expected.enabled);
    let target_inventory =
        target_identity.observe_domains(published.directory(), "offline-revision")?;
    let target_entry = target_inventory
        .domains()
        .iter()
        .find(|entry| entry.domain() == NativeDomain::Connectivity)
        .unwrap();
    let target_owner = NativeConnectivityLeaseFacade::observe_for_relocation(
        target_entry,
        &target_identity,
        published.directory(),
        published.destination_path(),
    )?;
    assert_eq!(
        target_owner.initial.initialization_id,
        original_initialization
    );
    assert_eq!(target_owner.domain.namespace_id(), entry.namespace_id());
    assert_eq!(control::read_bytes(&target_owner.log_anchor)?, original_log);
    assert_eq!(control::read_bytes(&owner.log_anchor)?, original_log);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn formal_native_relocation_keeps_original_log_ids_and_reconciles_lost_ack() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let source_owner = facade.prepare_relocation_source(&source, "same-operation")?;
    assert!(!owned.path().join("target-profile").exists());
    assert_eq!(source_owner.operation_id(), "same-operation");
    assert_eq!(source_owner.namespace_id(), facade.domain.namespace_id());
    assert_eq!(
        source_owner.initialization_id(),
        facade.initial.initialization_id
    );
    assert_eq!(
        source_owner.source_data_path()?,
        facade.private_data_path(&source)?
    );
    let source_data = source_owner.source_data_path()?;
    for path in [
        source_data.clone(),
        source_data.with_extension("binding.json"),
        source_data.join("connectivity.sqlite3"),
        source_data.join("connectivity.lock"),
        source_data.join("connectivity.ready.json"),
    ] {
        source_owner.verify_private_path(&path)?;
    }
    assert!(
        source_owner
            .verify_private_path(source.captured_profile_path())
            .is_err()
    );
    // A private file outside the fixed owner leaves is never a proof candidate.
    let unknown = source_data.join("unrelated.txt");
    std::fs::write(&unknown, b"unrelated")?;
    assert_eq!(
        source_owner
            .verify_private_path(&unknown)
            .unwrap_err()
            .to_string(),
        "CONNECTIVITY_PRIVATE_PATH_DENIED"
    );
    std::fs::remove_file(unknown)?;
    use std::os::fd::AsRawFd;
    let source_descriptor = source_owner.kernel.file().as_raw_fd();
    let directory = facade.verify(&source)?;
    assert!(
        directory
            .try_existing_portable_lock(
                OsStr::new(control::LOCK),
                &facade.initial.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .is_none()
    );
    let target = target_context(&owned, &source)?;
    source_owner.verify()?;
    assert!(NativeConnectivityLeaseFacade::observe(&target).is_err());
    let original_log = control::read_bytes(&facade.log_anchor)?;
    let original_init = control::read_bytes(&facade.initial_anchor)?;
    let transaction = source_owner.prepare_target(&target)?;
    transaction.verify_private_path(&source_data)?;
    let target_data = transaction.target_data_path()?;
    for path in [
        target_data.clone(),
        target_data.with_extension("binding.json"),
        target_data.join("connectivity.sqlite3"),
        target_data.join("connectivity.lock"),
        target_data.join("connectivity.ready.json"),
    ] {
        transaction.verify_private_path(&path)?;
    }
    let journal = target_data.join("connectivity.sqlite3-journal");
    std::fs::write(&journal, b"")?;
    transaction.verify_private_path(&journal)?;
    std::fs::remove_file(journal)?;
    assert_eq!(
        transaction.source.kernel.file().as_raw_fd(),
        source_descriptor
    );
    assert!(
        directory
            .try_existing_portable_lock(
                OsStr::new(control::LOCK),
                &facade.initial.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .is_none()
    );
    assert!(transaction.query()?.is_none());
    let hash = node_convert(&transaction)?;
    let committed = transaction.commit(&hash)?;
    let new_facade = NativeConnectivityLeaseFacade::observe(&target)?.unwrap();
    new_facade.relocation_source_ready(&target)?;
    assert_eq!(
        new_facade.initial.initialization_id,
        facade.initial.initialization_id
    );
    assert_eq!(new_facade.initial.owner, facade.initial.owner);
    assert_eq!(control::read_bytes(&new_facade.log_anchor)?, original_log);
    assert_eq!(control::read_bytes(&facade.initial_anchor)?, original_init);
    assert_eq!(control::read_bytes(&facade.log_anchor)?, original_log);
    let before = control::read_bytes(&new_facade.initial_anchor)?;
    let transaction = facade.prepare_relocation(&source, &target, "same-operation")?;
    assert_eq!(transaction.query()?, Some(committed.clone()));
    assert_eq!(transaction.commit(&hash)?, committed);
    assert_eq!(control::read_bytes(&new_facade.initial_anchor)?, before);
    assert!(
        facade
            .prepare_relocation(&source, &target, "another-operation")
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn published_native_ready_before_domain_commit_resumes_the_same_operation() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let target = target_context(&owned, &source)?;
    let mut transaction = facade.prepare_relocation(&source, &target, "interrupted-publication")?;
    let hash = node_convert(&transaction)?;
    let directory = transaction.domain.target_directory();
    let ready = control::verify_node_store(
        directory,
        &transaction.target_data,
        transaction.namespace_id(),
        &transaction.initial,
    )?;
    transaction.initial =
        receipt::append_ready(&mut transaction.initial_anchor, &transaction.initial, ready)?;
    directory.publish_prepared(
        OsStr::new(&transaction.initial_name),
        OsStr::new(control::INIT),
        &PrivateDirectory::identity_of_file(&transaction.initial_anchor)?,
    )?;
    let committed_init = control::read_bytes(&transaction.initial_anchor)?;
    drop(transaction);
    // A complete Ready is readable after cold open. It does not complete the
    // original coordinator/domain transaction or grant a new writer lease.
    let observed = NativeConnectivityLeaseFacade::observe(&target)?.unwrap();
    observed.relocation_source_ready(&target)?;
    assert_eq!(
        control::read_bytes(&observed.initial_anchor)?,
        committed_init
    );
    let transaction = facade.prepare_relocation(&source, &target, "interrupted-publication")?;
    assert!(transaction.query()?.is_none());
    transaction.commit(&hash)?;
    let target = NativeConnectivityLeaseFacade::observe(&target)?.unwrap();
    assert_eq!(control::read_bytes(&target.initial_anchor)?, committed_init);
    Ok(())
}

#[tokio::test]
async fn stopped_copy_preserves_the_original_node_binding_hash_under_both_kernel_leases()
-> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let target = target_context(&owned, &source)?;
    let transaction = facade.prepare_relocation(&source, &target, "no-node-conversion")?;
    let source_hash = transaction.source_binding_hash()?.to_owned();
    let copied_binding = std::fs::read(
        transaction
            .target_data_path()?
            .with_extension("binding.json"),
    )?;
    let ready = transaction.commit(&source_hash)?;
    assert_eq!(ready.binding_hash, source_hash);
    NativeConnectivityLeaseFacade::observe(&target)?
        .unwrap()
        .relocation_source_ready(&target)?;
    assert_eq!(
        std::fs::read(
            target
                .captured_profile_path()
                .join(facade.domain.namespace_id())
                .join("data.binding.json")
        )?,
        copied_binding
    );
    facade.relocation_source_ready(&source)?;
    Ok(())
}

#[tokio::test]
async fn real_active_parent_and_peer_kernel_lease_prevent_native_preparation() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    assert!(!owned.path().join("target-profile").exists());
    assert!(
        facade
            .prepare_relocation_source(&source, "active-parent")
            .is_err()
    );
    let fresh = NativeConnectivityLeaseFacade::observe(&source)?.unwrap();
    assert!(
        fresh
            .prepare_relocation_source(&source, "original-kernel-held")
            .is_err()
    );
    child.kill().await?;
    child.wait().await?;
    let source_owner = facade.prepare_relocation_source(&source, "after-exit")?;
    assert_eq!(source_owner.exited_parents.len(), 1);
    assert_eq!(source_owner.exited_parents[0].id, parent.id);
    source_owner.verify()?;
    assert!(
        fresh
            .prepare_relocation_source(&source, "source-owner-still-held")
            .is_err()
    );
    let target = target_context(&owned, &source)?;
    let transaction = source_owner.prepare_target(&target)?;
    transaction.verify()?;
    assert!(transaction.query()?.is_none());
    Ok(())
}

#[tokio::test]
async fn source_only_owner_rechecks_revocation_before_any_target_copy() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let source_owner = facade.prepare_relocation_source(&source, "source-only-revocation")?;
    source_owner.verify()?;
    let data_path = source_owner.source_data_path()?;
    source_owner.verify_private_path(&data_path)?;
    let scope = global_scope(&source);
    let identity = NativeIdentity::observe(source.profile()?, &scope)?.unwrap();
    let snapshot = identity.snapshot(source.profile()?)?;
    identity.disable(
        source.profile()?,
        "revoke-before-copy",
        snapshot.revision,
        1000,
    )?;
    assert!(source_owner.verify().is_err());
    assert!(source_owner.source_data_path().is_err());
    assert!(source_owner.verify_private_path(&data_path).is_err());
    assert!(!owned.path().join("target-profile").exists());
    Ok(())
}

#[tokio::test]
async fn source_only_owner_rejects_coherent_binding_replacement_under_the_same_scope() -> Result<()>
{
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let source_owner = facade.prepare_relocation_source(&source, "source-metadata-replacement")?;
    let directory = facade.verify(&source)?;
    let data = control::data_directory(&directory, &facade.initial)?;
    let binding_file = directory.open_read_write_file(OsStr::new("data.binding.json"), false)?;
    let ready_file = data.open_read_write_file(OsStr::new("connectivity.ready.json"), false)?;
    let mut binding: serde_json::Value =
        serde_json::from_slice(&control::read_bytes(&binding_file)?)?;
    let mut ready: serde_json::Value = serde_json::from_slice(&control::read_bytes(&ready_file)?)?;
    binding["schemaHash"] = receipt::digest(b"owned source metadata replacement").into();
    let replacement_hash = control::hash_json(&binding)?;
    assert_ne!(replacement_hash, source_owner.source_binding_hash()?);
    ready["bindingHash"] = replacement_hash.into();
    // Rewrite only owned metadata in place. The namespace, initialization,
    // epoch, all file identities and every SQLite business row remain intact.
    use std::io::{Seek, SeekFrom, Write};
    for (mut file, value) in [(binding_file, binding), (ready_file, ready)] {
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        serde_json::to_writer(&mut file, &value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    let current = control::verify_node_store(
        &directory,
        &data,
        source_owner.namespace_id(),
        &facade.initial,
    )?;
    match (&source_owner.ready, &current) {
        (
            BootstrapEntry::Ready {
                namespace_id: original_namespace,
                binding_hash: original_hash,
                files: original_files,
            },
            BootstrapEntry::Ready {
                namespace_id,
                binding_hash,
                files,
            },
        ) => {
            assert_eq!(namespace_id, original_namespace);
            assert_eq!(files, original_files);
            assert_ne!(binding_hash, original_hash);
        }
        _ => anyhow::bail!("owned fixture did not preserve Ready metadata"),
    }
    assert_eq!(source.source_authority_epoch()?, source_owner.source_epoch);
    assert_eq!(
        control::read_bytes(&facade.initial_anchor)?,
        source_owner.source_initial_bytes
    );
    assert_eq!(
        control::read_bytes(&facade.log_anchor)?,
        source_owner.source_log_bytes
    );
    let error = source_owner.verify().unwrap_err().to_string();
    assert!(error.contains("CONNECTIVITY_NODE_STORAGE_CHANGED"));
    assert!(source_owner.source_data_path().is_err());
    assert!(!owned.path().join("target-profile").exists());
    Ok(())
}

#[tokio::test]
async fn source_revocation_after_node_conversion_cannot_publish_native_ready() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let target = target_context(&owned, &source)?;
    let transaction = facade.prepare_relocation(&source, &target, "revoked-source")?;
    let hash = node_convert(&transaction)?;
    let scope = global_scope(&source);
    let identity = NativeIdentity::observe(source.profile()?, &scope)?.unwrap();
    let snapshot = identity.snapshot(source.profile()?)?;
    identity.disable(
        source.profile()?,
        "revoke-before-native-ready",
        snapshot.revision,
        1000,
    )?;
    assert!(transaction.verify().is_err());
    assert!(transaction.commit(&hash).is_err());
    assert!(NativeConnectivityLeaseFacade::observe(&target).is_err());
    Ok(())
}

#[tokio::test]
async fn pending_v2_init_and_tampered_original_log_never_become_ready() -> Result<()> {
    let (owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let target = target_context(&owned, &source)?;
    let transaction = facade.prepare_relocation(&source, &target, "pending-init")?;
    assert!(control::read_initialization(&transaction.initial_anchor).is_err());
    let hash = node_convert(&transaction)?;
    transaction.commit(&hash)?;
    let current = NativeConnectivityLeaseFacade::observe(&target)?.unwrap();
    let directory = current.verify(&target)?;
    let log = directory.open_read_write_file(OsStr::new(control::LOG), false)?;
    let original = control::read_bytes(&log)?;
    use std::io::Write;
    (&log).write_all(&[b" ".as_slice(), original.as_slice()].concat())?;
    log.sync_all()?;
    assert!(current.relocation_source_ready(&target).is_err());
    assert!(NativeConnectivityLeaseFacade::observe(&target).is_err());
    Ok(())
}

#[tokio::test]
async fn legacy_media_is_reported_by_read_only_preflight_before_preparation() -> Result<()> {
    let (_owned, source, facade, mut child, parent) = source_fixture().await?;
    stop_owned(&facade, &source, &mut child, &parent).await?;
    let directory = facade.verify(&source)?;
    let data = control::data_directory(&directory, &facade.initial)?;
    let lease = directory
        .try_existing_portable_lock(
            OsStr::new(control::LOCK),
            &facade.initial.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    // A legacy media record is an unsupported input, never a migration receipt.
    // The owned fixture uses actual held identities and grants no media authority.
    control::append_log(
        &directory,
        &BootstrapEntry::MediaReady {
            namespace_id: facade.domain.namespace_id().into(),
            directory_identity: data.directory_identity()?,
            files_identity: data.directory_identity()?,
            journal_identity: facade.initial.log_identity.clone(),
            directory_birth_ns: 0,
            files_birth_ns: 0,
            journal_birth_ns: 0,
        },
    )?;
    drop(lease);
    let before = control::read_bytes(&facade.log_anchor)?;
    let error = facade
        .relocation_source_ready(&source)
        .unwrap_err()
        .to_string();
    assert!(error.contains("CONNECTIVITY_RELOCATION_MEDIA_UNSUPPORTED"));
    assert!(error.contains(control::LOG));
    assert_eq!(control::read_bytes(&facade.log_anchor)?, before);
    Ok(())
}
