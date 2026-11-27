//! Cold persistence facts and live fence observations have different lifetimes.
use super::*;
use kcoder_config::storage::{
    StorageCoordinator, StoragePublishedComponent, StorageResolveInput, resolve_storage_paths,
};
use kcoder_types::integrations::core::{
    AppServerHostIdentity, AppServerHostLaunchSpec, IntegrationRevisionRef,
    NATIVE_CODE_SERVICE_TEMPLATE_V1, NativeCodeServiceIntent, NativeCodeServiceLaunchSpec,
    NativeCodeServiceRecord, NativeCodeServiceTask, NativeScopeHostLaunchSpec,
    NativeScopeHostResources,
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};
use std::path::Path;

pub(super) fn private_root() -> Result<tempfile::TempDir> {
    let directory = tempfile::tempdir()?;
    Ok(directory)
}

fn scope() -> IntegrationScope {
    serde_json::from_value(serde_json::json!({
        "accountId":"owner", "targetId":"target", "workspaceId":"workspace",
        "identityGeneration":"original", "targetRevision":"configuration"
    }))
    .unwrap()
}

fn code(
    store: &IntegrationServiceLeaseStore,
    profile: &Path,
    workspace: &Path,
    id: &str,
) -> Result<()> {
    let task = NativeCodeServiceTask {
        definition_id: "saved-definition".into(),
        version: 1,
        definition_sha256: "a".repeat(64),
        args: serde_json::json!({}),
        runtime_operation_id: format!("runtime-{id}"),
    };
    let intent = NativeCodeServiceIntent {
        template: NATIVE_CODE_SERVICE_TEMPLATE_V1.into(),
        lease_id: id.into(),
        operation_id: format!("approve-{id}"),
        scope: scope(),
        definition_id: task.definition_id.clone(),
        definition_version: task.version,
        definition_sha256: task.definition_sha256.clone(),
        task_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&task)?)),
        configuration_sha256: "b".repeat(64),
        native_image_sha256: "c".repeat(64),
        expires_at_ms: 10_000,
    };
    store.prepare_native_code(
        &intent,
        &NativeCodeServiceLaunchSpec {
            schema_version: 1,
            lease_id: id.into(),
            profile_path: profile.into(),
            workspace_path: workspace.into(),
            settings_file: profile.join("settings.json"),
            task,
        },
    )?;
    store.commit_native_code(NativeCodeServiceRecord {
        schema_version: 1,
        revision: 1,
        intent,
        grant_ref: IntegrationRevisionRef {
            id: format!("grant-{id}"),
            revision: "1".into(),
        },
        state: NativeCodeServiceState::Approved,
        enabled: true,
        observed_at_ms: 100,
    })?;
    Ok(())
}

fn populate(
    parent: &PrivateDirectory,
    profile: &Path,
    workspace: &Path,
) -> Result<IntegrationServiceLeaseStore> {
    let store = populate_gateway(parent, profile, workspace)?;
    code(&store, profile, workspace, "unknown")?;
    assert!(store.claim_native_code_runtime("unknown")?);
    store.transition_native_code("unknown", 2, NativeCodeServiceState::OutcomeUnknown, 200)?;
    code(&store, profile, workspace, "revoked")?;
    store.transition_native_code("revoked", 1, NativeCodeServiceState::Revoked, 200)?;
    Ok(store)
}

