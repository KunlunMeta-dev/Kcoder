use super::*;
use kcoder_config::storage::{StorageOperationOwner, StorageResolveInput, resolve_storage_paths};
use std::fs;

#[test]
fn deferred_startup_requires_every_original_owned_root() -> Result<()> {
    let home = tempfile::tempdir()?;
    let paths = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.path().to_owned()),
        ..Default::default()
    })?;
    let receipt = StorageMigrationReceipt {
        plan: kcoder_types::StorageMigrationPlan {
            version: 1,
            operation_id: "deferred-original".into(),
            original: None,
            from: paths.clone(),
            components: vec![],
            target: kcoder_types::StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: paths.data_root.clone(),
                cache_root: home.path().join("cache"),
                operation_id: Some("deferred-original".into()),
            },
            target_bindings: vec![],
            launch_intent: StorageLaunchIntent::Cli,
        },
        phase: Phase::Planned,
        disposition: Disposition::Deferred,
        owner_receipts: Default::default(),
        error_code: Some("STORAGE_TEST_DEFERRED".into()),
    };
    assert_deferred_source_paths(&paths, &receipt)?;
    let fields: [fn(&mut StoragePaths) -> &mut PathBuf; 4] = [
        |paths| &mut paths.data_root,
        |paths| &mut paths.cache_root,
        |paths| &mut paths.gateway_root,
        |paths| &mut paths.desktop_root,
    ];
    for field in fields {
        let mut changed = receipt.clone();
        *field(&mut changed.plan.from) = home.path().join("another-original-root");
        assert_eq!(
            assert_deferred_source_paths(&paths, &changed)
                .err()
                .context("must reject a changed original root")?
                .to_string(),
            "STORAGE_SELECTION_CHANGED"
        );
        assert_eq!(changed.plan.operation_id, "deferred-original");
    }
    Ok(())
}

fn deferred_legacy_receipt(
    home: &Path,
    from: StoragePaths,
    components: Vec<kcoder_types::StorageMigrationComponent>,
) -> StorageMigrationReceipt {
    const ID: &str = "installer-legacy-original-1";
    StorageMigrationReceipt {
        plan: kcoder_types::StorageMigrationPlan {
            version: 1,
            operation_id: ID.into(),
            original: None,
            from: from.clone(),
            components,
            target: kcoder_types::StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: home.join(".config/kcoder"),
                cache_root: home.join("AppData/Local/kcoder/cache"),
                operation_id: Some(ID.into()),
            },
            target_bindings: vec![],
            launch_intent: StorageLaunchIntent::Cli,
        },
        phase: Phase::Copying,
        disposition: Disposition::Deferred,
        owner_receipts: Default::default(),
        error_code: Some("STORAGE_OPERATION_CANCELLED".into()),
    }
}

fn source_component(
    domain: &str,
    source: &Path,
    destination: PathBuf,
) -> Result<kcoder_types::StorageMigrationComponent> {
    Ok(kcoder_types::StorageMigrationComponent {
        domain: domain.into(),
        source: source.into(),
        destination,
        source_identity: PrivateDirectory::open_existing(source)?.directory_identity()?,
        estimated_bytes: 0,
    })
}

#[test]
fn deferred_legacy_startup_rebuilds_registered_roots_and_rejects_changed_sources() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let platform_config = home.join("AppData/Roaming");
    let native = home.join("registered-native");
    let gateway = home.join("registered-gateway");
    let other_native = home.join("other-native");
    let other_gateway = home.join("other-gateway");
    for root in [&native, &gateway, &other_native, &other_gateway] {
        fs::create_dir_all(root)?;
    }
    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config),
        ..Default::default()
    })?;
    let registration = registered::RegisteredSources {
        native: native.clone(),
        gateway: Some(gateway.clone()),
    };
    registered::apply(&mut from, &registration);
    let components = vec![
        source_component(
            STORAGE_PERSISTENT_ROOT_DOMAIN,
            &native,
            home.join(".config/kcoder"),
        )?,
        source_component(
            "gateway",
            &gateway,
            home.join(".config/kcoder/studio/gateway"),
        )?,
    ];
    let receipt = deferred_legacy_receipt(home, from.clone(), components);
    let current = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(home.join("AppData/Roaming")),
        ..Default::default()
    })?;
    assert_ne!(current.data_root, native);
    assert_ne!(current.gateway_root, gateway);
    assert_deferred_legacy_source_paths(home, &current, &receipt, Some(&registration))?;
    assert_eq!(
        assert_deferred_legacy_source_paths(home, &current, &receipt, None)
            .unwrap_err()
            .to_string(),
        "STORAGE_SELECTION_CHANGED"
    );

    let changed_registration = registered::RegisteredSources {
        native: other_native,
        gateway: Some(other_gateway),
    };
    assert_eq!(
        assert_deferred_legacy_source_paths(home, &current, &receipt, Some(&changed_registration),)
            .unwrap_err()
            .to_string(),
        "STORAGE_SELECTION_CHANGED"
    );

    let mut changed_identity = receipt;
    changed_identity.plan.components[0].source_identity = "replacement-directory".into();
    assert_eq!(
        assert_deferred_legacy_source_paths(home, &current, &changed_identity, Some(&registration))
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_CHANGED"
    );
    Ok(())
}

