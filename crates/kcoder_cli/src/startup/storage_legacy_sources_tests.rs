use super::*;
use kcoder_config::storage::{StorageCoordinator, StorageResolveInput, resolve_storage_paths};
use kcoder_types::{
    StorageConsumer, StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
    StorageMigrationPhase as Phase, StoragePaths,
};
use std::{fs, path::Path};

struct Fixture {
    _owned: tempfile::TempDir,
    home: PathBuf,
    shared: PathBuf,
    plan: StorageMigrationPlan,
}

impl Fixture {
    fn new(roles: &[&str]) -> Self {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("owned-home");
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            consumer: StorageConsumer::Desktop,
            ..Default::default()
        })
        .unwrap();
        fs::create_dir_all(&from.data_root).unwrap();
        fs::create_dir_all(&from.desktop_root).unwrap();
        let shared = from.desktop_root.clone();
        let id = "legacy-source-classification";
        let target = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: from.data_root.clone(),
            cache_root: home.join("Cache"),
            operation_id: Some(id.into()),
        };
        let mut components = vec![StorageMigrationComponent {
            domain: "persistent-root".into(),
            source: from.data_root.clone(),
            destination: from.data_root.clone(),
            source_identity: PrivateDirectory::open_existing(&from.data_root)
                .unwrap()
                .directory_identity()
                .unwrap(),
            estimated_bytes: 0,
        }];
        for &role in roles {
            components.push(StorageMigrationComponent {
                domain: role.into(),
                source: shared.clone(),
                destination: target.data_root.join("studio").join(role),
                source_identity: PrivateDirectory::open_existing(&shared)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            });
        }
        Self {
            _owned: owned,
            home,
            shared,
            plan: StorageMigrationPlan {
                version: 1,
                operation_id: id.into(),
                original: None,
                from,
                target,
                components,
                target_bindings: vec![],
                launch_intent: StorageLaunchIntent::Cli,
            },
        }
    }

    fn put(&self, relative: &str, payload: &[u8]) {
        let path = self.shared.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, payload).unwrap();
    }

    fn error(&self, preview: bool) -> String {
        observe(&self.plan, &BTreeSet::new(), preview, None)
            .err()
            .expect("classification must reject the owned source")
            .to_string()
    }
}

fn resolved_paths(home: &Path, platform_config: &Path, consumer: StorageConsumer) -> StoragePaths {
    resolve_storage_paths(&StorageResolveInput {
        home: Some(home.to_owned()),
        platform_config: Some(platform_config.to_owned()),
        consumer,
        ..Default::default()
    })
    .unwrap()
}

#[test]
fn unregistered_cli_and_desktop_contexts_select_the_same_populated_roaming_gateway() {
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path().join("owned-home");
    let platform_config = home.join("AppData/Roaming");
    let roaming = platform_config.join("kcoder-studio");
    fs::create_dir_all(&roaming).unwrap();
    fs::write(roaming.join("servers.json"), b"[]\n").unwrap();
    fs::create_dir_all(roaming.join("channels")).unwrap();

    let mut cli = resolved_paths(&home, &platform_config, StorageConsumer::Cli);
    assert_ne!(cli.gateway_root, cli.desktop_root);
    select_unregistered_gateway(&home, &mut cli).unwrap();
    assert_eq!(cli.gateway_root, roaming);

    let mut desktop = resolved_paths(&home, &platform_config, StorageConsumer::Desktop);
    assert_eq!(desktop.gateway_root, desktop.desktop_root);
    select_unregistered_gateway(&home, &mut desktop).unwrap();
    assert_eq!(desktop.gateway_root, roaming);
}

#[test]
fn unregistered_selector_conflicts_when_both_fixed_roots_have_gateway_payload() {
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path().join("owned-home");
    let platform_config = home.join("AppData/Roaming");
    let standalone = home.join(".config/kcoder-studio");
    let roaming = platform_config.join("kcoder-studio");
    fs::create_dir_all(&standalone).unwrap();
    fs::create_dir_all(&roaming).unwrap();
    fs::write(standalone.join("servers.json"), b"standalone catalog").unwrap();
    fs::write(roaming.join("servers.json"), b"Roaming catalog").unwrap();

    let mut paths = resolved_paths(&home, &platform_config, StorageConsumer::Cli);
    let error = select_unregistered_gateway(&home, &mut paths).unwrap_err();
    assert!(error.to_string().contains("STORAGE_LEGACY_SOURCE_CONFLICT"));
    assert_eq!(
        fs::read(standalone.join("servers.json")).unwrap(),
        b"standalone catalog"
    );
    assert_eq!(
        fs::read(roaming.join("servers.json")).unwrap(),
        b"Roaming catalog"
    );
}

