use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
const PRIVATE: &str = "SYNTHETIC_MCP_PRIVATE_VALUE";
const GROUP: &str = "group-cccccccccccccccccccccccccccccccc";

fn observation_bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

#[test]
fn publication_metadata_observer_checks_original_backing_without_writes() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new(false);
        let backend = Backend::default();
        let reference = f.prepare(mode, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        f.publish(&reference, &backend).unwrap();
        let config = f.bound(&reference);
        let expected = f
            .store
            .mcp_connection_revision(&config, mode, &backend)
            .unwrap();
        let reads = backend.reads.load(Ordering::SeqCst);
        let writes = backend.writes.load(Ordering::SeqCst);
        let before = observation_bytes(f.root.path());
        assert_eq!(
            f.store
                .observe_mcp_connection_revision(&config, mode, &backend)
                .unwrap(),
            expected
        );
        assert_eq!(observation_bytes(f.root.path()), before);
        if mode == CredentialStoreMode::Keyring {
            assert!(backend.reads.load(Ordering::SeqCst) > reads);
        }
        assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
        let mut changed = config.clone();
        changed.name = "other-owner".into();
        assert!(
            f.store
                .observe_mcp_connection_revision(&changed, mode, &backend)
                .is_err()
        );
    }
}

#[test]
fn publication_metadata_observer_refuses_pending_pair_or_group_without_parsing_or_repair() {
    for name in [".provider-transaction.json", super::super::GROUP_JOURNAL] {
        let f = Fixture::new(false);
        let backend = Backend::default();
        let reference = f.prepare(CredentialStoreMode::File, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        f.publish(&reference, &backend).unwrap();
        // Invalid journal payload also proves the fixed observer never parses it.
        std::fs::write(
            f.root.path().join(name),
            b"SYNTHETIC_UNPARSEABLE_PRIVATE_JOURNAL",
        )
        .unwrap();
        let before = observation_bytes(f.root.path());
        assert_eq!(
            f.store
                .observe_mcp_connection_revision(
                    &f.bound(&reference),
                    CredentialStoreMode::File,
                    &backend
                )
                .unwrap_err()
                .to_string(),
            "CONFIGURATION_READ_ONLY_TRANSACTION_PENDING"
        );
        assert_eq!(observation_bytes(f.root.path()), before);
    }
}

#[test]
fn publication_metadata_observer_never_creates_missing_coordinator_or_reads_unlocked_snapshot() {
    let f = Fixture::new(false);
    let backend = Backend::default();
    let reference = f.prepare(CredentialStoreMode::File, &backend);
    f.store
        .stage(&reference, &f.payload().encode().unwrap(), &backend)
        .unwrap();
    f.publish(&reference, &backend).unwrap();
    let coordinator = OsStr::new(".provider-transaction.json.lock");
    let held = f
        .store
        .directory
        .open_read_write_file(coordinator, false)
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&held).unwrap();
    let before = observation_bytes(f.root.path());
    assert!(
        f.store
            .observe_mcp_connection_revision(
                &f.bound(&reference),
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    assert_eq!(observation_bytes(f.root.path()), before);
    drop(held);
    std::fs::remove_file(f.root.path().join(coordinator)).unwrap();
    let before = observation_bytes(f.root.path());
    assert!(
        f.store
            .observe_mcp_connection_revision(
                &f.bound(&reference),
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    assert_eq!(observation_bytes(f.root.path()), before);
}

#[test]
fn publication_metadata_observer_refuses_missing_real_keyring_backing_without_repair() {
    let f = Fixture::new(false);
    let backend = Backend::default();
    let reference = f.prepare(CredentialStoreMode::Keyring, &backend);
    f.store
        .stage(&reference, &f.payload().encode().unwrap(), &backend)
        .unwrap();
    f.publish(&reference, &backend).unwrap();
    let config = f.bound(&reference);
    f.store
        .observe_mcp_connection_revision(&config, CredentialStoreMode::Keyring, &backend)
        .unwrap();
    backend.values.lock().unwrap().remove(&reference.account);
    let before = observation_bytes(f.root.path());
    let writes = backend.writes.load(Ordering::SeqCst);
    assert!(
        f.store
            .observe_mcp_connection_revision(&config, CredentialStoreMode::Keyring, &backend)
            .is_err()
    );
    assert_eq!(observation_bytes(f.root.path()), before);
    assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
    assert!(
        !backend
            .values
            .lock()
            .unwrap()
            .contains_key(&reference.account)
    );
}

#[test]
fn an_explicit_extension_preserves_old_values_and_undo_restores_the_original_binding() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let mut f = Fixture::new(false);
        f.config.policy.required_env.push("OTHER".into());
        let backend = Backend::default();
        let first = f
            .store
            .prepare_mcp(&f.config, &["TOKEN".into()], &[], mode, &backend)
            .unwrap();
        let mut values = f.payload();
        f.store
            .stage(&first, &values.encode().unwrap(), &backend)
            .unwrap();
        f.publish(&first, &backend).unwrap();
        let old_config = f.bound(&first);
        let next = f
            .store
            .prepare_mcp_extension(
                &old_config,
                &["TOKEN".into(), "OTHER".into()],
                &[],
                mode,
                &backend,
            )
            .unwrap();
        assert_eq!(
            next.predecessor.as_deref(),
            Some(first.operation_id.as_str())
        );
        values
            .env
            .insert("OTHER".into(), "SYNTHETIC_ADDITIONAL_VALUE".into());
        f.store
            .stage(&next, &values.encode().unwrap(), &backend)
            .unwrap();
        // Even an unpublished child protects the binding its captured values depend on.
        assert!(f.undo(&backend).is_err());
        let group = "group-dddddddddddddddddddddddddddddddd";
        f.store
            .publish_group(group, std::slice::from_ref(&next), &backend, |doc| {
                doc["mcp_servers"] = serde_json::json!([f.bound(&next)]);
                Ok(())
            })
            .unwrap();
        let resolved = f.store.resolve_mcp(&f.bound(&next), &backend).unwrap();
        assert_eq!(resolved.env, values.env);
        assert_eq!(
            f.store.state(&first, &backend).unwrap(),
            Some(ImportState::Published)
        );
        assert!(f.undo(&backend).is_err());
        drop(resolved);
        if mode == CredentialStoreMode::Keyring {
            let before_settings = std::fs::read(f.root.path().join("settings.json")).unwrap();
            let before_credentials = std::fs::read(f.root.path().join("credentials.json")).unwrap();
            let original = backend
                .values
                .lock()
                .unwrap()
                .insert(first.account.clone(), "USER_CHANGED_PREDECESSOR".into())
                .unwrap();
            assert!(
                f.store
                    .undo_group(group, &backend, |doc| {
                        doc["mcp_servers"] = serde_json::json!([old_config]);
                        Ok(())
                    })
                    .is_err()
            );
            assert_eq!(
                std::fs::read(f.root.path().join("settings.json")).unwrap(),
                before_settings
            );
            assert_eq!(
                std::fs::read(f.root.path().join("credentials.json")).unwrap(),
                before_credentials
            );
            backend
                .values
                .lock()
                .unwrap()
                .insert(first.account.clone(), original);
        }
        f.store
            .undo_group(group, &backend, |doc| {
                doc["mcp_servers"] = serde_json::json!([old_config]);
                Ok(())
            })
            .unwrap();
        f.store.undo(&next, &backend).unwrap();
        assert_eq!(
            f.store
                .resolve_mcp(&f.bound(&first), &backend)
                .unwrap()
                .env
                .len(),
            1
        );
        f.undo(&backend).unwrap();
        f.store.undo(&first, &backend).unwrap();
        assert!(backend.values.lock().unwrap().is_empty());
    }
}

#[test]
fn extensions_reject_changed_preserved_values_and_parallel_children() {
    let mut f = Fixture::new(false);
    f.config.policy.required_env.push("OTHER".into());
    let backend = Backend::default();
    let mode = CredentialStoreMode::File;
    let first = f
        .store
        .prepare_mcp(&f.config, &["TOKEN".into()], &[], mode, &backend)
        .unwrap();
    let mut values = f.payload();
    f.store
        .stage(&first, &values.encode().unwrap(), &backend)
        .unwrap();
    f.publish(&first, &backend).unwrap();
    let bound = f.bound(&first);
    let names = vec!["TOKEN".into(), "OTHER".into()];
    let next = f
        .store
        .prepare_mcp_extension(&bound, &names, &[], mode, &backend)
        .unwrap();
    let competing = f
        .store
        .prepare_mcp_extension(&bound, &names, &[], mode, &backend)
        .unwrap();
    let before = std::fs::read(f.root.path().join("credentials.json")).unwrap();
    values
        .env
        .insert("OTHER".into(), "SYNTHETIC_ADDITIONAL_VALUE".into());
    let mut changed = values.clone();
    changed
        .env
        .insert("TOKEN".into(), "SYNTHETIC_CHANGED_VALUE".into());
    assert_eq!(
        f.store
            .stage(&next, &changed.encode().unwrap(), &backend)
            .unwrap_err()
            .to_string(),
        "mcp_credential_preserved_value_changed"
    );
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.json")).unwrap(),
        before
    );
    f.store
        .stage(&next, &values.encode().unwrap(), &backend)
        .unwrap();
    assert!(
        f.store
            .stage(&competing, &values.encode().unwrap(), &backend)
            .is_err()
    );
    assert_eq!(
        f.store.state(&first, &backend).unwrap(),
        Some(ImportState::Published)
    );
    f.store.undo(&next, &backend).unwrap();
    f.store
        .stage(&competing, &values.encode().unwrap(), &backend)
        .unwrap();
    f.store.undo(&competing, &backend).unwrap();
    f.undo(&backend).unwrap();
    f.store.undo(&first, &backend).unwrap();
}

#[derive(Default)]
struct Backend {
    values: Mutex<BTreeMap<String, String>>,
    writes: AtomicUsize,
    reads: AtomicUsize,
    lose_set_receipt: AtomicBool,
    lose_delete_receipt: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "owned-memory-backend".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, name: &str) -> Result<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.values.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.values
            .lock()
            .unwrap()
            .insert(name.into(), value.into());
        ensure!(
            !self.lose_set_receipt.swap(false, Ordering::SeqCst),
            "{PRIVATE}"
        );
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.values.lock().unwrap().remove(name);
        ensure!(
            !self.lose_delete_receipt.swap(false, Ordering::SeqCst),
            "{PRIVATE}"
        );
        Ok(())
    }
}