#[test]
fn deferred_legacy_startup_rejects_an_unregistered_gateway_outside_fixed_roots() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let platform_config = home.join("AppData/Roaming");
    let native = home.join(".config/kcoder");
    let gateway = home.join("registered-gateway");
    fs::create_dir_all(&native)?;
    fs::create_dir_all(&gateway)?;
    fs::write(gateway.join("servers.json"), b"[]\n")?;
    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config.clone()),
        ..Default::default()
    })?;
    let registration = registered::RegisteredSources {
        native: native.clone(),
        gateway: Some(gateway.clone()),
    };
    registered::apply(&mut from, &registration);
    let receipt = deferred_legacy_receipt(
        home,
        from.clone(),
        vec![
            source_component(
                STORAGE_PERSISTENT_ROOT_DOMAIN,
                &native,
                home.join(".config/kcoder"),
            )?,
            source_component(
                "gateway",
                &gateway,
                home.join(".config/kcoder/studio/gateway"),
            )?,
        ],
    );
    let current = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config),
        ..Default::default()
    })?;
    assert_eq!(
        assert_deferred_legacy_source_paths(home, &current, &receipt, None)
            .unwrap_err()
            .to_string(),
        "STORAGE_SELECTION_CHANGED"
    );
    assert!(gateway.join("servers.json").is_file());
    Ok(())
}

#[test]
fn deferred_legacy_startup_preserves_an_empty_cli_gateway_candidate() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let platform_config = home.join("AppData/Roaming");
    let native = home.join(".config/kcoder");
    fs::create_dir_all(&native)?;
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config.clone()),
        ..Default::default()
    })?;
    let standalone = home.join(".config/kcoder-studio");
    assert_eq!(from.gateway_root, standalone);
    let receipt = deferred_legacy_receipt(
        home,
        from,
        vec![source_component(
            STORAGE_PERSISTENT_ROOT_DOMAIN,
            &native,
            home.join(".config/kcoder"),
        )?],
    );
    let current = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config),
        ..Default::default()
    })?;
    assert_deferred_legacy_source_paths(home, &current, &receipt, None)?;
    Ok(())
}

#[test]
fn deferred_legacy_startup_reselects_only_the_same_unregistered_gateway() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let platform_config = home.join("AppData/Roaming");
    let desktop = platform_config.join("kcoder-studio");
    let standalone = home.join(".config/kcoder-studio");
    let native = home.join(".config/kcoder");
    fs::create_dir_all(&desktop)?;
    fs::create_dir_all(&standalone)?;
    fs::create_dir_all(&native)?;
    // Select the populated Desktop root instead of the ordinary standalone
    // default, so the retry must actually reconstruct the original source.
    fs::write(desktop.join("servers.json"), b"[]\n")?;

    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config.clone()),
        ..Default::default()
    })?;
    sources::select_unregistered_gateway(home, &mut from)?;
    assert_eq!(from.gateway_root, desktop);
    let components = vec![
        source_component(
            STORAGE_PERSISTENT_ROOT_DOMAIN,
            &native,
            home.join(".config/kcoder"),
        )?,
        source_component(
            "gateway",
            &desktop,
            home.join(".config/kcoder/studio/gateway"),
        )?,
    ];
    let receipt = deferred_legacy_receipt(home, from, components);
    let current = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        platform_config: Some(platform_config),
        ..Default::default()
    })?;
    assert_ne!(current.gateway_root, desktop);
    assert_deferred_legacy_source_paths(home, &current, &receipt, None)?;

    fs::write(standalone.join("servers.json"), b"second candidate\n")?;
    assert_eq!(
        assert_deferred_legacy_source_paths(home, &current, &receipt, None)
            .unwrap_err()
            .to_string(),
        "STORAGE_LEGACY_SOURCE_CONFLICT"
    );
    Ok(())
}