#[test]
fn unregistered_selection_does_not_hide_unknown_desktop_payload() {
    let mut fixture = Fixture::new(&["gateway", "desktop"]);
    let standalone = fixture.plan.from.gateway_root.clone();
    let platform_config = fixture.home.join("AppData/Roaming");
    let desktop_root = platform_config.join("kcoder-studio");
    fs::create_dir_all(&desktop_root).unwrap();
    fs::write(standalone.join("servers.json"), b"[]\n").unwrap();
    fs::write(
        desktop_root.join("private-unclassified-data"),
        b"preserve me",
    )
    .unwrap();

    let mut paths = resolved_paths(&fixture.home, &platform_config, StorageConsumer::Cli);
    select_unregistered_gateway(&fixture.home, &mut paths).unwrap();
    assert_eq!(paths.gateway_root, standalone);
    assert_ne!(paths.gateway_root, desktop_root);

    fixture.plan.from.gateway_root = paths.gateway_root;
    fixture.plan.from.desktop_root = desktop_root.clone();
    let desktop = &mut fixture.plan.components[2];
    desktop.source = desktop_root.clone();
    desktop.source_identity = PrivateDirectory::open_existing(&desktop_root)
        .unwrap()
        .directory_identity()
        .unwrap();
    let sources = observe(&fixture.plan, &BTreeSet::new(), false, None).unwrap();
    assert!(sources.iter().any(|source| {
        source.entries.iter().any(|entry| {
            entry.path == Path::new("private-unclassified-data") && entry.owner == "desktop"
        })
    }));
    assert_eq!(
        fs::read(desktop_root.join("private-unclassified-data")).unwrap(),
        b"preserve me"
    );
}

#[test]
fn shared_namespace_json_owns_exact_gateway_backup_names() {
    let rules: Rules = serde_json::from_str(include_str!(
        "../../../../apps/kcoder-studio/src/migrations/legacy-owner-namespaces.json"
    ))
    .unwrap();
    assert_eq!(rules.version, 1);
    for version in [1, 2] {
        let name = format!("settings.json.v{version}-{}.bak", "a1".repeat(32));
        assert!(rules.backup(&name).unwrap());
        let fixture = Fixture::new(&["gateway"]);
        fixture.put(
            &name,
            b"invalid settings payload: classification is metadata only",
        );
        let sources = observe(&fixture.plan, &BTreeSet::new(), false, None).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].entries.len(), 1);
        assert_eq!(sources[0].entries[0].owner, "gateway");
        assert!(sources[0].exclusions("gateway").is_empty());
    }
    for name in [
        "settings.json.bak".to_owned(),
        format!("settings.json.v0-{}.bak", "a".repeat(64)),
        format!("settings.json.v3-{}.bak", "a".repeat(64)),
        format!("settings.json.v1-{}.bak", "a".repeat(63)),
        format!("settings.json.v1-{}.bak", "a".repeat(65)),
        format!("settings.json.v1-{}.bak", "A".repeat(64)),
        format!("settings.json.v1-{}.bak.extra", "a".repeat(64)),
    ] {
        assert!(!rules.backup(&name).unwrap(), "{name}");
    }
}

