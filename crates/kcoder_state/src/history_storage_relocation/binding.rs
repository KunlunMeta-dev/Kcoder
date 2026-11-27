//! Explicit logical-to-physical checks; native APIs only receive actual identities.
use super::*;
use kcoder_config::{PrivateManifestRemoval, VerifiedPortableEntry};

#[cfg(test)]
std::thread_local! {
    static INTERRUPT_DIRECTORY_REMOVAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) struct DirectoryRemovalInterruption;

#[cfg(test)]
impl DirectoryRemovalInterruption {
    pub(super) fn reached(&self) -> bool {
        INTERRUPT_DIRECTORY_REMOVAL.with(|pending| !pending.get())
    }
}

#[cfg(test)]
impl Drop for DirectoryRemovalInterruption {
    fn drop(&mut self) {
        INTERRUPT_DIRECTORY_REMOVAL.with(|pending| pending.set(false));
    }
}

#[cfg(test)]
pub(super) fn interrupt_next_directory_removal() -> DirectoryRemovalInterruption {
    INTERRUPT_DIRECTORY_REMOVAL.with(|pending| pending.set(true));
    DirectoryRemovalInterruption
}

pub(crate) trait HistoryDirectoryBinding {
    fn history_receipt_regular_identities(
        &self,
        name: &OsStr,
        current: &PortableLeaseIdentity,
    ) -> Result<Vec<PortableLeaseIdentity>>;
    fn history_owner_seed(&self) -> Result<String>;
    fn history_profile_seed(&self, profile: &PrivateDirectory) -> Result<String>;
    fn history_scope_path(&self) -> Result<Option<String>>;
    fn history_matches_private_directory(
        &self,
        recorded: &kcoder_types::PrivateFileIdentityV1,
    ) -> Result<bool>;
    fn history_matches_private_regular(
        &self,
        name: &OsStr,
        recorded: &kcoder_types::PrivateFileIdentityV1,
    ) -> Result<bool>;
    fn history_matches_file_identity(&self, name: &OsStr, recorded: &str) -> Result<bool>;
    fn history_matches_directory(&self, recorded: &str) -> Result<bool>;
    fn history_matches_child_directory(&self, name: &OsStr, recorded: &str) -> Result<bool>;
    fn history_regular_matches(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<bool>;
    fn history_resolve_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity>;
    fn history_resolve_retention(
        &self,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity>;
    fn history_resolve_child(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity>;
    fn history_lock(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
        mode: PrivateLeaseMode,
    ) -> Result<Option<VerifiedPrivateLease>>;
    fn history_verify_retention(&self, recorded: &PortableLeaseIdentity) -> Result<()>;
    fn history_open_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<VerifiedPortableEntry>;
    fn history_open_child(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PrivateDirectory>;
    fn history_quarantine(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
        destination: &OsStr,
    ) -> Result<VerifiedPortableEntry>;
    fn history_remove_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PrivateManifestRemoval>;
    fn history_remove_directory(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<()>;
    fn history_relocation_entry(&self, name: &OsStr) -> Result<bool>;
}

impl HistoryDirectoryBinding for PrivateDirectory {
    fn history_receipt_regular_identities(
        &self,
        name: &OsStr,
        current: &PortableLeaseIdentity,
    ) -> Result<Vec<PortableLeaseIdentity>> {
        ensure!(
            observed_regular_identity(self, name)? == *current,
            "HISTORY_RELOCATION_TARGET_CHANGED"
        );
        let mut identities = Vec::new();
        if let Some(mapping) = read_record(self)?
            && let Some(binding) = mapping
                .value
                .files
                .iter()
                .find(|binding| OsStr::new(&binding.name) == name && binding.target == *current)
        {
            // Historical receipt provenance only. Every native lock, read and
            // removal continues to use the separately observed current identity.
            for identity in &binding.recorded {
                if !identities.contains(identity) {
                    identities.push(identity.clone());
                }
            }
        }
        if !identities.contains(current) {
            identities.push(current.clone());
        }
        Ok(identities)
    }

    fn history_matches_file_identity(&self, name: &OsStr, recorded: &str) -> Result<bool> {
        let actual =
            crate::historical_undo::manifest::identity(&self.open_single_link_regular_file(name)?)?;
        let mapping = read_record(self)?;
        if actual == recorded {
            return Ok(true);
        }
        if let Some(mapping) = mapping
            && let Some(binding) = mapping.value.files.iter().find(|file| {
                OsStr::new(&file.name) == name
                    && file.recorded_strings.iter().any(|value| value == recorded)
            })
        {
            return Ok(observed_regular_identity(self, name)? == binding.target);
        }
        Ok(false)
    }

    fn history_scope_path(&self) -> Result<Option<String>> {
        Ok(read_record(self)?.map(|record| record.value.source.scope_path))
    }

    fn history_matches_private_directory(
        &self,
        recorded: &kcoder_types::PrivateFileIdentityV1,
    ) -> Result<bool> {
        let portable: PortableLeaseIdentity =
            serde_json::from_value(serde_json::to_value(recorded)?)?;
        Ok(observed_directory_identity(self)? == self.history_resolve_retention(&portable)?)
    }

    fn history_matches_private_regular(
        &self,
        name: &OsStr,
        recorded: &kcoder_types::PrivateFileIdentityV1,
    ) -> Result<bool> {
        let portable: PortableLeaseIdentity =
            serde_json::from_value(serde_json::to_value(recorded)?)?;
        self.history_regular_matches(name, &portable)
    }

    fn history_profile_seed(&self, profile: &PrivateDirectory) -> Result<String> {
        let actual = profile.directory_identity()?;
        Ok(match read_record(self)? {
            Some(record) => {
                ensure!(
                    record.value.target_profile == actual,
                    "HISTORY_RELOCATION_PROFILE_CHANGED"
                );
                record.value.source.owner_profile
            }
            None => actual,
        })
    }

    fn history_owner_seed(&self) -> Result<String> {
        Ok(match read_record(self)? {
            Some(record) => record.value.source.owner_seed,
            None => self.directory_identity()?,
        })
    }

    fn history_matches_directory(&self, recorded: &str) -> Result<bool> {
        let actual = self.directory_identity()?;
        let mapping = read_record(self)?;
        Ok(actual == recorded
            || mapping.is_some_and(|mapping| {
                mapping
                    .value
                    .source
                    .directory_aliases
                    .iter()
                    .any(|identity| identity == recorded)
            }))
    }

    fn history_matches_child_directory(&self, name: &OsStr, recorded: &str) -> Result<bool> {
        let child = self.open_child(name, false)?;
        if child.history_matches_directory(recorded)? {
            return Ok(true);
        }
        let actual = observed_directory_identity(&child)?;
        Ok(read_record(self)?.is_some_and(|mapping| {
            mapping.value.children.iter().any(|binding| {
                binding.target == actual
                    && binding
                        .recorded_strings
                        .iter()
                        .any(|identity| identity == recorded)
            })
        }))
    }

    fn history_regular_matches(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<bool> {
        Ok(observed_regular_identity(self, name)?
            == self.history_resolve_regular(name, recorded)?)
    }

    fn history_resolve_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity> {
        let mapping = read_record(self)?;
        if let Some(mapping) = mapping
            && let Some(binding) =
                mapping.value.files.iter().find(|entry| {
                    OsStr::new(&entry.name) == name && entry.recorded.contains(recorded)
                })
        {
            ensure!(
                observed_regular_identity(self, name)? == binding.target,
                "HISTORY_RELOCATION_TARGET_CHANGED"
            );
            return Ok(binding.target.clone());
        }
        Ok(recorded.clone())
    }

    fn history_resolve_retention(
        &self,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity> {
        if let Some(mapping) = read_record(self)?
            && mapping.value.source.retention_aliases.contains(recorded)
        {
            return Ok(mapping.value.target_retention);
        }
        Ok(recorded.clone())
    }

    fn history_resolve_child(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity> {
        let child = self.open_child(name, false)?;
        let resolved = child.history_resolve_retention(recorded)?;
        let actual = observed_directory_identity(&child)?;
        if actual == resolved {
            return Ok(resolved);
        }
        if let Some(mapping) = read_record(self)?
            && mapping
                .value
                .children
                .iter()
                .any(|binding| binding.recorded.contains(recorded) && binding.target == actual)
        {
            return Ok(actual);
        }
        Ok(resolved)
    }

    fn history_lock(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
        mode: PrivateLeaseMode,
    ) -> Result<Option<VerifiedPrivateLease>> {
        self.try_existing_portable_lock(name, &self.history_resolve_regular(name, recorded)?, mode)
    }

    fn history_verify_retention(&self, recorded: &PortableLeaseIdentity) -> Result<()> {
        self.portable_verify_retention_identity(&self.history_resolve_retention(recorded)?)
    }

    fn history_open_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<VerifiedPortableEntry> {
        self.portable_open_verified_regular(name, &self.history_resolve_regular(name, recorded)?)
    }

    fn history_open_child(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PrivateDirectory> {
        self.portable_open_verified_child(name, &self.history_resolve_child(name, recorded)?)
    }

    fn history_quarantine(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
        destination: &OsStr,
    ) -> Result<VerifiedPortableEntry> {
        self.portable_quarantine_verified_entry(
            name,
            &self.history_resolve_child(name, recorded)?,
            destination,
        )
    }

    fn history_remove_regular(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<PrivateManifestRemoval> {
        self.portable_remove_verified_regular_leaf(
            name,
            &self.history_resolve_regular(name, recorded)?,
        )
    }

    fn history_remove_directory(
        &self,
        name: &OsStr,
        recorded: &PortableLeaseIdentity,
    ) -> Result<()> {
        let directory = self.open_child(name, false)?;
        let actual = self.history_resolve_child(name, recorded)?;
        directory.portable_verify_retention_identity(&actual)?;
        if let Some(record) = read_record(&directory)? {
            // The original owner has already verified its manifest and selected
            // this exact empty-directory removal. A mapping adds no child claim.
            directory.visit_entry_names_bounded(2, |entry| {
                ensure!(
                    entry == OsStr::new(RECORD),
                    "HISTORY_RELOCATION_DIRECTORY_NOT_EMPTY"
                );
                Ok(())
            })?;
            let removed = directory.portable_remove_verified_regular_leaf(
                OsStr::new(RECORD),
                &record.value.record_identity,
            )?;
            if let Some(error) = removed.failure {
                return Err(error);
            }
        }
        #[cfg(test)]
        ensure!(
            !INTERRUPT_DIRECTORY_REMOVAL.with(|pending| pending.replace(false)),
            "HISTORY_RELOCATION_TEST_DIRECTORY_REMOVAL_INTERRUPTED"
        );
        self.portable_remove_verified_empty_directory(name, &actual)
    }

    fn history_relocation_entry(&self, name: &OsStr) -> Result<bool> {
        if name != OsStr::new(RECORD) {
            return Ok(false);
        }
        read_record(self)?.context("HISTORY_RELOCATION_RECORD_MISSING")?;
        Ok(true)
    }
}
