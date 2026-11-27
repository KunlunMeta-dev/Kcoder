use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct Backend {
    values: Mutex<BTreeMap<String, String>>,
    accounts: Mutex<std::collections::BTreeSet<String>>,
    read_only: AtomicBool,
    reads: AtomicUsize,
    fail_read: AtomicBool,
    lose_delete: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "owned-memory-backend".into()
    }
    fn available(&self) -> bool {
        assert!(
            !self.read_only.load(Ordering::SeqCst),
            "no availability probe during relocation"
        );
        true
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.accounts.lock().unwrap().insert(account.into());
        ensure!(
            !self.fail_read.load(Ordering::SeqCst),
            "synthetic backend unavailable"
        );
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        assert!(
            !self.read_only.load(Ordering::SeqCst),
            "relocation must never set a credential"
        );
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        assert!(
            !self.read_only.load(Ordering::SeqCst),
            "relocation must never delete a credential"
        );
        self.values.lock().unwrap().remove(account);
        ensure!(
            !self.lose_delete.swap(false, Ordering::SeqCst),
            "synthetic lost deletion receipt"
        );
        Ok(())
    }
}

#[test]
fn ordinary_plugin_and_mcp_accounts_remain_original_while_logout_stays_revoked() {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
    let backend = Backend::default();
    let revoked = install(&source, "LoggedOut", CredentialStoreMode::Keyring, &backend);
    let config: kcoder_types::McpServerConfig = serde_json::from_value(serde_json::json!({
        "name":"owned-mcp","command":"MUST_NOT_RUN","policy":{"required_env":["TOKEN"]}
    }))
    .unwrap();
    let reference = source
        .prepare_mcp(
            &config,
            &["TOKEN".into()],
            &[],
            CredentialStoreMode::Keyring,
            &backend,
        )
        .unwrap();
    let payload = mcp::McpSecretValues {
        env: BTreeMap::from([("TOKEN".into(), "SYNTHETIC_MCP_ONLY_VALUE".into())]),
        headers: BTreeMap::new(),
    };
    source
        .install(&reference, &payload.encode().unwrap(), &backend, |_| Ok(()))
        .unwrap();
    let mut config = config;
    config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
    let scope = "a".repeat(64);
    let plugin_account = format!("plugin/{scope}/{}", "b".repeat(32));
    let mut document = source.read().unwrap();
    document.0.remove_api_key("LoggedOut").unwrap();
    document
        .0
        .set_api_key("Ordinary", marker_for_provider("original-ordinary-account"))
        .unwrap();
    document.0.plugin_credentials.scopes.insert(
        scope.clone(),
        crate::plugin_credentials::PluginCredentialScope {
            operation_id: None,
            values: BTreeMap::from([(
                "TOKEN".into(),
                crate::plugin_credentials::PluginSecret::Keyring {
                    account: plugin_account.clone(),
                },
            )]),
        },
    );
    source.save(&document.0).unwrap();
    let original_settings = b"{\n// Keep the target loader's source document unchanged.\n\"credential_store\":\"auto\",\"max_retries\":17,\"providers\":{}\n}\n";
    source
        .directory
        .atomic_replace(OsStr::new("settings.json"), original_settings)
        .unwrap();
    let original_credentials = source.read_file("credentials.json").unwrap().unwrap();
    backend.values.lock().unwrap().remove(&revoked.account);
    backend
        .values
        .lock()
        .unwrap()
        .insert(plugin_account.clone(), "SYNTHETIC_PLUGIN_ONLY_VALUE".into());
    backend.values.lock().unwrap().insert(
        "original-ordinary-account".into(),
        "SYNTHETIC_ORDINARY_ONLY_VALUE".into(),
    );
    backend.accounts.lock().unwrap().clear();
    backend.read_only.store(true, Ordering::SeqCst);
    assert_eq!(
        source
            .preview_relocation(&backend)
            .unwrap()
            .keyring_accounts,
        3
    );
    let prepared = source
        .prepare_relocation("preserve-original-accounts", &backend)
        .unwrap();
    copy_profile(&source.directory, &target);
    map_profile(&source.directory, &target, "preserve-original-accounts");
    prepared.verify_target(&target, &backend).unwrap();
    drop(prepared);
    let copied = ImportedCredentialStore::open(target_root.path()).unwrap();
    assert!(copied.state(&revoked, &backend).is_err());
    assert!(copied.read().unwrap().0.revoked.contains("LoggedOut"));
    backend.accounts.lock().unwrap().clear();
    let reads_before_consumers = backend.reads.load(Ordering::SeqCst);
    let target_document =
        CredentialStore::load_from(&target_root.path().join("credentials.json")).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let mut settings = crate::SettingsLoader::new(workspace.path())
        .with_config_dir(target_root.path())
        .with_executable_dir(workspace.path().join("unused-executable"))
        .load_read_only_configuration_for_management()
        .unwrap()
        .settings;
    assert_eq!(settings.max_retries, 17);
    assert!(settings.providers.is_empty());
    // This is the same backend seam used by SettingsLoader's normal credential hydration.
    let (resolved, diagnostics) = crate::resolve_stored_credentials(
        &target_document.credentials,
        &backend,
        settings.credential_store,
    );
    assert!(diagnostics.is_empty());
    settings.stored_provider_credentials = resolved;
    settings.revoked_provider_credentials = target_document.revoked.clone();
    assert_eq!(
        settings
            .resolve_provider_api_key(Some("Ordinary"), None)
            .as_deref(),
        Some("SYNTHETIC_ORDINARY_ONLY_VALUE")
    );
    assert_eq!(
        settings.resolve_provider_api_key(Some("LoggedOut"), None),
        None
    );
    for values in [
        target_document
            .plugin_credentials
            .resolve(&scope, &backend, settings.credential_store)
            .unwrap(),
        target_document
            .plugin_credentials
            .resolve_strict(&scope, &backend, settings.credential_store)
            .unwrap(),
    ] {
        assert_eq!(
            values.get("TOKEN").map(String::as_str),
            Some("SYNTHETIC_PLUGIN_ONLY_VALUE")
        );
    }
    assert_eq!(
        copied.resolve_mcp(&config, &backend).unwrap().env,
        payload.env
    );
    assert!(backend.reads.load(Ordering::SeqCst) > reads_before_consumers);
    assert_eq!(
        *backend.accounts.lock().unwrap(),
        std::collections::BTreeSet::from([
            reference.account,
            plugin_account,
            "original-ordinary-account".into(),
        ])
    );
    assert!(!backend.accounts.lock().unwrap().contains(&revoked.account));
    assert_eq!(
        source
            .read_file("settings.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original_settings
    );
    assert_eq!(
        copied
            .read_file("settings.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original_settings
    );
    assert_eq!(
        source
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original_credentials.as_slice()
    );
    assert_eq!(
        copied
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original_credentials.as_slice()
    );
}

fn copy_profile(source: &PrivateDirectory, target: &PrivateDirectory) {
    source
        .visit_entry_names_bounded(128, |name| {
            let file = source.open_single_link_regular_file(name)?;
            let mut bytes = Vec::new();
            file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            target.atomic_replace(name, &bytes)
        })
        .unwrap();
}

fn map_profile(source: &PrivateDirectory, target: &PrivateDirectory, operation: &str) {
    ProfileIdentity::observe(source)
        .unwrap()
        .relocate(source, target, operation)
        .unwrap();
}

fn install(
    store: &ImportedCredentialStore,
    provider: &str,
    mode: CredentialStoreMode,
    backend: &Backend,
) -> CredentialImportRef {
    let reference = store.prepare(provider, mode, backend).unwrap();
    store
        .install(
            &reference,
            "SYNTHETIC_RELOCATION_ONLY_VALUE",
            backend,
            |_| Ok(()),
        )
        .unwrap();
    reference
}

#[test]
fn file_relocation_preserves_original_receipts_groups_staging_and_revocation_without_keyring_io() {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
    source
        .directory
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"credential_store":"file","providers":{}}"#,
        )
        .unwrap();
    let backend = Backend::default();
    let published = install(&source, "Published", CredentialStoreMode::File, &backend);
    let undone = install(&source, "Removed", CredentialStoreMode::File, &backend);
    source.undo(&undone, &backend).unwrap();
    let staged = source
        .prepare("Staged", CredentialStoreMode::File, &backend)
        .unwrap();
    source
        .stage(&staged, "SYNTHETIC_STAGED_ONLY_VALUE", &backend)
        .unwrap();
    let grouped = source
        .prepare("Grouped", CredentialStoreMode::File, &backend)
        .unwrap();
    source
        .stage(&grouped, "SYNTHETIC_GROUP_ONLY_VALUE", &backend)
        .unwrap();
    let group = source
        .publish_group(
            "group-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &[grouped],
            &backend,
            |document| {
                document["providers"]["Grouped"] =
                    serde_json::to_value(crate::default_active_provider_config())?;
                Ok(())
            },
        )
        .unwrap();
    let mut document = source.read().unwrap();
    document.0.remove_api_key("RevokedOrdinary").unwrap();
    source.save(&document.0).unwrap();
    let original = source.read_file("credentials.json").unwrap().unwrap();
    backend.read_only.store(true, Ordering::SeqCst);
    assert_eq!(
        source.preview_relocation(&backend).unwrap().import_receipts,
        4
    );
    let prepared = source
        .prepare_relocation("owned-file-relocation", &backend)
        .unwrap();
    copy_profile(&source.directory, &target);
    let copied = ImportedCredentialStore::open(target_root.path()).unwrap();
    assert_eq!(
        copied.check(&published).unwrap_err().to_string(),
        "credential_import_wrong_profile"
    );
    assert!(prepared.verify_target(&target, &backend).is_err());
    map_profile(&source.directory, &target, "owned-file-relocation");
    prepared.verify_target(&target, &backend).unwrap();
    prepared.verify_target(&target, &backend).unwrap();
    assert_eq!(
        copied
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original.as_slice()
    );
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    drop(prepared);
    assert_eq!(
        copied.state(&published, &backend).unwrap(),
        Some(ImportState::Published)
    );
    assert_eq!(
        copied.state(&staged, &backend).unwrap(),
        Some(ImportState::Staged)
    );
    assert_eq!(
        copied.state(&undone, &backend).unwrap(),
        Some(ImportState::Undone)
    );
    assert_eq!(copied.group_receipt(&group.group_id).unwrap(), Some(group));
    assert!(copied.read().unwrap().0.revoked.contains("RevokedOrdinary"));
}