fn populate_gateway(
    parent: &PrivateDirectory,
    profile: &Path,
    workspace: &Path,
) -> Result<IntegrationServiceLeaseStore> {
    PrivateDirectory::open_or_create(profile)?;
    PrivateDirectory::open_or_create(workspace)?;
    let store = IntegrationServiceLeaseStore::create_in(parent, OsStr::new("leases"), &scope())?;
    drop(
        store
            .try_claim_gateway_app_server()?
            .context("initial gateway slot")?,
    );
    store.prepare_scope_host(
        &NativeScopeHostLaunchSpec {
            schema_version: 1,
            scope: scope(),
            profile_path: profile.into(),
            workspace_path: workspace.into(),
            settings_file: profile.join("settings.json"),
            configuration_sha256: "a".repeat(64),
            native_image_sha256: "b".repeat(64),
            office: None,
            resources: NativeScopeHostResources {
                component_root: profile.join("component"),
                component_manifest_sha256: "c".repeat(64),
                node_program: profile.join("node"),
                node_image_sha256: "d".repeat(64),
                runtime_mode: "standalone_node".into(),
                node_version: None,
                electron_version: None,
            },
        },
        "original-legacy-host",
    )?;
    let mut specification = AppServerHostLaunchSpec {
        schema_version: 1,
        identity: AppServerHostIdentity::from(&scope()),
        profile_path: profile.into(),
        workspace_path: workspace.into(),
        settings_file: profile.join("settings.json"),
        native_image_sha256: "a".repeat(64),
        office: None,
    };
    store.select_app_server_host(&specification, true, None, "original-host-selection")?;
    specification.native_image_sha256 = "b".repeat(64);
    store.select_app_server_host(&specification, true, Some(1), "next-host-selection")?;
    Ok(store)
}

fn bytes(directory: &PrivateDirectory) -> Result<BTreeMap<OsString, Vec<u8>>> {
    let mut entries = BTreeMap::new();
    directory.visit_entry_names_bounded(1024, |name| {
        entries.insert(
            name.into(),
            read_file(directory.open_single_link_regular_file(name)?)?,
        );
        Ok(())
    })?;
    Ok(entries)
}

fn copy(source: &PrivateDirectory, target_parent: &PrivateDirectory) -> Result<()> {
    let target = target_parent.create_private_child(OsStr::new("leases"))?;
    for (name, bytes) in bytes(source)? {
        target.atomic_replace(&name, &bytes)?;
    }
    Ok(())
}