#[test]
fn one_physical_client_source_has_complementary_roles_and_real_inventory_exclusions() {
    let fixture = Fixture::new(&["gateway", "desktop"]);
    let backup = format!("settings.json.v2-{}.bak", "f".repeat(64));
    for (path, bytes) in [
        ("servers.json", b"opaque gateway server list".as_slice()),
        ("settings.json", b"opaque gateway settings".as_slice()),
        (backup.as_str(), b"original settings backup".as_slice()),
        (
            "channels/receipt-unknown",
            b"accepted or unknown receipt".as_slice(),
        ),
        ("gateway-port", b"40123".as_slice()),
        ("Local State", b"opaque Chromium state".as_slice()),
        ("Dictionaries/en-US.bdic", b"opaque dictionary".as_slice()),
        (
            "skill-runtime/bin/node",
            b"original generated Gateway launcher".as_slice(),
        ),
        (
            "Partitions/kcoder-studio-desktop/Local Storage/leveldb/000001.log",
            b"original unsent draft".as_slice(),
        ),
    ] {
        fixture.put(path, bytes);
    }
    // These exact default-session leaves were produced by the real Electron
    // main during the Legacy shared-userData acceptance, then normally quit.
    let sdk_files = [
        "Cookies",
        "Cookies-journal",
        "DevToolsActivePort",
        "Network Persistent State",
        "Preferences",
        "Trust Tokens",
        "Trust Tokens-journal",
    ];
    let sdk_directories = [
        "Cache",
        "Code Cache",
        "Local Storage",
        "Shared Dictionary",
        "blob_storage",
    ];
    for name in sdk_files {
        fixture.put(name, b"original Electron SDK file");
    }
    for name in sdk_directories {
        fixture.put(
            &format!("{name}/original-state"),
            b"original Electron SDK state",
        );
    }
    let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
    let id = &fixture.plan.operation_id;
    coordinator.begin(fixture.plan.clone()).unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    let fences = coordinator.prepare_offline_child_fences(id).unwrap();
    let controls = fences
        .roots
        .iter()
        .flat_map(|fence| {
            [
                fence.primary_identity.clone(),
                fence.secondary_identity.clone(),
            ]
        })
        .collect::<BTreeSet<_>>();
    let sources = observe(&fixture.plan, &controls, false, None).unwrap();
    assert_eq!(sources.len(), 1, "classify a shared physical source once");
    let source = &sources[0];
    assert_eq!(
        source.roles,
        BTreeSet::from(["desktop".into(), "gateway".into()])
    );
    let gateway = source.exclusions("gateway");
    let desktop = source.exclusions("desktop");
    assert!(gateway.is_disjoint(&desktop));
    for path in ["gateway-port", "Local State", "Dictionaries", "Partitions"] {
        assert!(gateway.contains(Path::new(path)), "{path}");
        assert!(!desktop.contains(Path::new(path)), "{path}");
    }
    for path in sdk_files.into_iter().chain(sdk_directories) {
        assert!(gateway.contains(Path::new(path)), "{path}");
        assert!(!desktop.contains(Path::new(path)), "{path}");
        assert_eq!(
            source
                .entries
                .iter()
                .find(|entry| entry.path == Path::new(path))
                .unwrap()
                .owner,
            "desktop"
        );
    }
    for path in [
        "servers.json",
        "settings.json",
        backup.as_str(),
        "channels",
        "skill-runtime",
    ] {
        assert!(desktop.contains(Path::new(path)), "{path}");
        assert!(!gateway.contains(Path::new(path)), "{path}");
    }
    for (role, exclusions) in [("gateway", gateway), ("desktop", desktop)] {
        let inventory = coordinator.inventory_source(id, role, &exclusions).unwrap();
        source
            .verify_inventory(&inventory, role, &controls)
            .unwrap();
    }
    assert!(!fixture.plan.target.data_root.join("studio").exists());
}

