use super::*;
use kcoder_config::storage::{
    StorageComponentDirectory, StorageResolveInput, resolve_storage_paths,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_native_service_runtime::connectivity::{
    NativeConnectivityExitProof, NativeConnectivityLeaseFacade, NativeConnectivityParent,
    NativeConnectivityReadyInput,
};
use kcoder_process_supervisor::owned_process::output;
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
    StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use std::{collections::BTreeSet, fs, path::Path, process::Stdio, sync::Arc};

fn owner_command(root: &Path) -> Command {
    let mut command = Command::new(which::which("node").unwrap());
    command
        .arg(root.join("apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs"))
        .env("KCODER_TARGET_DIR", root.join("target"))
        .current_dir(root);
    command
}

async fn initialize_owned_source(
    root: &Path,
    context: &NativeIntegrationContext,
    facade: &NativeConnectivityLeaseFacade,
    crash_wal: bool,
) -> Result<()> {
    let mut child = Command::new("/bin/sleep")
        .arg(if crash_wal { "60" } else { "30" })
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let prepared = async {
        let parent = Arc::new(NativeConnectivityParent::capture(context, &mut child,
            NativeConnectivityExitProof::OwnedNoDescendantsFixture)?);
        let lease = facade.acquire(context, Some(parent.clone()))?;
        let module = reqwest::Url::from_file_path(root.join(
            "apps/kcoder-channel-host/src/applications/store-bootstrap.mjs"))
            .map_err(|_| anyhow::anyhow!("owned source URL unavailable"))?;
        // This initializes only the fresh owned fixture. The actual original
        // Native lease above remains held throughout this fixed child call.
        let script = "const{createStoreFiles}=await import(process.argv[1]);const{readFileSync}=await import('node:fs');const{createHash}=await import('node:crypto');createStoreFiles(process.argv[2],{namespaceId:process.argv[3],initializationId:process.argv[4],assertExclusiveLease:()=>true});const value=JSON.parse(readFileSync(process.argv[2]+'.binding.json','utf8'));function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}console.log(createHash('sha256').update(JSON.stringify(sort(value))).digest('hex'));";
        let mut command = Command::new(which::which("node")?);
        command.args(["--input-type=module", "-e", script, module.as_str()])
            .arg(facade.private_data_path(context)?)
            .arg(&lease.namespace_id).arg(&lease.initialization_id);
        let result = output(&mut command, None, 1024, 8192, Duration::from_secs(15), None).await?;
        ensure!(result.status.success(), "owned initializer failed: {}",
            String::from_utf8_lossy(&result.stderr));
        let lease_id = lease.lease_id.clone();
        facade.commit_ready(context, Some(&parent), &NativeConnectivityReadyInput {
            lease_id: lease.lease_id, namespace_id: lease.namespace_id,
            initialization_id: lease.initialization_id,
            binding_hash: String::from_utf8(result.stdout)?.trim().into(),
        })?;
        if crash_wal {
            facade.require_ready(context, Some(&parent), &lease_id)?;
            let module = reqwest::Url::from_file_path(root.join(
                "apps/kcoder-channel-host/src/applications/store.mjs"))
                .map_err(|_| anyhow::anyhow!("owned writer URL unavailable"))?;
            // Reuse the original store writer under the real Ready lease, then
            // bypass close so committed business rows remain in a nonempty WAL.
            let script = r#"const {ConnectivityStore}=await import(process.argv[1]);
const store=ConnectivityStore.open(process.argv[2],{assertExclusiveLease:()=>true});
const scope={accountId:'alice',targetId:'local',workspaceId:'project',identityGeneration:'generation-7',targetRevision:'9'};
store.db.exec('PRAGMA wal_autocheckpoint=0');
store.beginOperation(scope,'crashed-accepted-operation','external-send',{businessId:'message-17'});
store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)').run('owner','send-17',JSON.stringify(scope),'original-intent','unknown',17,'{"body":"retained"}','lease-7',0,'{"externalOutcome":"unknown"}');
process.exit(0);"#;
            let mut writer = Command::new(which::which("node")?);
            writer.args(["--input-type=module", "-e", script, module.as_str()])
                .arg(facade.private_data_path(context)?);
            let result = output(&mut writer, None, 1024, 8192, Duration::from_secs(15), None).await?;
            ensure!(result.status.success(), "owned crash writer failed: {}",
                String::from_utf8_lossy(&result.stderr));
            facade.require_ready(context, Some(&parent), &lease_id)?;
        }
        Ok::<_, anyhow::Error>(parent)
    }.await;
    let _ = child.kill().await;
    child.wait().await?;
    let parent = prepared?;
    facade.release_exited_parent(&parent)?;
    facade.relocation_source_ready(context).map(|_| ())
}