fn publish(
    outer: &Path,
    source: &Path,
    target: &Path,
    operation: &str,
) -> Result<(StorageCoordinator, StoragePublishedComponent)> {
    let home = outer.join(format!("control-{operation}"));
    PrivateDirectory::open_existing(outer)?
        .create_private_child(OsStr::new(&format!("control-{operation}")))?;
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: outer.join(format!("cache-{operation}")),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: PrivateDirectory::open_existing(source)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: outer.into(),
            ancestor_identity: PrivateDirectory::open_existing(outer)?.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })?;
    coordinator.advance(operation, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(operation, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(operation, Phase::Stopped, Phase::Copying)?;
    coordinator.publish_component(
        operation,
        STORAGE_PERSISTENT_ROOT_DOMAIN,
        &std::collections::BTreeSet::new(),
    )?;
    let published =
        coordinator.open_published_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    Ok((coordinator, published))
}

fn pins(directory: &PrivateDirectory) -> Result<(Vec<u8>, Option<Vec<u8>>)> {
    let gateway =
        match directory.open_single_link_regular_file(OsStr::new(app_server_host::GATEWAY_SLOT)) {
            Ok(file) => Some(read_file(file)?),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
    Ok((read(directory, "owner.json")?, gateway))
}

#[test]
fn gateway_fence_placement_twice_preserves_history_and_current_record_shape() -> Result<()> {
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source_root = parent.create_private_child(OsStr::new("source"))?;
    let namespace = OsStr::new("services-domain");
    let source_parent = source_root.create_private_child(namespace)?;
    let profile = root.path().join("old-profile");
    let workspace = root.path().join("old-workspace");
    let source = populate_gateway(&source_parent, &profile, &workspace)?;
    let history = source.app_server_host_selections()?;
    let legacy = source.list_scope_hosts()?;
    let original = pins(&source.directory)?;
    source.preview_gateway_fence_relocation()?;
    let (mut first_owner, first) = publish(
        root.path(),
        &root.path().join("source"),
        &root.path().join("first"),
        "first-move",
    )?;
    std::fs::rename(&profile, root.path().join("retained-profile"))?;
    std::fs::rename(&workspace, root.path().join("retained-workspace"))?;
    let first_namespace = first.directory().open_child(namespace, false)?;
    assert!(
        IntegrationServiceLeaseStore::open_in(&first_namespace, OsStr::new("leases"), &scope())
            .is_err()
    );
    assert!(
        source
            .verify_gateway_fence_relocation(&first, namespace)
            .is_err()
    );
    source.relocate_gateway_fences(&mut first_owner, &first, namespace)?;
    let first_store =
        IntegrationServiceLeaseStore::open_in(&first_namespace, OsStr::new("leases"), &scope())?;
    first_owner.advance(first.operation_id(), Phase::Copying, Phase::Verifying)?;
    first_owner.advance(first.operation_id(), Phase::Verifying, Phase::Prepared)?;
    first_owner.commit(first.operation_id())?;
    first_owner.complete(first.operation_id())?;
    drop(first_owner);
    let (mut second_owner, second) = publish(
        root.path(),
        first.destination_path(),
        &root.path().join("second"),
        "second-move",
    )?;
    first_store.relocate_gateway_fences(&mut second_owner, &second, namespace)?;
    let second_namespace = second.directory().open_child(namespace, false)?;
    for (previous, published, current_namespace) in [
        (&source, &first, &first_namespace),
        (&first_store, &second, &second_namespace),
    ] {
        previous.verify_gateway_fence_relocation(published, namespace)?;
        let cold = IntegrationServiceLeaseStore::open_in(
            current_namespace,
            OsStr::new("leases"),
            &scope(),
        )?;
        assert_eq!(cold.app_server_host_selections()?, history);
        assert_eq!(cold.list_scope_hosts()?, legacy);
        let current = pins(&cold.directory)?;
        let header_identity = cold
            .directory
            .portable_regular_identity(OsStr::new("owner.json"))?;
        let gateway_identity = cold
            .directory
            .portable_regular_identity(OsStr::new(app_server_host::GATEWAY_SLOT))?;
        let gateway: serde_json::Value =
            serde_json::from_slice(&read(&cold.directory, app_server_host::GATEWAY_SLOT)?)?;
        assert_eq!(gateway.as_object().unwrap().len(), 2);
        assert_eq!(
            gateway["identity"],
            serde_json::to_value(cold.capture_slot(scope_host::HOST_SLOT, None)?)?
        );
        let mut expected_header: serde_json::Value = serde_json::from_slice(&original.0)?;
        expected_header["writerIdentity"] = serde_json::to_value(&cold.header.writer_identity)?;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&cold.header_bytes)?,
            expected_header
        );
        // Historical selection is readable, while its original launch roots
        // cannot be used to claim an old task runtime after they disappear.
        assert!(
            cold.try_claim_app_server_host(&history.last().unwrap().0)
                .is_err()
        );
        let gateway = cold
            .try_claim_gateway_app_server()?
            .context("current gateway fence")?;
        cold.verify_gateway_app_server_descriptor(gateway.file())?;
        assert!(cold.try_claim_gateway_app_server()?.is_none());
        drop(gateway);
        assert_eq!(pins(&cold.directory)?, current);
        previous.verify_gateway_fence_relocation(published, namespace)?;
        assert_eq!(pins(&cold.directory)?, current);
        assert_eq!(
            cold.directory
                .portable_regular_identity(OsStr::new("owner.json"))?,
            header_identity
        );
        assert_eq!(
            cold.directory
                .portable_regular_identity(OsStr::new(app_server_host::GATEWAY_SLOT))?,
            gateway_identity
        );
    }
    assert_eq!(pins(&source.directory)?, original);
    Ok(())
}

