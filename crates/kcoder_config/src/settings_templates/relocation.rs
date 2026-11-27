//! The template owner rebinds only active import stamps after final publication.
use super::*;
use crate::{PortableLeaseIdentity, PrivateLeaseMode, profile_identity::ProfileIdentity};
use std::{collections::BTreeMap, ffi::OsStr, fs::File};
use transaction::Stamp;

const LOCK: &str = ".settings-templates.lock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateRelocationSummary {
    pub templates: usize,
    pub frozen_bindings: usize,
    pub import_receipts: usize,
}

#[derive(PartialEq, Eq)]
struct Snapshot {
    directory: Option<String>,
    bindings_directory: Option<String>,
    index_bytes: Option<Vec<u8>>,
    index_stamp: Option<Stamp>,
    templates: BTreeMap<String, Stamp>,
    bindings: BTreeMap<String, Stamp>,
}

/// Holds the original template coordinator across copying. Native identity and
/// stopped-process authority remain the enclosing migration owner's responsibility.
pub struct TemplateRelocation {
    source: SettingsTemplateStore,
    profile: ProfileIdentity,
    operation_id: String,
    snapshot: Snapshot,
    lock: File,
    #[cfg(test)]
    lose_ack: std::cell::Cell<bool>,
}

impl SettingsTemplateStore {
    /// Read-only preflight never creates a lock, frozen version, or recovery record.
    pub fn preview_relocation(&self) -> Result<TemplateRelocationSummary> {
        let _lease = existing_lock(&self.directory, PrivateLeaseMode::Shared)?;
        self.require_relocation_settled()?;
        let profile = ProfileIdentity::observe(&self.directory)?;
        let snapshot = self.relocation_snapshot(true)?;
        anyhow::ensure!(
            self.relocation_snapshot(true)? == snapshot,
            "SETTINGS_TEMPLATE_RELOCATION_SOURCE_CHANGED"
        );
        self.require_relocation_settled()?;
        profile.verify(&self.directory)?;
        Ok(TemplateRelocationSummary {
            templates: snapshot.templates.len(),
            frozen_bindings: snapshot.bindings.len(),
            import_receipts: self.read_index()?.imports.len(),
        })
    }

    /// Run after shutdown and before copying so an inode-bound pending journal is
    /// settled at its original location. Unknown recovery never blesses a copy.
    pub fn prepare_relocation(&self, operation_id: &str) -> Result<TemplateRelocation> {
        anyhow::ensure!(
            !operation_id.trim().is_empty() && operation_id.chars().count() <= 256,
            "SETTINGS_TEMPLATE_RELOCATION_INVALID_OPERATION"
        );
        let lock = self.guard()?;
        self.require_relocation_settled()?;
        let source = SettingsTemplateStore {
            config_dir: self.config_dir.clone(),
            root: self.root.clone(),
            directory: self.directory.try_clone()?,
        };
        let prepared = TemplateRelocation {
            profile: ProfileIdentity::observe(&source.directory)?,
            snapshot: source.relocation_snapshot(true)?,
            source,
            operation_id: operation_id.into(),
            lock,
            #[cfg(test)]
            lose_ack: std::cell::Cell::new(false),
        };
        prepared.verify_source()?;
        Ok(prepared)
    }