#[test]
fn registered_gateway_is_selected_while_old_roaming_gateway_leaves_remain_excluded() {
    let mut fixture = Fixture::new(&["desktop"]);
    let gateway = fixture.home.join("registered-gateway-c4c16a0149c9061d");
    fs::create_dir_all(&gateway).unwrap();
    let selected_catalog = b"registered Gateway catalog";
    let selected_channel = b"registered Gateway channel database";
    fs::write(gateway.join("servers.json"), selected_catalog).unwrap();
    fs::create_dir_all(gateway.join("channels")).unwrap();
    fs::write(gateway.join("channels/channels.sqlite3"), selected_channel).unwrap();

    let old_catalog = b"preserved Roaming Gateway catalog";
    let old_channel = b"preserved Roaming Gateway channel database";
    let old_device_key = b"preserved old Gateway device identity";
    let old_relay = b"preserved old Relay registration";
    fixture.put("servers.json", old_catalog);
    fixture.put("channels/channels.sqlite3", old_channel);
    fixture.put("mobile-device-auth/device.key", old_device_key);
    fixture.put("relay/registration.json", old_relay);
    fixture.put("gateway-port", b"43123");
    fixture.put("Network/network-state", b"Electron network state");
    fixture.put("SharedStorage", b"Electron shared storage");
    fixture.put("shell-icons/cache", b"Electron shell icon state");

    fixture.plan.from.gateway_root = gateway.clone();
    let gateway_component = StorageMigrationComponent {
        domain: "gateway".into(),
        source: gateway.clone(),
        destination: fixture.plan.target.data_root.join("studio/gateway"),
        source_identity: PrivateDirectory::open_existing(&gateway)
            .unwrap()
            .directory_identity()
            .unwrap(),
        estimated_bytes: 0,
    };
    fixture.plan.components.insert(1, gateway_component);
    let registration = super::super::registered::RegisteredSources {
        native: fixture.plan.from.data_root.clone(),
        gateway: Some(gateway.clone()),
    };

    let id = &fixture.plan.operation_id;
    let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
    coordinator.begin(fixture.plan.clone()).unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    let fences = coordinator.prepare_offline_child_fences(id).unwrap();
    let controls = fences
        .roots
        .iter()
        .flat_map(|fence| {
            [
                fence.primary_identity.clone(),
                fence.secondary_identity.clone(),
            ]
        })
        .collect::<BTreeSet<_>>();
    let sources = observe(&fixture.plan, &controls, false, Some(&registration)).unwrap();
    let source_for = |path: &Path| {
        let identity = PrivateDirectory::open_existing(path)
            .unwrap()
            .directory_identity()
            .unwrap();
        sources
            .iter()
            .find(|source| source.root.directory_identity().unwrap() == identity)
            .unwrap()
    };
    let registered = source_for(&gateway);
    let roaming = source_for(&fixture.shared);
    assert_eq!(registered.roles, BTreeSet::from(["gateway".into()]));
    assert_eq!(roaming.roles, BTreeSet::from(["desktop".into()]));
    for path in ["servers.json", "channels", "mobile-device-auth", "relay"] {
        let entry = roaming
            .entries
            .iter()
            .find(|entry| entry.path == Path::new(path))
            .unwrap();
        assert_eq!(entry.owner, "retained-gateway", "{path}");
        assert!(
            roaming.exclusions("desktop").contains(Path::new(path)),
            "{path}"
        );
    }
    for path in ["gateway-port", "Network", "SharedStorage", "shell-icons"] {
        assert!(
            roaming
                .entries
                .iter()
                .any(|entry| entry.path == Path::new(path) && entry.owner == "desktop"),
            "{path}"
        );
    }

    coordinator
        .advance(id, Phase::Stopped, Phase::Copying)
        .unwrap();
    fs::create_dir_all(fixture.plan.target.data_root.join("studio")).unwrap();
    let gateway_exclusions = registered.exclusions("gateway");
    coordinator
        .publish_component_checked(id, "gateway", &gateway_exclusions, |inventory| {
            registered.verify_inventory(inventory, "gateway", &controls)
        })
        .unwrap();
    let desktop_exclusions = roaming.exclusions("desktop");
    coordinator
        .publish_component_checked(id, "desktop", &desktop_exclusions, |inventory| {
            roaming.verify_inventory(inventory, "desktop", &controls)
        })
        .unwrap();

    let target_gateway = fixture.plan.target.data_root.join("studio/gateway");
    let target_desktop = fixture.plan.target.data_root.join("studio/desktop");
    assert_eq!(
        fs::read(target_gateway.join("servers.json")).unwrap(),
        selected_catalog
    );
    assert_eq!(
        fs::read(target_gateway.join("channels/channels.sqlite3")).unwrap(),
        selected_channel
    );
    for path in [
        "servers.json",
        "channels/channels.sqlite3",
        "mobile-device-auth/device.key",
        "relay/registration.json",
    ] {
        assert!(!target_desktop.join(path).exists(), "{path}");
    }
    assert_eq!(
        fs::read(target_desktop.join("Network/network-state")).unwrap(),
        b"Electron network state"
    );
    assert_eq!(
        fs::read(target_desktop.join("SharedStorage")).unwrap(),
        b"Electron shared storage"
    );
    assert_eq!(
        fs::read(target_desktop.join("shell-icons/cache")).unwrap(),
        b"Electron shell icon state"
    );
    assert_eq!(
        fs::read(fixture.shared.join("servers.json")).unwrap(),
        old_catalog
    );
    assert_eq!(
        fs::read(fixture.shared.join("channels/channels.sqlite3")).unwrap(),
        old_channel
    );
    assert_eq!(
        fs::read(fixture.shared.join("mobile-device-auth/device.key")).unwrap(),
        old_device_key
    );
    assert_eq!(
        fs::read(fixture.shared.join("relay/registration.json")).unwrap(),
        old_relay
    );
    assert_eq!(
        fs::read(gateway.join("servers.json")).unwrap(),
        selected_catalog
    );
}