#[test]
fn held_and_cold_observers_reject_replaced_authoritative_fences() -> Result<()> {
    let code_lock = names("unknown")?.1.replace("lease-", "native-code-");
    for leaf in ["writer.lock", scope_host::HOST_SLOT, &code_lock] {
        let root = private_root()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let source = populate(
            &parent,
            &root.path().join("profile"),
            &root.path().join("workspace"),
        )?;
        let observer =
            IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &scope())?;
        let original = read(&source.directory, leaf)?;
        let held = if leaf == "writer.lock" {
            source.writer()?
        } else if leaf == scope_host::HOST_SLOT {
            source
                .try_claim_gateway_app_server()?
                .context("original host")?
        } else {
            source
                .claim_native_code_owner("unknown")?
                .context("original code owner")?
        };
        std::fs::rename(
            root.path().join("leases").join(leaf),
            root.path().join("retained-leaf"),
        )?;
        source
            .directory
            .atomic_replace(OsStr::new(leaf), &original)?;
        let rejects = |store: &IntegrationServiceLeaseStore| {
            if leaf == scope_host::HOST_SLOT {
                store.current_app_server_host().is_err()
            } else {
                store.read_native_code("unknown").is_err()
            }
        };
        assert!(rejects(&source), "source accepted {leaf}");
        assert!(rejects(&observer), "observer accepted {leaf}");
        // The OS permits a different inode at the same name. Ordinary fresh
        // readers must reject it using the existing authoritative record pin.
        let replacement_identity = source
            .directory
            .portable_regular_identity(OsStr::new(leaf))?;
        let replacement = source
            .directory
            .try_existing_portable_lock(
                OsStr::new(leaf),
                &replacement_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("independent replacement inode")?;
        match IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &scope()) {
            Err(_) => {}
            Ok(fresh) => {
                assert_eq!(leaf, code_lock);
                assert!(fresh.read_native_code("unknown").is_err());
                assert!(fresh.claim_native_code_owner("unknown").is_err());
            }
        }
        assert_ne!(
            source
                .directory
                .portable_regular_handle_identity(held.file())?,
            replacement_identity
        );
        drop(replacement);
        drop(held);
    }
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source = populate(
        &parent,
        &root.path().join("profile"),
        &root.path().join("workspace"),
    )?;
    std::fs::rename(
        root.path().join("leases"),
        root.path().join("retained-store"),
    )?;
    copy(&source.directory, &parent)?;
    assert!(source.list_native_code().is_err());
    assert!(
        IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &scope()).is_err()
    );
    Ok(())
}

#[test]
fn cold_inventory_checks_original_owner_journal_and_uncommitted_preparation() -> Result<()> {
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source = populate(
        &parent,
        &root.path().join("profile"),
        &root.path().join("workspace"),
    )?;
    let mut foreign = scope();
    foreign.account_id = "different-owner".into();
    assert!(
        IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &foreign).is_err()
    );
    let journal_name = OsStr::new("app-server-host.v1.json");
    let original = read(&source.directory, journal_name.to_str().unwrap())?;
    let mut journal: serde_json::Value = serde_json::from_slice(&original)?;
    journal["changes"][1]["operationId"] = journal["changes"][0]["operationId"].clone();
    source
        .directory
        .atomic_replace(journal_name, &serde_json::to_vec(&journal)?)?;
    assert!(source.app_server_host_selections().is_err());
    source.directory.atomic_replace(journal_name, &original)?;
    let preparation = names("unknown")?
        .0
        .replace("lease-", "native-code-prepare-");
    let original = read(&source.directory, &preparation)?;
    let mut invalid: serde_json::Value = serde_json::from_slice(&original)?;
    invalid["intent"]["scope"]["accountId"] = "different-owner".into();
    source
        .directory
        .atomic_replace(OsStr::new(&preparation), &serde_json::to_vec(&invalid)?)?;
    assert!(source.list_native_code().is_err());
    Ok(())
}