#[test]
fn effective_store_policy_is_enforced_before_private_backend_reads() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new(false);
        let backend = Backend::default();
        let reference = f.prepare(mode, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        f.publish(&reference, &backend).unwrap();
        let other = if mode == CredentialStoreMode::File {
            CredentialStoreMode::Keyring
        } else {
            CredentialStoreMode::File
        };
        let reads = backend.reads.load(Ordering::SeqCst);
        assert!(
            f.store
                .resolve_mcp_with_mode(&f.bound(&reference), other, &backend)
                .is_err()
        );
        assert_eq!(backend.reads.load(Ordering::SeqCst), reads);
        assert!(
            f.store
                .resolve_mcp_with_mode(&f.bound(&reference), mode, &backend)
                .is_ok()
        );
        assert!(
            f.store
                .resolve_mcp_with_mode(&f.bound(&reference), CredentialStoreMode::Auto, &backend)
                .is_ok()
        );
    }
}

#[test]
fn cached_connection_authority_requires_the_published_receipt_and_current_backing_value() {
    for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
        let f = Fixture::new(false);
        let backend = Backend::default();
        let reference = f.prepare(mode, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        f.publish(&reference, &backend).unwrap();
        let revision = f
            .store
            .mcp_connection_revision(&f.bound(&reference), mode, &backend)
            .unwrap();
        assert!(!revision.contains(PRIVATE));
        assert_eq!(
            revision,
            f.store
                .mcp_connection_revision(&f.bound(&reference), mode, &backend)
                .unwrap()
        );
        if mode == CredentialStoreMode::Keyring {
            let value = backend
                .values
                .lock()
                .unwrap()
                .remove(&reference.account)
                .unwrap();
            assert!(
                f.store
                    .mcp_connection_revision(&f.bound(&reference), mode, &backend)
                    .is_err()
            );
            backend
                .values
                .lock()
                .unwrap()
                .insert(reference.account.clone(), value);
        }
        f.undo(&backend).unwrap();
        assert!(
            f.store
                .mcp_connection_revision(&f.bound(&reference), mode, &backend)
                .is_err()
        );
    }
}