#[test]
fn desktop_only_gateway_names_without_matching_registration_still_fail_closed() {
    let mut fixture = Fixture::new(&["desktop"]);
    let selected_gateway = fixture.home.join("registered-gateway-c4c16a0149c9061d");
    fs::create_dir_all(&selected_gateway).unwrap();
    fixture.plan.from.gateway_root = selected_gateway;
    fixture.put(
        "channels/channels.sqlite3",
        b"unknown registration authority",
    );
    let other_gateway = fixture.home.join("another-registered-gateway");
    fs::create_dir_all(&other_gateway).unwrap();
    let mismatched_registration = super::super::registered::RegisteredSources {
        native: fixture.plan.from.data_root.clone(),
        gateway: Some(other_gateway),
    };
    for registration in [None, Some(&mismatched_registration)] {
        assert_eq!(
            observe(&fixture.plan, &BTreeSet::new(), false, registration)
                .err()
                .expect("unregistered Gateway owner must fail closed")
                .to_string(),
            "STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED"
        );
        assert_eq!(
            fs::read(fixture.shared.join("channels/channels.sqlite3")).unwrap(),
            b"unknown registration authority"
        );
    }
}

#[test]
fn undeclared_known_client_owner_is_still_rejected() {
    let fixture = Fixture::new(&["gateway"]);
    fixture.put("gateway-port", b"known Desktop payload");
    assert_eq!(
        fixture.error(false),
        "STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED"
    );
    assert!(!fixture.plan.target.data_root.join("studio").exists());
}

#[test]
fn unknown_payload_is_copied_to_source_owner_without_changing_original_bytes() {
    for roles in [
        &["gateway"][..],
        &["desktop"][..],
        &["gateway", "desktop"][..],
    ] {
        let fixture = Fixture::new(roles);
        let payloads = [
            (
                "settings.json.bak",
                b"old backup; not live settings".as_slice(),
            ),
            (
                "old-settings-20260928.backup",
                b"another historical backup".as_slice(),
            ),
            ("notes/private.txt", b"arbitrary durable data".as_slice()),
        ];
        for (path, bytes) in payloads {
            fixture.put(path, bytes);
        }
        if roles.contains(&"desktop") {
            fixture.put(
                "Partitions/another-client/Preferences",
                b"other partition state",
            );
            fixture.put("Partitions/partition-backup.txt", b"partition backup");
        }
        let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
        let id = &fixture.plan.operation_id;
        coordinator.begin(fixture.plan.clone()).unwrap();
        coordinator
            .advance(id, Phase::Planned, Phase::Stopping)
            .unwrap();
        coordinator
            .advance(id, Phase::Stopping, Phase::Stopped)
            .unwrap();
        let fences = coordinator.prepare_offline_child_fences(id).unwrap();
        let controls = fences
            .roots
            .iter()
            .flat_map(|fence| {
                [
                    fence.primary_identity.clone(),
                    fence.secondary_identity.clone(),
                ]
            })
            .collect::<BTreeSet<_>>();
        let sources = observe(&fixture.plan, &controls, false, None).unwrap();
        assert_eq!(sources.len(), 1);
        let source = &sources[0];
        coordinator
            .advance(id, Phase::Stopped, Phase::Copying)
            .unwrap();
        fs::create_dir_all(fixture.plan.target.data_root.join("studio")).unwrap();
        for role in roles {
            coordinator
                .publish_component_checked(id, role, &source.exclusions(role), |inventory| {
                    source.verify_inventory(inventory, role, &controls)
                })
                .unwrap();
        }
        let owner = if roles.contains(&"desktop") {
            "desktop"
        } else {
            "gateway"
        };
        let target = fixture.plan.target.data_root.join("studio").join(owner);
        for (path, bytes) in payloads {
            assert_eq!(fs::read(target.join(path)).unwrap(), bytes);
            assert_eq!(fs::read(fixture.shared.join(path)).unwrap(), bytes);
        }
        assert!(!target.join("settings.json").exists());
        if roles.len() == 2 {
            assert!(
                !fixture
                    .plan
                    .target
                    .data_root
                    .join("studio/gateway/settings.json.bak")
                    .exists()
            );
        }
        if roles.contains(&"desktop") {
            assert_eq!(
                fs::read(target.join("Partitions/another-client/Preferences")).unwrap(),
                b"other partition state"
            );
            assert_eq!(
                fs::read(target.join("Partitions/partition-backup.txt")).unwrap(),
                b"partition backup"
            );
        }
    }
}