#[test]
fn legacy_cold_fallback_rejects_a_renamed_live_host_slot() -> Result<()> {
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source = populate_gateway(
        &parent,
        &root.path().join("profile"),
        &root.path().join("workspace"),
    )?;
    source
        .directory
        .remove_regular_file(OsStr::new(app_server_host::GATEWAY_SLOT))?;
    let id = source.list_scope_hosts()?.remove(0).0;
    let held = source
        .try_claim_scope_host(&id)?
        .context("original legacy owner")?;
    std::fs::rename(
        root.path().join("leases").join(scope_host::HOST_SLOT),
        root.path().join("retained-host-slot"),
    )?;
    source
        .directory
        .open_read_write_file(OsStr::new(scope_host::HOST_SLOT), true)?;
    let cold = IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &scope())?;
    assert!(cold.read_scope_host(&id).is_err());
    assert!(cold.app_server_host_selections().is_err());
    assert!(cold.try_claim_gateway_app_server().is_err());
    assert!(
        source
            .directory
            .entry_metadata(OsStr::new(app_server_host::GATEWAY_SLOT))
            .is_err()
    );
    assert_ne!(
        source
            .directory
            .portable_regular_handle_identity(held.file())?,
        source
            .directory
            .portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?
    );
    Ok(())
}

#[test]
fn fence_preview_refuses_native_code_and_legacy_placement_without_target_writes() -> Result<()> {
    for native_code in [true, false] {
        let root = private_root()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let source_root = parent.create_private_child(OsStr::new("source"))?;
        let namespace = OsStr::new("services-domain");
        let source_parent = source_root.create_private_child(namespace)?;
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        let source = if native_code {
            populate(&source_parent, &profile, &workspace)?
        } else {
            populate_gateway(&source_parent, &profile, &workspace)?
        };
        if !native_code {
            source
                .directory
                .remove_regular_file(OsStr::new(app_server_host::GATEWAY_SLOT))?;
        }
        let expected = if native_code {
            "SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED"
        } else {
            "SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED"
        };
        assert!(
            source
                .preview_gateway_fence_relocation()
                .unwrap_err()
                .to_string()
                .contains(expected)
        );
        let original = pins(&source.directory)?;
        let records = source.list_native_code()?;
        let (mut owner, published) = publish(
            root.path(),
            &root.path().join("source"),
            &root.path().join("target"),
            "unsupported-move",
        )?;
        let target = published
            .directory()
            .open_child(namespace, false)?
            .open_child(OsStr::new("leases"), false)?;
        assert!(
            source
                .relocate_gateway_fences(&mut owner, &published, namespace)
                .unwrap_err()
                .to_string()
                .contains(expected)
        );
        assert_eq!(pins(&source.directory)?, original);
        assert_eq!(pins(&target)?, original);
        assert_eq!(source.list_native_code()?, records);
    }
    Ok(())
}

#[test]
fn unknown_target_pins_are_rejected_before_any_write() -> Result<()> {
    for damage in ["owner", "gateway"] {
        let root = private_root()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let source_root = parent.create_private_child(OsStr::new("source"))?;
        let namespace = OsStr::new("services-domain");
        let source_parent = source_root.create_private_child(namespace)?;
        let source = populate_gateway(
            &source_parent,
            &root.path().join("profile"),
            &root.path().join("workspace"),
        )?;
        let original = pins(&source.directory)?;
        let (mut owner, published) = publish(
            root.path(),
            &root.path().join("source"),
            &root.path().join("target"),
            "damaged-move",
        )?;
        let target = published
            .directory()
            .open_child(namespace, false)?
            .open_child(OsStr::new("leases"), false)?;
        let name = match damage {
            "owner" => "owner.json",
            "gateway" => app_server_host::GATEWAY_SLOT,
            _ => unreachable!(),
        };
        target.atomic_replace(OsStr::new(name), b"unknown target bytes")?;
        let before = pins(&target)?;
        assert!(
            source
                .relocate_gateway_fences(&mut owner, &published, namespace)
                .is_err()
        );
        assert!(
            source
                .verify_gateway_fence_relocation(&published, namespace)
                .is_err()
        );
        assert_eq!(pins(&target)?, before);
        assert_eq!(pins(&source.directory)?, original);
    }
    Ok(())
}