#[test]
fn keyring_relocation_only_reads_exact_original_accounts_and_blocks_missing_changed_or_unavailable_values()
 {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
    let backend = Backend::default();
    let reference = install(&source, "Keyring", CredentialStoreMode::Keyring, &backend);
    let original = source.read_file("credentials.json").unwrap().unwrap();
    backend.read_only.store(true, Ordering::SeqCst);
    assert_eq!(
        source
            .preview_relocation(&backend)
            .unwrap()
            .keyring_accounts,
        1
    );
    let prepared = source
        .prepare_relocation("owned-keyring-relocation", &backend)
        .unwrap();
    copy_profile(&source.directory, &target);
    map_profile(&source.directory, &target, "owned-keyring-relocation");
    prepared.verify_target(&target, &backend).unwrap();
    prepared.verify_target(&target, &backend).unwrap();
    assert_eq!(
        source
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original.as_slice()
    );
    backend
        .values
        .lock()
        .unwrap()
        .insert(reference.account.clone(), "SYNTHETIC_CHANGED_VALUE".into());
    assert!(prepared.verify_target(&target, &backend).is_err());
    backend.values.lock().unwrap().remove(&reference.account);
    assert!(prepared.verify_target(&target, &backend).is_err());
    drop(prepared);
    for fail in [false, true] {
        backend.fail_read.store(fail, Ordering::SeqCst);
        assert!(source.preview_relocation(&backend).is_err());
    }
    assert_eq!(
        source
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        original.as_slice()
    );
    assert!(backend.values.lock().unwrap().is_empty());
}

