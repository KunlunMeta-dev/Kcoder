//! Stable install ownership layered over the ordinary plugin staging/transaction mechanism.
use super::state::InstalledPluginRecordV1;
use super::*;
use crate::migration::package_revision;

const RECEIPT_VERSION: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PluginMigrationNativeState {
    Prepared,
    Installed,
    Retiring,
    Retired,
    Missing,
    Changed,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    Prepared,
    Installed,
    Retiring,
    Retired,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    owner: String,
    operation_id: String,
    plugin_id: PluginId,
    revision: String,
    stage: Stage,
    record: Option<InstalledPluginRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_identity: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptV1 {
    version: u8,
    owner: String,
    operation_id: String,
    plugin_id: PluginId,
    revision: String,
    stage: Stage,
    record: Option<InstalledPluginRecordV1>,
    #[serde(default)]
    project_identity: Option<String>,
}
fn op(value: &str) -> Result<()> {
    anyhow::ensure!(
        value.len() == 32
            && Uuid::parse_str(value).is_ok_and(|id| id.simple().to_string() == value),
        "plugin_migration_invalid_operation"
    );
    Ok(())
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn receipts(directory: &PrivateDirectory, create: bool) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new("migration-installs-v1"), create) {
        Ok(dir) => {
            dir.verify_private_directory()?;
            Ok(Some(dir))
        }
        Err(error) if !create && missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}
fn load(directory: &PrivateDirectory, id: &str) -> Result<Option<Receipt>> {
    op(id)?;
    let file = match directory.open_regular_file_snapshot(OsStr::new(&format!("{id}.json"))) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    anyhow::ensure!(
        file.metadata()?.len() <= 32 * 1024,
        "plugin_migration_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(32 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 32 * 1024,
        "plugin_migration_metadata_budget_exceeded"
    );
    Ok(Some(decode_receipt(&bytes)?))
}
fn decode_receipt(bytes: &[u8]) -> Result<Receipt> {
    if let Ok(receipt) = serde_json::from_slice::<ReceiptV1>(bytes)
        && receipt.version == 1
    {
        return Ok(Receipt {
            version: RECEIPT_VERSION,
            owner: receipt.owner,
            operation_id: receipt.operation_id,
            plugin_id: receipt.plugin_id,
            revision: receipt.revision,
            stage: receipt.stage,
            record: receipt.record.map(Into::into),
            project_identity: receipt.project_identity,
        });
    }
    let receipt: Receipt =
        serde_json::from_slice(bytes).map_err(|_| anyhow!("plugin_migration_invalid_receipt"))?;
    anyhow::ensure!(
        receipt.version == RECEIPT_VERSION,
        "plugin_migration_invalid_receipt"
    );
    Ok(receipt)
}
fn save(directory: &PrivateDirectory, receipt: &Receipt) -> Result<()> {
    let data = serde_json::to_vec(receipt)?;
    anyhow::ensure!(
        data.len() <= 32 * 1024,
        "plugin_migration_metadata_budget_exceeded"
    );
    directory.atomic_replace(OsStr::new(&format!("{}.json", receipt.operation_id)), &data)
}
fn validate(
    receipt: &Receipt,
    root: &PrivateDirectory,
    id: &PluginId,
    operation: &str,
    revision: &str,
) -> Result<()> {
    anyhow::ensure!(
        receipt.version == RECEIPT_VERSION
            && receipt.owner == root.directory_identity()?
            && receipt.plugin_id == *id
            && receipt.operation_id == operation
            && receipt.revision == revision,
        "plugin_migration_request_changed"
    );
    Ok(())
}
fn classify(
    receipt: &Receipt,
    current: Option<&InstalledPluginRecord>,
    root: &Path,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
    verify_contents: bool,
) -> Result<PluginMigrationNativeState> {
    if receipt.stage == Stage::Retired {
        return Ok(PluginMigrationNativeState::Retired);
    }
    let Some(current) = current else {
        return Ok(match receipt.stage {
            Stage::Prepared => PluginMigrationNativeState::Prepared,
            Stage::Retiring => PluginMigrationNativeState::Retired,
            _ => PluginMigrationNativeState::Missing,
        });
    };
    if current.project_identity != receipt.project_identity
        || current.plugin_id != receipt.plugin_id
        || current.operation_id != receipt.operation_id
        || current.enabled_by_default
        || receipt
            .record
            .as_ref()
            .is_some_and(|original| original != current)
    {
        return Ok(PluginMigrationNativeState::Changed);
    }
    if verify_contents
        && package_revision(&current.root(root), limits, cancel)?.sha256 != receipt.revision
    {
        return Ok(PluginMigrationNativeState::Changed);
    }
    Ok(if receipt.stage == Stage::Retiring {
        PluginMigrationNativeState::Retiring
    } else {
        PluginMigrationNativeState::Installed
    })
}
/// Pure observation does not create a store, lease file, transaction or recovery action.
pub fn observe_installation(
    root: &Path,
    id: &PluginId,
    operation: &str,
    revision: &str,
    cancel: &PluginCancellationToken,
) -> Result<Option<PluginMigrationNativeState>> {
    observe(root, id, operation, revision, cancel, true)
}
/// Observe publication receipts and record identity without hashing installed file bodies.
/// Imported is a publication fact; only guarded undo verifies that bodies remain unchanged.
pub fn observe_installation_receipt(
    root: &Path,
    id: &PluginId,
    operation: &str,
    revision: &str,
    cancel: &PluginCancellationToken,
) -> Result<Option<PluginMigrationNativeState>> {
    observe(root, id, operation, revision, cancel, false)
}
fn observe(
    root: &Path,
    id: &PluginId,
    operation: &str,
    revision: &str,
    cancel: &PluginCancellationToken,
    verify_contents: bool,
) -> Result<Option<PluginMigrationNativeState>> {
    op(operation)?;
    anyhow::ensure!(valid_hash(revision), "plugin_migration_invalid_revision");
    let directory = match PrivateDirectory::open_existing(root) {
        Ok(dir) => dir,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    let Some(receipts) = receipts(&directory, false)? else {
        return Ok(None);
    };
    let Some(receipt) = load(&receipts, operation)? else {
        return Ok(None);
    };
    validate(&receipt, &directory, id, operation, revision)?;
    let locks = directory.open_child(OsStr::new(LOCKS_DIRECTORY), false)?;
    let lock = locks.open_single_link_regular_file(OsStr::new(&plugin_lock_name(id)))?;
    FileExt::try_lock_shared(&lock).map_err(|_| anyhow!("plugin_migration_busy"))?;
    let state_exists = directory
        .open_single_link_regular_file(OsStr::new("state.json"))
        .is_ok();
    anyhow::ensure!(
        state_exists || receipt.stage == Stage::Prepared,
        "plugin_migration_state_missing"
    );
    let state = StoreState::load(root, &directory)?;
    classify(
        &receipt,
        state.installed.get(&id.to_string()),
        root,
        InstallLimits::default(),
        cancel,
        verify_contents,
    )
    .map(Some)
}
impl PluginStore {
    /// A stable request installs only into an absent identity and never inherits source enablement.
    pub fn install_migration_snapshot(
        &self,
        source: &Path,
        id: PluginId,
        operation: &str,
        revision: &str,
        cancel: &PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        self.install_migration_snapshot_in_scope(source, id, operation, revision, None, cancel)
    }
    /// A project mapping is Native authority, independent of the source's project label.
    pub fn install_migration_snapshot_for_project(
        &self,
        source: &Path,
        id: PluginId,
        operation: &str,
        revision: &str,
        project: &crate::PluginProjectBinding,
        cancel: &PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        project.verify_store(&self.root)?;
        self.install_migration_snapshot_in_scope(
            source,
            id,
            operation,
            revision,
            Some(project),
            cancel,
        )
    }
    fn install_migration_snapshot_in_scope(
        &self,
        source: &Path,
        id: PluginId,
        operation: &str,
        revision: &str,
        project: Option<&crate::PluginProjectBinding>,
        cancel: &PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        op(operation)?;
        anyhow::ensure!(valid_hash(revision), "plugin_migration_invalid_revision");
        if let Some(project) = project {
            project.verify_store(&self.root)?;
        }
        let project_identity = project.map(crate::PluginProjectBinding::identity);
        cancel.check()?;
        let deadline = Instant::now() + self.operation_timeout;
        let _operation = self.acquire_cancellable_lock(
            &format!("migration-{operation}.lock"),
            deadline,
            cancel,
        )?;
        let _lock = self.acquire_cancellable_lock(&plugin_lock_name(&id), deadline, cancel)?;
        self.recover_locked(&id, deadline)?;
        let receipts =
            receipts(&self.private_root, true)?.context("plugin_migration_receipts_missing")?;
        let existing = load(&receipts, operation)?;
        let mut receipt = if let Some(receipt) = existing {
            validate(&receipt, &self.private_root, &id, operation, revision)?;
            anyhow::ensure!(
                receipt.project_identity == project_identity,
                "plugin_migration_request_changed"
            );
            receipt
        } else {
            let mut count = 0;
            receipts.visit_entry_names_bounded(4097, |name| {
                if name.to_str().is_some_and(|name| name.ends_with(".json")) {
                    count += 1;
                }
                Ok(())
            })?;
            anyhow::ensure!(count < 4096, "plugin_migration_operation_budget_exceeded");
            let receipt = Receipt {
                version: RECEIPT_VERSION,
                owner: self.private_root.directory_identity()?,
                operation_id: operation.into(),
                plugin_id: id.clone(),
                revision: revision.into(),
                stage: Stage::Prepared,
                record: None,
                project_identity: project_identity.clone(),
            };
            save(&receipts, &receipt)?;
            receipt
        };
        let current = self.read(&id)?;
        match classify(
            &receipt,
            current.as_ref(),
            &self.root,
            self.limits,
            cancel,
            true,
        )? {
            PluginMigrationNativeState::Installed => {
                let record = current.context("plugin_migration_output_missing")?;
                receipt.stage = Stage::Installed;
                receipt.record = Some(record.clone());
                save(&receipts, &receipt)?;
                return Ok(record);
            }
            PluginMigrationNativeState::Prepared => {}
            PluginMigrationNativeState::Retired | PluginMigrationNativeState::Retiring => {
                bail!("plugin_migration_already_retired")
            }
            _ => bail!("plugin_migration_target_changed"),
        }
        anyhow::ensure!(current.is_none(), "plugin_migration_target_conflict");
        let target = PathBuf::from(CACHE_DIRECTORY)
            .join(id.marketplace_name())
            .join(id.plugin_name())
            .join(format!("install-{operation}"));
        anyhow::ensure!(
            !self.absolute(&target)?.exists(),
            "plugin_migration_outcome_unknown"
        );
        let source = PathBuf::from(source);
        let loaded = load_plugin_manifest(&source)
            .map_err(|_| anyhow!("plugin_migration_invalid_package"))?
            .context("plugin_migration_manifest_missing")?;
        let name = manifest_identity_name(&loaded.manifest)?;
        anyhow::ensure!(
            loaded.manifest.id.is_none() || name == id.plugin_name(),
            "plugin_migration_identity_changed"
        );
        anyhow::ensure!(
            package_revision(&source, self.limits, cancel)?.sha256 == revision,
            "plugin_migration_source_changed"
        );
        let staging_relative = PathBuf::from(STAGING_DIRECTORY).join(operation);
        let staging = self.absolute(&staging_relative)?;
        if staging.exists() {
            remove_owned_tree(&staging)?;
        }
        PrivateDirectory::open_or_create(&staging)?;
        let record = self.install_local_staged(StagedInstallRequest {
            canonical_source: &source,
            expected_manifest_name: name,
            plugin_id: id,
            operation_id: operation.into(),
            staging_relative,
            installed_source: InstalledPluginSource::Local {
                canonical_path: source.clone(),
            },
            cancellation: cancel,
            deadline,
            force_disabled: true,
            migration_revision: Some(revision),
            project_identity,
        })?;
        receipt.stage = Stage::Installed;
        receipt.record = Some(record.clone());
        save(&receipts, &receipt)?;
        Ok(record)
    }
    pub fn uninstall_migration_owned(
        &self,
        id: &PluginId,
        operation: &str,
        revision: &str,
        cancel: &PluginCancellationToken,
    ) -> Result<bool> {
        op(operation)?;
        let _operation = self.acquire_cancellable_lock(
            &format!("migration-{operation}.lock"),
            Instant::now() + self.operation_timeout,
            cancel,
        )?;
        let receipts =
            receipts(&self.private_root, false)?.context("plugin_migration_receipts_missing")?;
        let mut receipt =
            load(&receipts, operation)?.context("plugin_migration_receipt_missing")?;
        validate(&receipt, &self.private_root, id, operation, revision)?;
        if receipt.stage == Stage::Retired {
            return Ok(false);
        }
        let current = self.read(id)?;
        if receipt.stage == Stage::Prepared && receipt.record.is_none() {
            anyhow::ensure!(
                classify(
                    &receipt,
                    current.as_ref(),
                    &self.root,
                    self.limits,
                    cancel,
                    true
                )? == PluginMigrationNativeState::Installed,
                "plugin_migration_outcome_unknown"
            );
            receipt.record = current.clone();
            receipt.stage = Stage::Installed;
            save(&receipts, &receipt)?;
        }
        if current.is_none() {
            anyhow::ensure!(
                receipt.stage == Stage::Retiring,
                "plugin_migration_output_missing"
            );
            receipt.stage = Stage::Retired;
            save(&receipts, &receipt)?;
            return Ok(false);
        }
        let removed =
            self.uninstall_guarded(id, false, cancel, false, |record, path, unused| {
                anyhow::ensure!(unused, "plugin_migration_in_use");
                anyhow::ensure!(
                    record.operation_id == operation
                        && receipt.record.as_ref() == Some(record)
                        && !record.enabled_by_default,
                    "plugin_migration_target_changed"
                );
                anyhow::ensure!(
                    package_revision(path, self.limits, cancel)?.sha256 == revision,
                    "plugin_migration_target_changed"
                );
                receipt.stage = Stage::Retiring;
                save(&receipts, &receipt)
            })?;
        receipt.stage = Stage::Retired;
        save(&receipts, &receipt)?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::PrivateDirectory;

    fn record(operation_id: &str) -> InstalledPluginRecord {
        InstalledPluginRecord {
            plugin_id: "demo@local".parse().unwrap(),
            display_name: "Demo".into(),
            version: Some("1.0.0".into()),
            enabled_by_default: false,
            operation_id: operation_id.into(),
            installation_id: operation_id.into(),
            file_count: 1,
            total_bytes: 4,
            cache_relative_path: PathBuf::from(format!("cache/local/demo/install-{operation_id}")),
            source: InstalledPluginSource::Local {
                canonical_path: PathBuf::from("/source/demo"),
            },
            project_identity: None,
        }
    }

    #[test]
    fn v1_receipt_decodes_legacy_record_without_writing_until_save() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(temp.path()).unwrap();
        let operation_id = "a".repeat(32);
        let expected = record(&operation_id);
        let mut legacy_record = serde_json::to_value(&expected).unwrap();
        legacy_record
            .as_object_mut()
            .unwrap()
            .remove("installation_id");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "owner": "owner",
            "operation_id": operation_id,
            "plugin_id": "demo@local",
            "revision": "b".repeat(64),
            "stage": "installed",
            "record": legacy_record,
        }))
        .unwrap();
        directory
            .atomic_replace(OsStr::new(&format!("{operation_id}.json")), &bytes)
            .unwrap();

        let receipt = load(&directory, &operation_id).unwrap().unwrap();

        assert_eq!(receipt.version, RECEIPT_VERSION);
        assert_eq!(receipt.record.as_ref(), Some(&expected));
        assert!(matches!(
            classify(
                &receipt,
                Some(&expected),
                temp.path(),
                InstallLimits::default(),
                &PluginCancellationToken::default(),
                false,
            )
            .unwrap(),
            PluginMigrationNativeState::Installed
        ));
        assert_eq!(
            std::fs::read(temp.path().join(format!("{operation_id}.json"))).unwrap(),
            bytes
        );

        save(&directory, &receipt).unwrap();
        let persisted: serde_json::Value = serde_json::from_slice(
            &std::fs::read(temp.path().join(format!("{operation_id}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["version"], RECEIPT_VERSION);
        assert_eq!(persisted["record"]["installation_id"], operation_id);
    }

    #[test]
    fn v2_receipt_rejects_a_record_without_installation_identity() {
        let operation_id = "a".repeat(32);
        let mut current_record = serde_json::to_value(record(&operation_id)).unwrap();
        current_record
            .as_object_mut()
            .unwrap()
            .remove("installation_id");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": RECEIPT_VERSION,
            "owner": "owner",
            "operation_id": operation_id,
            "plugin_id": "demo@local",
            "revision": "b".repeat(64),
            "stage": "installed",
            "record": current_record,
        }))
        .unwrap();

        assert!(decode_receipt(&bytes).is_err());
    }
}