#[test]
fn original_operation_reconciles_gateway_pin_published_before_writer_pin() -> Result<()> {
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source_root = parent.create_private_child(OsStr::new("source"))?;
    let namespace = OsStr::new("services-domain");
    let source_parent = source_root.create_private_child(namespace)?;
    let source = populate_gateway(
        &source_parent,
        &root.path().join("profile"),
        &root.path().join("workspace"),
    )?;
    let original = pins(&source.directory)?;
    let (mut owner, published) = publish(
        root.path(),
        &root.path().join("source"),
        &root.path().join("target"),
        "interrupted-move",
    )?;
    let target_namespace = published.directory().open_child(namespace, false)?;
    let target = target_namespace.open_child(OsStr::new("leases"), false)?;
    let mut expected: serde_json::Value =
        serde_json::from_slice(&read(&source.directory, app_server_host::GATEWAY_SLOT)?)?;
    expected["identity"] =
        serde_json::to_value(target.portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?)?;
    target.atomic_replace(
        OsStr::new(app_server_host::GATEWAY_SLOT),
        &serde_json::to_vec(&expected)?,
    )?;
    let gateway_identity =
        target.portable_regular_identity(OsStr::new(app_server_host::GATEWAY_SLOT))?;
    let partial = pins(&target)?;
    assert!(
        source
            .verify_gateway_fence_relocation(&published, namespace)
            .is_err()
    );
    assert_eq!(pins(&target)?, partial);
    assert!(
        IntegrationServiceLeaseStore::open_in(&target_namespace, OsStr::new("leases"), &scope())
            .is_err()
    );
    source.relocate_gateway_fences(&mut owner, &published, namespace)?;
    source.verify_gateway_fence_relocation(&published, namespace)?;
    let current = pins(&target)?;
    let header_identity = target.portable_regular_identity(OsStr::new("owner.json"))?;
    source.relocate_gateway_fences(&mut owner, &published, namespace)?;
    assert_eq!(pins(&target)?, current);
    assert_eq!(
        target.portable_regular_identity(OsStr::new("owner.json"))?,
        header_identity
    );
    assert_eq!(
        target.portable_regular_identity(OsStr::new(app_server_host::GATEWAY_SLOT))?,
        gateway_identity
    );
    assert_eq!(pins(&source.directory)?, original);
    owner.advance(published.operation_id(), Phase::Copying, Phase::Verifying)?;
    assert!(
        source
            .relocate_gateway_fences(&mut owner, &published, namespace)
            .is_err()
    );
    source.verify_gateway_fence_relocation(&published, namespace)?;
    assert_eq!(pins(&target)?, current);
    Ok(())
}

#[test]
fn read_only_history_preserves_bytes_and_live_header_anchor_rejects_replacement() -> Result<()> {
    let root = private_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let source = populate(
        &parent,
        &root.path().join("profile"),
        &root.path().join("workspace"),
    )?;
    let original = bytes(&source.directory)?;
    source.current_app_server_host()?;
    source.app_server_host_selections()?;
    source.list_scope_hosts()?;
    source.list_native_code()?;
    assert_eq!(bytes(&source.directory)?, original);
    source
        .directory
        .atomic_replace(OsStr::new("owner.json"), &source.header_bytes)?;
    assert!(source.current_app_server_host().is_err());
    let fresh = IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("leases"), &scope())?;
    assert_eq!(fresh.list_native_code()?.len(), 2);
    assert_eq!(bytes(&fresh.directory)?, original);
    Ok(())
}