/// Real original Native lease -> live parent IPC -> actual component copy and
/// publication -> formal identity conversion -> live target IPC -> Native Ready.
/// This deliberately does not claim the still-unwired full-product plan/verifier.
#[cfg(unix)]
async fn run_real_native_profile_relocation(
    with_profile_owners: bool,
    crash_wal: bool,
) -> Result<()> {
    let root = kcoder_test_harness::workspace_root()?;
    let home = tempfile::tempdir()?;
    let legacy = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.path().into()),
        ..Default::default()
    })?;
    let original = with_profile_owners.then(|| StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: legacy.data_root.clone(),
        cache_root: home.path().join("SourceCache"),
        operation_id: None,
    });
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.path().into()),
        record: original.clone(),
        ..Default::default()
    })?;
    fs::create_dir_all(&from.data_root)?;
    if let Some(original) = &original {
        fs::write(
            home.path().join(".config/kcoder-storage.json"),
            serde_json::to_vec(original)?,
        )?;
    }
    let settings = b"// owned migration fixture\n{\"max_retries\":3}\n";
    if with_profile_owners {
        fs::write(from.data_root.join("settings.json"), settings)?;
    }
    let wiki = if with_profile_owners {
        let directory = kcoder_config::PrivateDirectory::open_existing(&from.data_root)?;
        directory.create_child(std::ffi::OsStr::new("knowledge"))?;
        let scope = kcoder_knowledge::personal_profile_scope(&from.data_root)?;
        let mut catalog = kcoder_knowledge::KnowledgeCatalog::open(
            &from.data_root.join("knowledge/state.sqlite"),
        )?;
        let library = catalog.create(&scope, "owned-library", "Original Wiki", "")?;
        Some((scope, library))
    } else {
        None
    };
    let workspace = home.path().join("workspace");
    fs::create_dir(&workspace)?;
    let workflow = if with_profile_owners {
        let definition =
            kcoder_workflow::store::WorkflowStore::new(from.data_root.join("workflow-library"))
                .create("Original workflow", "")?;
        let run = kcoder_types::workflow_runs::WorkflowRunSnapshot {
            revision: 1,
            run_id: "original-workflow-run".into(),
            definition_id: Some(definition.id.clone()),
            version: None,
            thread_id: "original-thread".into(),
            workspace: workspace.display().to_string(),
            status: "running".into(),
            error: None,
            started_at_ms: 1,
            updated_at_ms: 1,
            resume_count: 0,
            interaction_modified: false,
            node_states: vec![],
        };
        drop(kcoder_tools::workflow_runs::RunObservation::start(
            from.data_root.join("workflow-runs"),
            run.clone(),
        )?);
        let bytes = fs::read(
            from.data_root
                .join("workflow-runs/original-workflow-run.json"),
        )?;
        Some((definition, run, bytes))
    } else {
        None
    };
    let source = NativeIntegrationContext::capture(
        &from.data_root,
        &workspace,
        "original-source",
        "configuration-1",
    )?;
    let facade = NativeConnectivityLeaseFacade::initialize(&source, "original-store")?;
    initialize_owned_source(&root, &source, &facade, crash_wal).await?;
    if with_profile_owners && !crash_wal {
        // A checkpointed older store can legitimately lack volatile coordination
        // leaves. Its first read-only SQLite open must happen before inventory.
        let database = facade
            .private_data_path(&source)?
            .join("connectivity.sqlite3");
        assert!(!database.with_file_name("connectivity.sqlite3-wal").exists());
        assert!(!database.with_file_name("connectivity.sqlite3-shm").exists());
    }
    let original_database = fs::read(
        facade
            .private_data_path(&source)?
            .join("connectivity.sqlite3"),
    )?;
    let original_binding = fs::read(
        facade
            .private_data_path(&source)?
            .with_extension("binding.json"),
    )?;
    let source_data = facade.private_data_path(&source)?;
    let source_initial = source_data
        .parent()
        .unwrap()
        .join("channel-host-initialization.json");
    let original_initial = fs::read(&source_initial)?;
    let crash_wal_bytes = if crash_wal {
        let bytes = fs::read(source_data.join("connectivity.sqlite3-wal"))?;
        assert!(
            bytes.len() > 32,
            "the committed fixture must retain actual WAL frames"
        );
        Some(bytes)
    } else {
        None
    };
    let original_shm_identity = crash_wal
        .then(|| {
            kcoder_config::PrivateDirectory::open_existing(&source_data)?
                .portable_regular_identity(std::ffi::OsStr::new("connectivity.sqlite3-shm"))
        })
        .transpose()?;
    let id = "native-offline-core-pipeline";
    let target = StorageLocationRecord {
        version: 1,
        revision: original.as_ref().map_or(1, |record| record.revision + 1),
        data_root: home.path().join("Data"),
        cache_root: home.path().join("Cache"),
        operation_id: Some(id.into()),
    };
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original,
        components: vec![StorageMigrationComponent {
            domain: "persistent-root".into(),
            source: from.data_root.clone(),
            destination: target.data_root.clone(),
            source_identity: source.profile()?.directory_identity()?,
            estimated_bytes: 0,
        }],
        from,
        target: target.clone(),
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(home.path())?;
    coordinator.begin(plan)?;
    coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
    let prepared = if with_profile_owners {
        None
    } else {
        let prepared = facade.prepare_relocation_source(&source, id)?;
        verify_connectivity_source(&mut coordinator, id, &mut owner_command(&root), &prepared)
            .await?;
        Some(prepared)
    };
    coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
    let published = if with_profile_owners {
        let evidence = home
            .path()
            .join(".config/kcoder-storage-migrations")
            .join(id);
        super::super::storage_profile::copy_and_relocate_profile(
            &mut coordinator,
            id,
            &NoCredentialAccess,
            None,
            &evidence,
            Some(&mut owner_command(&root)),
        )
        .await?
    } else {
        assert!(matches!(
            coordinator.prepare_component_staging(id, "persistent-root")?,
            StorageComponentDirectory::Staging(_)
        ));
        assert!(matches!(
            coordinator.publish_component(id, "persistent-root", &BTreeSet::new())?,
            StorageComponentDirectory::Published(_)
        ));
        let published = coordinator.open_published_component(id, "persistent-root")?;
        let (scope, identity, snapshot) = NativeIntegrationContext::observe_global_profile(
            source.profile()?,
            &source.scope().target_revision,
        )?
        .context("original identity missing")?;
        identity.relocate(
            source.profile()?,
            published.directory(),
            &scope,
            id,
            &snapshot,
        )?;
        let target_context = NativeIntegrationContext::capture_existing(
            &target.data_root,
            &workspace,
            "target-reader",
            &source.scope().target_revision,
        )?;
        let unrelated = home.path().join("unrelated-native-data");
        fs::create_dir(&unrelated)?;
        let error = declared_store_target(
            &coordinator,
            facade.namespace_id(&source)?,
            &facade.private_data_path(&source)?,
            Some(&unrelated),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "STORAGE_OFFLINE_DOMAIN_MISMATCH");
        assert!(fs::read_dir(&unrelated)?.next().is_none());
        let transaction = prepared
            .context("original source lease missing")?
            .prepare_target(&target_context)?;
        relocate_connectivity_store(&mut coordinator, id, &mut owner_command(&root), transaction)
            .await?;
        published
    };
    let target_context = NativeIntegrationContext::capture_existing(
        &target.data_root,
        &workspace,
        "target-reader",
        &source.scope().target_revision,
    )?;
    let target_facade = NativeConnectivityLeaseFacade::observe(&target_context)?
        .context("final original store missing")?;
    target_facade.relocation_source_ready(&target_context)?;
    assert_eq!(
        fs::read(
            facade
                .private_data_path(&source)?
                .join("connectivity.sqlite3")
        )?,
        original_database
    );
    assert_eq!(
        fs::read(
            facade
                .private_data_path(&source)?
                .with_extension("binding.json")
        )?,
        original_binding
    );
    // A lost Ready reply reconciles the exact operation without another Node load.
    let transaction = facade.prepare_relocation(&source, &target_context, id)?;
    let receipt = transaction
        .query()?
        .context("actual sealed owner did not return a Ready receipt")?;
    let mut must_not_spawn = Command::new(home.path().join("missing-helper"));
    let reconciled =
        relocate_connectivity_store(&mut coordinator, id, &mut must_not_spawn, transaction).await?;
    assert_eq!(
        serde_json::to_value(receipt)?,
        serde_json::to_value(reconciled)?
    );
    assert_eq!(coordinator.current()?.unwrap().phase, Phase::Copying);
    if with_profile_owners {
        let (definition, run, bytes) = workflow.as_ref().unwrap();
        assert_eq!(
            fs::read(
                target
                    .data_root
                    .join("workflow-runs/original-workflow-run.json")
            )?,
            *bytes
        );
        let library =
            kcoder_workflow::store::WorkflowStore::new(target.data_root.join("workflow-library"));
        assert_eq!(library.read(&definition.id)?.title, definition.title);
        let restored =
            kcoder_tools::workflow_runs::read(target.data_root.join("workflow-runs"), &run.run_id)?;
        assert_eq!(restored.workspace, run.workspace);
        assert_eq!(restored.thread_id, run.thread_id);
        assert_eq!(restored.status, "interrupted");
        assert_eq!(restored.resume_count, 0);
        let (scope, library) = wiki.as_ref().unwrap();
        let target_scope = kcoder_knowledge::personal_profile_scope(&target.data_root)?;
        let catalog = kcoder_knowledge::KnowledgeCatalog::open(
            &target.data_root.join("knowledge/state.sqlite"),
        )?;
        assert_eq!(catalog.read(&target_scope, &library.id)?.name, library.name);
        assert_eq!(catalog.read(scope, &library.id)?.name, library.name);
        drop(catalog);
        assert_eq!(
            fs::read(source.captured_profile_path().join("settings.json"))?,
            settings
        );
        assert_eq!(fs::read(target.data_root.join("settings.json"))?, settings);
        let current = coordinator.current()?.unwrap();
        assert!(
            current
                .owner_receipts
                .contains_key("source-retirement-native")
        );
        assert!(
            current
                .owner_receipts
                .contains_key("native-profile-attachments")
        );
        assert!(
            !target
                .data_root
                .join("kcoder-storage-retired-native.json")
                .exists()
        );
    }
    published.verify()?;
    assert!(!target.cache_root.exists());
    if with_profile_owners {
        let native_path = facade.private_data_path(&source)?;
        for suffix in ["-wal", "-shm"] {
            assert!(
                native_path
                    .join(format!("connectivity.sqlite3{suffix}"))
                    .is_file()
            );
        }
        let target_initial = target
            .data_root
            .join(native_path.parent().unwrap().file_name().unwrap())
            .join("channel-host-initialization.json");
        let before = fs::read(&target_initial)?;
        // Source preparation may update the SHM coordination index before the
        // inventory. After copying, its exact frozen bytes remain strict input
        // to original-ID recovery and the coordinator's commit recheck.
        let copied_source_shm = fs::read(native_path.join("connectivity.sqlite3-shm"))?;
        let evidence = home
            .path()
            .join(".config/kcoder-storage-migrations")
            .join(id);
        // Lose the entire coordinator interval after conversion, then reconcile
        // the original copy and owner receipts rather than initialize again.
        drop(coordinator);
        let mut coordinator = StorageCoordinator::acquire(home.path())?;
        let resumed = super::super::storage_profile::copy_and_relocate_profile(
            &mut coordinator,
            id,
            &NoCredentialAccess,
            None,
            &evidence,
            Some(&mut owner_command(&root)),
        )
        .await?;
        resumed.verify()?;
        assert_eq!(fs::read(target_initial)?, before);
        assert_eq!(coordinator.current()?.unwrap().plan.operation_id, id);
        coordinator.advance(id, Phase::Copying, Phase::Verifying)?;
        coordinator.advance(id, Phase::Verifying, Phase::Prepared)?;
        coordinator.commit(id)?;
        let completed = coordinator.complete(id)?;
        assert_eq!(completed.phase, Phase::Verified);
        assert_eq!(completed.plan.operation_id, id);
        assert_eq!(
            fs::read(native_path.join("connectivity.sqlite3"))?,
            original_database
        );
        assert_eq!(
            fs::read(native_path.with_extension("binding.json"))?,
            original_binding
        );
        assert_eq!(fs::read(&source_initial)?, original_initial);
        assert_eq!(
            fs::read(native_path.join("connectivity.sqlite3-shm"))?,
            copied_source_shm
        );
        if let Some(original_wal) = crash_wal_bytes {
            assert_eq!(
                fs::read(native_path.join("connectivity.sqlite3-wal"))?,
                original_wal
            );
            assert_eq!(
                kcoder_config::PrivateDirectory::open_existing(&native_path)?
                    .portable_regular_identity(std::ffi::OsStr::new("connectivity.sqlite3-shm"))?,
                original_shm_identity.unwrap()
            );
            let module = reqwest::Url::from_file_path(
                root.join("apps/kcoder-channel-host/src/applications/store-bootstrap.mjs"),
            )
            .map_err(|_| anyhow::anyhow!("owned reader URL unavailable"))?;
            let script = r#"const {openStoreFiles}=await import(process.argv[1]);
const store=openStoreFiles(process.argv[2]);try {
const row=store.db.prepare("SELECT state,lease,result_json FROM outbox WHERE id='send-17'").get();
if(JSON.stringify({...row})!==JSON.stringify({state:'unknown',lease:'lease-7',result_json:'{"externalOutcome":"unknown"}'}))throw Error('crashed WAL business receipt missing');
} finally {store.close();}"#;
            let mut reader = Command::new(which::which("node")?);
            reader
                .args(["--input-type=module", "-e", script, module.as_str()])
                .arg(target_facade.private_data_path(&target_context)?);
            let result =
                output(&mut reader, None, 1024, 8192, Duration::from_secs(15), None).await?;
            ensure!(
                result.status.success(),
                "owned WAL reader failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
    Ok(())
}

struct NoCredentialAccess;
impl kcoder_config::CredentialBackend for NoCredentialAccess {
    fn describe(&self) -> String {
        "owned fixture without credentials".into()
    }
    fn available(&self) -> bool {
        panic!("migration must not probe unrelated OS credentials")
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        anyhow::bail!("unexpected credential read")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("unexpected credential write")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("unexpected credential deletion")
    }
}

#[tokio::test]
async fn original_native_owner_survives_real_copy_and_live_node_relocation() -> Result<()> {
    run_real_native_profile_relocation(false, false).await
}

#[tokio::test]
async fn original_native_owner_composes_profile_owners_before_final_ready() -> Result<()> {
    run_real_native_profile_relocation(true, false).await
}

#[tokio::test]
async fn crashed_nonempty_sealed_wal_survives_source_preparation_and_original_id_recovery()
-> Result<()> {
    run_real_native_profile_relocation(true, true).await
}