struct Preview<'a> {
    home: &'a Path,
    source: &'a registered::RegisteredSources,
}
impl StorageOperationOwner for Preview<'_> {
    fn validate(&self, receipt: &StorageMigrationReceipt) -> Result<()> {
        validate_legacy_with_registration(self.home, receipt, Some(self.source))
    }
    fn copy_and_relocate(&mut self, _: &mut StorageCoordinator, _: &str) -> Result<()> {
        unreachable!("this fixture invokes the actual copy owners directly")
    }
    fn reconcile_failure(&mut self, _: &mut StorageCoordinator, _: &str) -> Result<()> {
        unreachable!("this fixture does not settle a failed operation")
    }
}
struct NoCredentials;
impl kcoder_config::CredentialBackend for NoCredentials {
    fn describe(&self) -> String {
        "owned registered-source fixture".into()
    }
    fn available(&self) -> bool {
        panic!("unrelated OS credentials must not be probed")
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

async fn registered_copy(nested_gateway: bool) -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let native = home.join("registered-native");
    let gateway = if nested_gateway {
        native.join("studio-gateway-recorded")
    } else {
        home.join("registered-gateway")
    };
    let desktop = home.join(".config/kcoder-studio");
    for root in [&native, &gateway, &desktop] {
        fs::create_dir_all(root)?;
    }
    let settings = br#"{"providers":[]}"#;
    let catalog = br#"[{"id":"owned-original","transport":"local"}]"#;
    let browser = br#"{"browser":{"ownedFirstRun":true}}"#;
    fs::write(native.join("settings.json"), settings)?;
    fs::write(
        native.join("business-state.json"),
        b"same original Native business bytes",
    )?;
    fs::write(gateway.join("settings.json"), b"{}")?;
    fs::write(gateway.join("servers.json"), catalog)?;
    fs::write(desktop.join("Local State"), browser)?;
    let source = registered::RegisteredSources {
        native: native.clone(),
        gateway: Some(gateway.clone()),
    };
    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.to_owned()),
        platform_config: Some(home.join(".config")),
        ..Default::default()
    })?;
    registered::apply(&mut from, &source);
    let target = home.join(".config/kcoder");
    let cache = home.join("separate-cache");
    let id = "registered-source-copy";
    let plan = prepare_storage_plan_from_paths_with_owner(
        home,
        from,
        &target,
        &cache,
        id,
        StorageLaunchIntent::VerifyOnly,
        &Preview {
            home,
            source: &source,
        },
    )?
    .context("missing plan")?;
    assert_eq!(
        plan.components
            .iter()
            .map(|component| component.domain.as_str())
            .collect::<Vec<_>>(),
        ["persistent-root", "gateway", "desktop"]
    );
    assert!(!native.join("studio").exists());
    let mut coordinator = StorageCoordinator::acquire(home)?;
    coordinator.begin(plan)?;
    coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
    let evidence = home.join(".config/kcoder-storage-migrations").join(id);
    super::super::storage_profile::copy_and_relocate_profile(
        &mut coordinator,
        id,
        &NoCredentials,
        None,
        &evidence,
        None,
    )
    .await?;
    let repository = kcoder_test_harness::workspace_root()?;
    let mut command = tokio::process::Command::new(which::which("node")?);
    command
        .arg(repository.join("apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("KCODER_TARGET_DIR", repository.join("target"))
        .env("ELECTRON_RUN_AS_NODE", "1")
        .current_dir(&repository);
    copy_legacy_clients(home, &mut coordinator, id, Some(&mut command)).await?;
    assert!(
        !native.join("studio").exists(),
        "a moved Native source must not gain target client directories"
    );
    assert_eq!(fs::read(native.join("settings.json"))?, settings);
    assert_eq!(fs::read(target.join("settings.json"))?, settings);
    assert_eq!(
        fs::read(target.join("business-state.json"))?,
        b"same original Native business bytes"
    );
    assert_eq!(
        fs::read(target.join("studio/gateway/servers.json"))?,
        catalog
    );
    assert_eq!(
        fs::read(target.join("studio/desktop/Local State"))?,
        browser
    );
    assert!(!target.join("studio/desktop/settings.json").exists());
    if nested_gateway {
        assert!(!target.join("studio-gateway-recorded").exists());
    }
    assert_eq!(fs::read(gateway.join("servers.json"))?, catalog);
    assert_eq!(fs::read(desktop.join("Local State"))?, browser);
    coordinator.advance(id, Phase::Copying, Phase::Verifying)?;
    coordinator.advance(id, Phase::Verifying, Phase::Prepared)?;
    coordinator.commit(id)?;
    assert_eq!(
        kcoder_config::storage::read_storage_location_record(&storage_location_file(home))?
            .context("missing committed selection")?
            .data_root,
        target
    );
    Ok(())
}

#[tokio::test]
async fn registered_native_move_keeps_source_without_studio_and_publishes_independent_clients()
-> Result<()> {
    registered_copy(false).await
}

#[tokio::test]
async fn registered_native_move_excludes_the_registered_nested_gateway_from_raw_native_copy()
-> Result<()> {
    registered_copy(true).await
}