#[test]
fn ordinary_singleton_control_files_still_block_stopped_migration() {
    let fixture = Fixture::new(&["desktop"]);
    fixture.put("SingletonLock", b"SDK control");
    assert_eq!(
        fixture.error(false),
        "STORAGE_LEGACY_DESKTOP_CONTROL_PRESENT"
    );
}

#[cfg(unix)]
#[test]
fn known_and_unknown_links_are_never_followed_and_singleton_preview_cannot_authorize_copying() {
    let fixture = Fixture::new(&["gateway", "desktop"]);
    let outside = fixture.home.join("outside-payload");
    fs::write(&outside, b"outside source scope").unwrap();
    for relative in ["servers.json", "unknown-link", "Partitions/unknown-link"] {
        let named = fixture.shared.join(relative);
        fs::create_dir_all(named.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, &named).unwrap();
        assert_eq!(fixture.error(false), "STORAGE_LEGACY_ENTRY_KIND_MISMATCH");
        assert_eq!(fs::read(&outside).unwrap(), b"outside source scope");
        fs::remove_file(named).unwrap();
    }
    fs::remove_dir(fixture.shared.join("Partitions")).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.shared.join("SingletonLock")).unwrap();
    let preview = observe(&fixture.plan, &BTreeSet::new(), true, None).unwrap();
    assert_eq!(preview[0].entries[0].kind, Kind::Symlink);
    assert_eq!(
        fixture.error(false),
        "STORAGE_LEGACY_DESKTOP_CONTROL_PRESENT"
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside source scope");
}

#[cfg(target_os = "linux")]
#[test]
fn classification_observes_invalid_payload_metadata_without_rebinding_business_state() {
    let fixture = Fixture::new(&["gateway"]);
    let payload = b"deliberately invalid business JSON; classification must not parse it";
    fixture.put("servers.json", payload);
    let path = fixture.shared.join("servers.json");
    let root_identity = PrivateDirectory::open_existing(&fixture.shared)
        .unwrap()
        .directory_identity()
        .unwrap();
    let observed = observe(&fixture.plan, &BTreeSet::new(), false, None).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(
        observed[0].root.directory_identity().unwrap(),
        root_identity
    );
    assert_eq!(fs::read_dir(&fixture.shared).unwrap().count(), 1);
    assert!(!fixture.plan.target.data_root.join("studio").exists());
    assert_eq!(fs::read(path).unwrap(), payload);
}

#[test]
fn a_replaced_client_root_and_a_native_alias_do_not_become_client_ownership() {
    for native_alias in [false, true] {
        let mut fixture = Fixture::new(&["desktop"]);
        if native_alias {
            fixture.plan.components[1].source = fixture.plan.from.data_root.clone();
            fixture.plan.components[1].source_identity =
                fixture.plan.components[0].source_identity.clone();
        } else {
            fs::rename(&fixture.shared, fixture.home.join("original-client-root")).unwrap();
            fs::create_dir(&fixture.shared).unwrap();
        }
        assert_eq!(fixture.error(false), "STORAGE_LEGACY_SOURCE_CHANGED");
    }
}