    fn require_relocation_settled(&self) -> Result<()> {
        let Some(directory) = self.directory(false)? else {
            return Ok(());
        };
        match directory.entry_metadata(OsStr::new(".transaction.json")) {
            Ok(_) => anyhow::bail!("SETTINGS_TEMPLATE_RELOCATION_RECOVERY_REQUIRED"),
            Err(error) if storage::missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn relocation_snapshot(&self, verify_import_stamps: bool) -> Result<Snapshot> {
        self.require_relocation_settled()?;
        let directory = self.directory(false)?;
        let index_stamp = directory
            .as_ref()
            .map(|directory| transaction::stamp(directory, INDEX_FILE, storage::INDEX_LIMIT))
            .transpose()?
            .flatten();
        let index_bytes = self.read_file(INDEX_FILE, storage::INDEX_LIMIT)?;
        let index = self.read_index()?;
        let mut templates = BTreeMap::new();
        for entry in &index.templates {
            let name = format!("{}.jsonc", entry.id);
            let stamp = transaction::stamp(
                directory
                    .as_ref()
                    .context("SETTINGS_TEMPLATE_RELOCATION_BODY_MISSING")?,
                &name,
                MAX_TEMPLATE_BYTES as u64,
            )?
            .context("SETTINGS_TEMPLATE_RELOCATION_BODY_MISSING")?;
            templates.insert(name, stamp);
        }
        for receipt in index.imports.values() {
            self.verify_import_profile(&receipt.reference)?;
            match receipt.state {
                TemplateImportState::Committed if verify_import_stamps => {
                    self.verify_owned(&index, receipt)?;
                }
                TemplateImportState::Staged => {
                    self.empty_import_slot(&index, &receipt.reference)?;
                }
                _ => {}
            }
        }
        let bindings_directory = self.bindings_directory(false)?;
        let mut bindings = BTreeMap::new();
        let mut bytes = 0u64;
        if let Some(directory) = &bindings_directory {
            directory.visit_entry_names_bounded(1024, |name| {
                let name = name
                    .to_str()
                    .context("SETTINGS_TEMPLATE_RELOCATION_INVALID_BINDING")?;
                let (id, revision) = name
                    .strip_suffix(".jsonc")
                    .and_then(|name| name.rsplit_once('-'))
                    .context("SETTINGS_TEMPLATE_RELOCATION_INVALID_BINDING")?;
                let binding = SettingsTemplateBinding {
                    id: id.into(),
                    revision_sha256: revision.into(),
                };
                anyhow::ensure!(
                    bindings::filename(&binding)? == name,
                    "SETTINGS_TEMPLATE_RELOCATION_INVALID_BINDING"
                );
                let file = directory.open_single_link_regular_file(OsStr::new(name))?;
                bytes = bytes.saturating_add(file.metadata()?.len());
                anyhow::ensure!(
                    bytes <= 16 * 1024 * 1024,
                    "SETTINGS_TEMPLATE_RELOCATION_BINDING_BUDGET_EXCEEDED"
                );
                let stamp = transaction::stamp(directory, name, MAX_TEMPLATE_BYTES as u64)?
                    .context("SETTINGS_TEMPLATE_RELOCATION_BINDING_MISSING")?;
                anyhow::ensure!(
                    stamp.digest == revision,
                    "SETTINGS_TEMPLATE_RELOCATION_BINDING_CHANGED"
                );
                bindings.insert(name.into(), stamp);
                Ok(())
            })?;
        }
        anyhow::ensure!(
            directory
                .as_ref()
                .map(|directory| transaction::stamp(directory, INDEX_FILE, storage::INDEX_LIMIT))
                .transpose()?
                .flatten()
                == index_stamp,
            "SETTINGS_TEMPLATE_RELOCATION_INDEX_CHANGED"
        );
        Ok(Snapshot {
            directory: directory
                .as_ref()
                .map(PrivateDirectory::directory_identity)
                .transpose()?,
            bindings_directory: bindings_directory
                .as_ref()
                .map(PrivateDirectory::directory_identity)
                .transpose()?,
            index_bytes,
            index_stamp,
            templates,
            bindings,
        })
    }
}

impl TemplateRelocation {
    fn verify_source(&self) -> Result<()> {
        self.profile.verify(&self.source.directory)?;
        anyhow::ensure!(
            PrivateDirectory::open_existing(&self.source.config_dir)?.directory_identity()?
                == self.source.directory.directory_identity()?
                && self
                    .source
                    .directory
                    .regular_file_identity(OsStr::new(LOCK))?
                    == PrivateDirectory::identity_of_file(&self.lock)?
                && self.source.relocation_snapshot(true)? == self.snapshot,
            "SETTINGS_TEMPLATE_RELOCATION_SOURCE_CHANGED"
        );
        Ok(())
    }

    fn target(&self, final_target: &Path) -> Result<(SettingsTemplateStore, ProfileIdentity)> {
        self.verify_source()?;
        let target = SettingsTemplateStore::open(final_target)?;
        let profile = ProfileIdentity::observe(&target.directory)?;
        anyhow::ensure!(
            target.directory.directory_identity()? != self.source.directory.directory_identity()?
                && profile.logical_seed() == self.profile.logical_seed(),
            "SETTINGS_TEMPLATE_RELOCATION_TARGET_PROFILE_UNCONFIRMED"
        );
        // This read-only relationship check cannot initialize Native authority.
        self.profile.verify_relocation(
            &self.source.directory,
            &target.directory,
            &self.operation_id,
        )?;
        target.require_relocation_settled()?;
        Ok((target, profile))
    }

    fn expected_index(&self, target: &SettingsTemplateStore) -> Result<Option<Vec<u8>>> {
        let actual = target.relocation_snapshot(false)?;
        let same_contents = |source: &BTreeMap<String, Stamp>, target: &BTreeMap<String, Stamp>| {
            source.len() == target.len()
                && source.iter().all(|(name, stamp)| {
                    target
                        .get(name)
                        .is_some_and(|target| stamp.same_content(target))
                })
        };
        anyhow::ensure!(
            actual.directory.is_some() == self.snapshot.directory.is_some()
                && actual.bindings_directory.is_some()
                    == self.snapshot.bindings_directory.is_some()
                && same_contents(&self.snapshot.templates, &actual.templates)
                && same_contents(&self.snapshot.bindings, &actual.bindings),
            "SETTINGS_TEMPLATE_RELOCATION_TARGET_DATA_CHANGED"
        );
        let mut index = self.source.read_index()?;
        let mut changed = false;
        for receipt in index.imports.values_mut() {
            if receipt.state == TemplateImportState::Committed {
                let stamp = actual
                    .templates
                    .get(&format!("{}.jsonc", receipt.reference.id))
                    .context("SETTINGS_TEMPLATE_RELOCATION_BODY_MISSING")?;
                changed |= receipt.stamp.as_ref() != Some(stamp);
                receipt.stamp = Some(stamp.clone());
            }
        }
        let expected = if changed {
            Some(serde_json::to_vec_pretty(&index)?)
        } else {
            self.snapshot.index_bytes.clone()
        };
        anyhow::ensure!(
            actual.index_bytes == self.snapshot.index_bytes || actual.index_bytes == expected,
            "SETTINGS_TEMPLATE_RELOCATION_TARGET_INDEX_CHANGED"
        );
        Ok(expected)
    }

    /// Reissue only active import file stamps at the already published target.
    /// Immutable session bindings and every logical import fact remain unchanged.
    pub fn relocate(&self, final_target: &Path) -> Result<()> {
        let (target, profile) = self.target(final_target)?;
        let _lease = existing_lock(&target.directory, PrivateLeaseMode::Exclusive)?
            .context("SETTINGS_TEMPLATE_RELOCATION_TARGET_LOCK_MISSING")?;
        let expected = self.expected_index(&target)?;
        self.verify_source()?;
        if target.read_file(INDEX_FILE, storage::INDEX_LIMIT)? != expected {
            target.write_file(
                INDEX_FILE,
                expected
                    .as_deref()
                    .context("SETTINGS_TEMPLATE_RELOCATION_INDEX_MISSING")?,
            )?;
        }
        self.verify_target_unlocked(&target, &profile)?;
        #[cfg(test)]
        if self.lose_ack.replace(false) {
            anyhow::bail!("SETTINGS_TEMPLATE_RELOCATION_UNCONFIRMED");
        }
        Ok(())
    }

    /// A dedicated verification process may only observe the already adapted target.
    pub fn verify_target(&self, final_target: &Path) -> Result<()> {
        let (target, profile) = self.target(final_target)?;
        let _lease = existing_lock(&target.directory, PrivateLeaseMode::Shared)?
            .context("SETTINGS_TEMPLATE_RELOCATION_TARGET_LOCK_MISSING")?;
        self.verify_target_unlocked(&target, &profile)
    }

    fn verify_target_unlocked(
        &self,
        target: &SettingsTemplateStore,
        profile: &ProfileIdentity,
    ) -> Result<()> {
        anyhow::ensure!(
            PrivateDirectory::open_existing(&target.config_dir)?.directory_identity()?
                == target.directory.directory_identity()?
                && target.read_file(INDEX_FILE, storage::INDEX_LIMIT)?
                    == self.expected_index(target)?,
            "SETTINGS_TEMPLATE_RELOCATION_TARGET_UNCONFIRMED"
        );
        target.relocation_snapshot(true)?;
        profile.verify(&target.directory)?;
        self.verify_source()
    }
}

fn existing_lock(directory: &PrivateDirectory, mode: PrivateLeaseMode) -> Result<Option<File>> {
    directory.verify_config_root_directory()?;
    let file = match directory.open_read_write_file(OsStr::new(LOCK), false) {
        Ok(file) => file,
        Err(error) if storage::missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    // This empty coordinator carries no private payload. Match ordinary
    // settings locking without repairing a trusted inherited Windows ACL.
    let identity = PortableLeaseIdentity::from_storage_lock_handle(&file)?;
    let acquired = match mode {
        PrivateLeaseMode::Shared => fs2::FileExt::try_lock_shared(&file),
        PrivateLeaseMode::Exclusive => fs2::FileExt::try_lock_exclusive(&file),
    };
    directory.verify_config_root_directory()?;
    anyhow::ensure!(
        PortableLeaseIdentity::from_storage_lock_handle(&file)? == identity
            && PortableLeaseIdentity::from_storage_lock_handle(
                &directory.open_single_link_regular_file(OsStr::new(LOCK))?
            )? == identity,
        "SETTINGS_TEMPLATE_RELOCATION_SOURCE_CHANGED"
    );
    match acquired {
        Ok(()) => Ok(Some(file)),
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            anyhow::bail!("SETTINGS_TEMPLATE_RELOCATION_BUSY")
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests;