#[test]
fn private_and_environment_references_share_one_bounded_redaction_budget() {
    let mut f = Fixture::new(false);
    f.config.policy.env_vars = (0..32).map(|index| format!("EXTERNAL_{index}")).collect();
    let backend = Backend::default();
    assert!(
        f.store
            .prepare_mcp(
                &f.config,
                &["TOKEN".into()],
                &[],
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    assert!(!f.root.path().join("credentials.json").exists());
}

#[test]
fn lost_keyring_delete_receipt_keeps_mcp_inactive_and_reconciles_without_reinstalling() {
    let f = Fixture::new(true);
    let backend = Backend::default();
    let reference = f.prepare(CredentialStoreMode::Keyring, &backend);
    f.store
        .stage(&reference, &f.payload().encode().unwrap(), &backend)
        .unwrap();
    f.publish(&reference, &backend).unwrap();
    f.undo(&backend).unwrap();
    let writes = backend.writes.load(Ordering::SeqCst);
    backend.lose_delete_receipt.store(true, Ordering::SeqCst);
    let error = f.store.undo(&reference, &backend).unwrap_err();
    assert!(!format!("{error:#}").contains(PRIVATE));
    assert!(backend.values.lock().unwrap().is_empty());
    assert!(f.store.resolve_mcp(&f.bound(&reference), &backend).is_err());
    f.store.undo(&reference, &backend).unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
    assert!(backend.values.lock().unwrap().is_empty());
}
struct Fixture {
    root: tempfile::TempDir,
    store: ImportedCredentialStore,
    config: McpServerConfig,
    original: Value,
}
impl Fixture {
    fn new(http: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let original = serde_json::json!({"credential_store":"auto","mcp_servers":[]});
        std::fs::write(root.path().join("settings.json"), original.to_string()).unwrap();
        let config = serde_json::from_value(if http {
            serde_json::json!({"name":"shared","transport":"http","url":"https://example.invalid/mcp","policy":{"required_headers":["Authorization","X-Client"]}})
        } else { serde_json::json!({"name":"shared","command":"MUST_NOT_RUN","policy":{"required_env":["TOKEN"]}}) }).unwrap();
        Self {
            store: ImportedCredentialStore::open(root.path()).unwrap(),
            root,
            config,
            original,
        }
    }
    fn prepare(&self, mode: CredentialStoreMode, backend: &Backend) -> CredentialImportRef {
        self.store
            .prepare_mcp(
                &self.config,
                &self.config.policy.required_env,
                &self.config.policy.required_headers,
                mode,
                backend,
            )
            .unwrap()
    }
    fn bound(&self, reference: &CredentialImportRef) -> McpServerConfig {
        let mut config = self.config.clone();
        config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
        config
    }
    fn payload(&self) -> McpSecretValues {
        if self.config.transport == "http" {
            McpSecretValues {
                headers: BTreeMap::from([
                    ("Authorization".into(), format!("Bearer {PRIVATE}")),
                    ("X-Client".into(), PRIVATE.into()),
                ]),
                env: BTreeMap::new(),
            }
        } else {
            McpSecretValues {
                env: BTreeMap::from([("TOKEN".into(), format!("{PRIVATE}\nsecond-line"))]),
                headers: BTreeMap::new(),
            }
        }
    }
    fn publish(
        &self,
        reference: &CredentialImportRef,
        backend: &Backend,
    ) -> Result<CredentialGroupReceipt> {
        self.store.publish_group(
            GROUP,
            std::slice::from_ref(reference),
            backend,
            |document| {
                document["mcp_servers"] = serde_json::json!([self.bound(reference)]);
                Ok(())
            },
        )
    }
    fn undo(&self, backend: &Backend) -> Result<CredentialGroupReceipt> {
        self.store.undo_group(GROUP, backend, |document| {
            *document = self.original.clone();
            Ok(())
        })
    }
}

#[test]
fn file_and_keyring_mcp_material_is_private_inactive_until_publication_and_resolves_exactly() {
    for http in [false, true] {
        for mode in [CredentialStoreMode::File, CredentialStoreMode::Keyring] {
            let f = Fixture::new(http);
            let backend = Backend::default();
            let reference = f.prepare(mode, &backend);
            let payload = f.payload();
            let encoded = payload.encode().unwrap();
            assert!(!serde_json::to_string(&reference).unwrap().contains(PRIVATE));
            assert!(!format!("{payload:?}").contains(PRIVATE));
            f.store.stage(&reference, &encoded, &backend).unwrap();
            assert!(f.store.resolve_mcp(&f.bound(&reference), &backend).is_err());
            f.publish(&reference, &backend).unwrap();
            let loaded = f.store.resolve_mcp(&f.bound(&reference), &backend).unwrap();
            assert!(loaded.env == payload.env && loaded.headers == payload.headers);
            let settings = std::fs::read_to_string(f.root.path().join("settings.json")).unwrap();
            assert!(!settings.contains(PRIVATE));
            let credentials =
                CredentialStore::load_from(&f.root.path().join("credentials.json")).unwrap();
            assert!(!credentials.credentials.contains_key("shared"));
            assert!(!format!("{credentials:?}").contains(PRIVATE));
            if mode == CredentialStoreMode::Keyring {
                assert!(
                    !std::fs::read_to_string(f.root.path().join("credentials.json"))
                        .unwrap()
                        .contains(PRIVATE)
                );
            }
            f.undo(&backend).unwrap();
            f.store.undo(&reference, &backend).unwrap();
            assert!(f.store.resolve_mcp(&f.bound(&reference), &backend).is_err());
            assert!(backend.values.lock().unwrap().is_empty());
        }
    }
}

#[test]
fn endpoint_command_policy_and_profile_changes_never_redirect_a_published_secret() {
    for http in [false, true] {
        let f = Fixture::new(http);
        let backend = Backend::default();
        let reference = f.prepare(CredentialStoreMode::File, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        f.publish(&reference, &backend).unwrap();
        for change in ["name", "endpoint", "command", "policy"] {
            let mut changed = f.bound(&reference);
            match change {
                "name" => changed.name = "other".into(),
                "endpoint" => changed.url = "https://other.invalid/mcp".into(),
                "command" => changed.command = "other-command".into(),
                _ => changed.policy.disabled_tools.push("write".into()),
            }
            assert!(f.store.resolve_mcp(&changed, &backend).is_err(), "{change}");
        }
        let other = tempfile::tempdir().unwrap();
        std::fs::copy(
            f.root.path().join("credentials.json"),
            other.path().join("credentials.json"),
        )
        .unwrap();
        assert!(
            ImportedCredentialStore::open(other.path())
                .unwrap()
                .resolve_mcp(&f.bound(&reference), &backend)
                .is_err()
        );
    }
}

#[test]
fn keyring_lost_receipts_reconcile_and_cannot_overwrite_a_later_value() {
    let f = Fixture::new(true);
    let backend = Backend::default();
    let reference = f.prepare(CredentialStoreMode::Keyring, &backend);
    let encoded = f.payload().encode().unwrap();
    backend.lose_set_receipt.store(true, Ordering::SeqCst);
    let error = f.store.stage(&reference, &encoded, &backend).unwrap_err();
    assert!(!error.to_string().contains(PRIVATE));
    f.store.stage(&reference, &encoded, &backend).unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
    f.publish(&reference, &backend).unwrap();
    backend
        .values
        .lock()
        .unwrap()
        .insert(reference.account.clone(), "USER_REPLACEMENT".into());
    assert!(f.store.resolve_mcp(&f.bound(&reference), &backend).is_err());
    assert!(f.undo(&backend).is_err());
    assert!(
        backend
            .values
            .lock()
            .unwrap()
            .get(&reference.account)
            .is_some_and(|value| value == "USER_REPLACEMENT")
    );
}

#[test]
fn a_provider_and_mcp_with_the_same_name_keep_separate_credential_namespaces() {
    let f = Fixture::new(false);
    let backend = Backend::default();
    let mcp = f.prepare(CredentialStoreMode::File, &backend);
    let provider = f
        .store
        .prepare("shared", CredentialStoreMode::File, &backend)
        .unwrap();
    f.store
        .stage(&mcp, &f.payload().encode().unwrap(), &backend)
        .unwrap();
    f.store
        .stage(&provider, "PROVIDER_ONLY_CANARY", &backend)
        .unwrap();
    let definition = crate::default_active_provider_config();
    f.store
        .publish_group(
            GROUP,
            &[mcp.clone(), provider.clone()],
            &backend,
            |document| {
                document["providers"] = serde_json::json!({"shared":definition});
                document["mcp_servers"] = serde_json::json!([f.bound(&mcp)]);
                Ok(())
            },
        )
        .unwrap();
    assert!(
        f.store
            .resolve_mcp(&f.bound(&mcp), &backend)
            .unwrap()
            .env
            .contains_key("TOKEN")
    );
    let saved = CredentialStore::load_from(&f.root.path().join("credentials.json")).unwrap();
    assert!(
        saved
            .credentials
            .get("shared")
            .is_some_and(|value| value == "PROVIDER_ONLY_CANARY")
    );
    f.undo(&backend).unwrap();
    f.store.undo(&mcp, &backend).unwrap();
    f.store.undo(&provider, &backend).unwrap();
}

#[test]
fn paired_publication_and_undo_faults_recover_a_complete_view_without_journal_secrets() {
    for point in 1..=6 {
        let f = Fixture::new(true);
        let backend = Backend::default();
        let reference = f.prepare(CredentialStoreMode::File, &backend);
        f.store
            .stage(&reference, &f.payload().encode().unwrap(), &backend)
            .unwrap();
        if point > 3 {
            f.publish(&reference, &backend).unwrap();
        }
        super::super::group::inject_failure(point);
        assert!(
            if point <= 3 {
                f.publish(&reference, &backend)
            } else {
                f.undo(&backend)
            }
            .is_err()
        );
        let journal =
            std::fs::read_to_string(f.root.path().join(super::super::GROUP_JOURNAL)).unwrap();
        assert!(!journal.contains(PRIVATE));
        let current = crate::ProfileSettingsFile::new(
            PrivateDirectory::open_existing(f.root.path()).unwrap(),
        )
        .unwrap()
        .read()
        .unwrap();
        let published = point == 3 || point == 4 || point == 5;
        assert_eq!(
            current
                .get("mcp_servers")
                .and_then(Value::as_array)
                .is_some_and(|servers| !servers.is_empty()),
            published,
            "point {point}"
        );
        assert_eq!(
            f.store.resolve_mcp(&f.bound(&reference), &backend).is_ok(),
            published,
            "point {point}"
        );
        assert!(!f.root.path().join(super::super::GROUP_JOURNAL).exists());
    }
}

#[test]
fn undeclared_fields_and_invalid_headers_fail_before_any_credential_is_written() {
    let f = Fixture::new(true);
    let backend = Backend::default();
    assert!(
        f.store
            .prepare_mcp(
                &f.config,
                &["TOKEN".into()],
                &[],
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
    );
    let reference = f.prepare(CredentialStoreMode::File, &backend);
    let mut payload = f.payload();
    payload
        .headers
        .insert("Authorization".into(), "bad\r\nvalue".into());
    assert!(payload.encode().is_err());
    assert!(!f.root.path().join("credentials.json").exists());
    assert!(backend.values.lock().unwrap().is_empty());
    assert!(!serde_json::to_string(&reference).unwrap().contains(PRIVATE));
}

#[test]
fn mcp_display_names_keep_unicode_without_acquiring_provider_namespace_rules() {
    let mut f = Fixture::new(false);
    f.config.name = "文档服务".into();
    let backend = Backend::default();
    let reference = f.prepare(CredentialStoreMode::File, &backend);
    f.store
        .stage(&reference, &f.payload().encode().unwrap(), &backend)
        .unwrap();
    f.publish(&reference, &backend).unwrap();
    assert!(f.store.resolve_mcp(&f.bound(&reference), &backend).is_ok());
    assert!(
        !CredentialStore::load_from(&f.root.path().join("credentials.json"))
            .unwrap()
            .credentials
            .contains_key("文档服务")
    );
}