#[test]
fn previews_never_create_locks_or_recover_transactions_and_preparation_settles_the_original_group()
{
    let empty = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(empty.path()).unwrap();
    let backend = Backend::default();
    backend.read_only.store(true, Ordering::SeqCst);
    source.preview_relocation(&backend).unwrap();
    assert_eq!(std::fs::read_dir(empty.path()).unwrap().count(), 0);
    backend.read_only.store(false, Ordering::SeqCst);
    source
        .directory
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"credential_store":"file","providers":{}}"#,
        )
        .unwrap();
    let reference = source
        .prepare("Grouped", CredentialStoreMode::File, &backend)
        .unwrap();
    source
        .stage(&reference, "SYNTHETIC_GROUP_ONLY_VALUE", &backend)
        .unwrap();
    super::super::group::inject_failure(3);
    assert!(
        source
            .publish_group(
                "group-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                &[reference],
                &backend,
                |document| {
                    document["providers"]["Grouped"] =
                        serde_json::to_value(crate::default_active_provider_config())?;
                    Ok(())
                }
            )
            .is_err()
    );
    let before = source.read_file(GROUP_JOURNAL).unwrap().unwrap();
    assert!(source.preview_relocation(&backend).is_err());
    assert_eq!(
        source.read_file(GROUP_JOURNAL).unwrap().unwrap().as_slice(),
        before.as_slice()
    );
    let prepared = source
        .prepare_relocation("recover-owned-group", &backend)
        .unwrap();
    assert!(source.read_file(GROUP_JOURNAL).unwrap().is_none());
    assert_eq!(source.read().unwrap().0.imported_credentials.groups["group-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].outcome, CredentialGroupOutcome::Committed);
    drop(prepared);
    source
        .directory
        .atomic_replace(OsStr::new(".provider-transaction.json"), b"{}")
        .unwrap();
    assert!(source.preview_relocation(&backend).is_err());
    assert!(
        source
            .prepare_relocation("blocked-provider-pair", &backend)
            .is_err()
    );
    assert_eq!(
        source
            .read_file(".provider-transaction.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        b"{}"
    );
}

#[test]
fn unknown_undo_and_policy_mismatch_are_blocked_without_backend_repair() {
    let root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend::default();
    let reference = install(&source, "Keyring", CredentialStoreMode::Keyring, &backend);
    backend.lose_delete.store(true, Ordering::SeqCst);
    assert!(source.undo(&reference, &backend).is_err());
    backend.read_only.store(true, Ordering::SeqCst);
    let bytes = source.read_file("credentials.json").unwrap().unwrap();
    assert_eq!(
        source.preview_relocation(&backend).unwrap_err().to_string(),
        "CREDENTIAL_RELOCATION_UNDO_RECOVERY_REQUIRED"
    );
    assert!(source.prepare_relocation("unknown-undo", &backend).is_err());
    assert_eq!(
        source
            .read_file("credentials.json")
            .unwrap()
            .unwrap()
            .as_slice(),
        bytes.as_slice()
    );
    let other = tempfile::tempdir().unwrap();
    let other = ImportedCredentialStore::open(other.path()).unwrap();
    other
        .directory
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"credential_store":"file"}"#,
        )
        .unwrap();
    let store = CredentialStore {
        credentials: BTreeMap::from([("Existing".into(), marker_for_provider("original-account"))]),
        ..Default::default()
    };
    other.save(&store).unwrap();
    let reads = backend.reads.load(Ordering::SeqCst);
    assert!(
        other
            .preview_relocation(&backend)
            .unwrap_err()
            .to_string()
            .starts_with("CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED")
    );
    assert_eq!(backend.reads.load(Ordering::SeqCst), reads);
}

#[test]
fn changed_source_or_live_owner_cannot_be_adopted_and_seed_is_not_an_operation_ledger() {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
    let backend = Backend::default();
    install(&source, "Published", CredentialStoreMode::File, &backend);
    let owner = source
        .directory
        .try_exclusive_lock(OsStr::new(LOCKS[0]))
        .unwrap()
        .unwrap();
    assert!(source.preview_relocation(&backend).is_err());
    assert!(source.prepare_relocation("live-owner", &backend).is_err());
    drop(owner);
    let prepared = source
        .prepare_relocation("original-operation", &backend)
        .unwrap();
    copy_profile(&source.directory, &target);
    map_profile(&source.directory, &target, "different-operation");
    // The caller's original coordinator proves publication. This owner verifies
    // data continuity; the stable seed does not issue per-move operation receipts.
    prepared.verify_target(&target, &backend).unwrap();
    let bytes = source.read_file("credentials.json").unwrap().unwrap();
    source
        .directory
        .atomic_replace(OsStr::new("credentials.json"), &bytes)
        .unwrap();
    assert!(prepared.verify_source(&backend).is_err());
}

#[test]
fn ordinary_settings_and_credentials_are_verified_without_import_receipts() {
    for changed in ["settings.json", "credentials.json"] {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let source = ImportedCredentialStore::open(root.path()).unwrap();
        let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
        let settings = b"{\n// Preserve this ordinary settings comment.\n\"credential_store\":\"file\",\"max_retries\":2\n}\n";
        source
            .directory
            .atomic_replace(OsStr::new("settings.json"), settings)
            .unwrap();
        source
            .save(&CredentialStore {
                credentials: BTreeMap::from([(
                    "Ordinary".into(),
                    "SYNTHETIC_ORDINARY_FILE_VALUE".into(),
                )]),
                ..Default::default()
            })
            .unwrap();
        let backend = Backend::default();
        backend.read_only.store(true, Ordering::SeqCst);
        let summary = source.preview_relocation(&backend).unwrap();
        assert_eq!(summary.import_receipts, 0);
        assert_eq!(summary.provider_credentials, 1);
        let prepared = source
            .prepare_relocation("ordinary-config-copy", &backend)
            .unwrap();
        copy_profile(&source.directory, &target);
        map_profile(&source.directory, &target, "ordinary-config-copy");
        prepared.verify_target(&target, &backend).unwrap();
        let copied = ImportedCredentialStore::open(target_root.path()).unwrap();
        assert_eq!(
            copied
                .read_file("settings.json")
                .unwrap()
                .unwrap()
                .as_slice(),
            settings
        );
        target.atomic_replace(OsStr::new(changed), b"{}").unwrap();
        assert_eq!(
            prepared
                .verify_target(&target, &backend)
                .unwrap_err()
                .to_string(),
            "CREDENTIAL_RELOCATION_TARGET_DATA_CHANGED"
        );
        assert_eq!(
            source
                .read_file("settings.json")
                .unwrap()
                .unwrap()
                .as_slice(),
            settings
        );
        assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn ordinary_settings_require_a_supported_object_and_version_without_imports() {
    for settings in [
        "[]",
        r#"{"meta":{"config_version":999999}}"#,
        r#"{"meta":"invalid"}"#,
    ] {
        let root = tempfile::tempdir().unwrap();
        let source = ImportedCredentialStore::open(root.path()).unwrap();
        source
            .directory
            .atomic_replace(OsStr::new("settings.json"), settings.as_bytes())
            .unwrap();
        let backend = Backend::default();
        backend.read_only.store(true, Ordering::SeqCst);
        assert_eq!(
            source.preview_relocation(&backend).unwrap_err().to_string(),
            "CREDENTIAL_RELOCATION_SETTINGS_FORMAT_UNSUPPORTED"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert!(
            source
                .prepare_relocation("unsupported-config-copy", &backend)
                .is_err()
        );
        assert_eq!(
            source
                .read_file("settings.json")
                .unwrap()
                .unwrap()
                .as_slice(),
            settings.as_bytes()
        );
        assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn configuration_writer_lock_gates_preview_without_changing_bytes() {
    let root = tempfile::tempdir().unwrap();
    let source = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend::default();
    backend.read_only.store(true, Ordering::SeqCst);
    crate::update_settings_and_credentials(&root.path().join("settings.json"), |settings, keys| {
        assert_eq!(
            source.preview_relocation(&backend).unwrap_err().to_string(),
            "CREDENTIAL_RELOCATION_BUSY"
        );
        settings["credential_store"] = "file".into();
        settings["providers"] = serde_json::json!({});
        keys.set_api_key("Ordinary", "SYNTHETIC_FILE_VALUE".into())?;
        Ok(())
    })
    .unwrap();
    let names = [
        LOCKS[0],
        LOCKS[1],
        LOCKS[2],
        "settings.json",
        "credentials.json",
    ];
    let before: Vec<_> = names
        .iter()
        .map(|name| {
            (
                std::fs::read(root.path().join(name)).unwrap(),
                source
                    .directory
                    .regular_file_identity(OsStr::new(name))
                    .unwrap(),
            )
        })
        .collect();
    let summary = source.preview_relocation(&backend).unwrap();
    assert_eq!(summary.provider_credentials, 1);
    assert_eq!(summary.import_receipts, 0);
    for (name, (bytes, identity)) in names.iter().zip(before) {
        assert_eq!(std::fs::read(root.path().join(name)).unwrap(), bytes);
        assert_eq!(
            source
                .directory
                .regular_file_identity(OsStr::new(name))
                .unwrap(),
            identity
        );
    }
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), names.len());
}

#[test]
fn ordinary_coordination_lock_leases_are_shared_and_exclusive_holders_are_busy() {
    for name in LOCKS {
        let root = tempfile::tempdir().unwrap();
        let source = ImportedCredentialStore::open(root.path()).unwrap();
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(root.path().join(name))
            .unwrap();
        let first = existing_locks(&source.directory).unwrap();
        let second = existing_locks(&source.directory).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert!(fs2::FileExt::try_lock_exclusive(&file).is_err());
        drop(first);
        drop(second);
        fs2::FileExt::try_lock_exclusive(&file).unwrap();
        let backend = Backend::default();
        backend.read_only.store(true, Ordering::SeqCst);
        assert_eq!(
            source.preview_relocation(&backend).unwrap_err().to_string(),
            "CREDENTIAL_RELOCATION_BUSY"
        );
        fs2::FileExt::unlock(&file).unwrap();
        source.preview_relocation(&backend).unwrap();
        assert_eq!(std::fs::read(root.path().join(name)).unwrap(), b"");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[test]
fn ordinary_coordination_lock_replacement_invalidates_the_prepared_source() {
    for changed in LOCKS {
        let root = tempfile::tempdir().unwrap();
        let source = ImportedCredentialStore::open(root.path()).unwrap();
        for name in LOCKS {
            std::fs::File::create(root.path().join(name)).unwrap();
        }
        let backend = Backend::default();
        backend.read_only.store(true, Ordering::SeqCst);
        let prepared = source
            .prepare_relocation("held-ordinary-lock", &backend)
            .unwrap();
        std::fs::rename(root.path().join(changed), root.path().join("original.lock")).unwrap();
        std::fs::write(root.path().join(changed), b"ordinary replacement").unwrap();
        assert_eq!(
            prepared.verify_source(&backend).unwrap_err().to_string(),
            "CREDENTIAL_RELOCATION_SOURCE_LOCK_CHANGED"
        );
        assert_eq!(
            std::fs::read(root.path().join(changed)).unwrap(),
            b"ordinary replacement"
        );
        assert_eq!(
            std::fs::read(root.path().join("original.lock")).unwrap(),
            b""
        );
    }
}

#[cfg(unix)]
#[test]
fn ordinary_coordination_lock_links_are_rejected_without_repair() {
    use std::os::unix::fs::symlink;
    for name in LOCKS {
        for symbolic in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let source = ImportedCredentialStore::open(root.path()).unwrap();
            let original = root.path().join("original.lock");
            let target = root.path().join(name);
            std::fs::write(&original, b"ordinary lock bytes").unwrap();
            if symbolic {
                symlink(&original, &target).unwrap();
            } else {
                std::fs::hard_link(&original, &target).unwrap();
            }
            let backend = Backend::default();
            backend.read_only.store(true, Ordering::SeqCst);
            assert!(source.preview_relocation(&backend).is_err());
            assert_eq!(std::fs::read(original).unwrap(), b"ordinary lock bytes");
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
            assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
        }
    }
}
