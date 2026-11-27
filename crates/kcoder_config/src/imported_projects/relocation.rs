//! Offline conversion changes only the current writer lock pin, not business identity.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedProjectRelocationSnapshot {
    profile_identity: String,
    directory_identity: String,
    birth_identity: PortableLeaseIdentity,
    birth_sha256: String,
    state_identity: PortableLeaseIdentity,
    state_sha256: String,
    epoch: String,
    generation: u64,
    registry_sha256: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelocationReceipt {
    operation_id: String,
    source: ImportedProjectRelocationSnapshot,
}

pub(super) fn valid_birth(birth: &Birth) -> bool {
    match (birth.version, &birth.relocation) {
        (1, None) => true,
        (2, Some(receipt)) => {
            valid_operation(&receipt.operation_id)
                && receipt.source.profile_identity != birth.profile_identity
                && receipt.source.directory_identity != birth.directory_identity
                && receipt.source.epoch == birth.epoch
                && validation::sha(&receipt.source.birth_sha256)
                && validation::sha(&receipt.source.state_sha256)
                && receipt
                    .source
                    .registry_sha256
                    .as_ref()
                    .is_none_or(|value| validation::sha(value))
                && birth.stage == BirthStage::Sealed
        }
        _ => false,
    }
}

impl ImportedProjectAssociationsStore {
    /// A read-only preflight. Active associations require the original Native
    /// registry owner; removed receipts do not recreate a registry dependency.
    pub fn relocation_snapshot(
        &self,
        registry: Option<&ProjectWorkspaceRegistry>,
    ) -> Result<ImportedProjectRelocationSnapshot> {
        let _registry_lease = registry.map(ProjectWorkspaceRegistry::lock).transpose()?;
        let _lease = self.lock(PrivateLeaseMode::Shared)?;
        self.relocation_snapshot_locked(registry)
    }

    /// The caller owns the stopped same-account operation and has verified the
    /// complete copy at its final path. No external workspace or registry moves.
    pub fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedProjectRelocationSnapshot,
        registry: Option<&ProjectWorkspaceRegistry>,
    ) -> Result<Self> {
        self.relocation_target(final_target_profile, operation_id, expected, registry, true)
    }

    /// Verify the original operation's final owner binding without initializing
    /// missing data, changing generations, or replaying association operations.
    pub fn verify_relocation(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedProjectRelocationSnapshot,
        registry: Option<&ProjectWorkspaceRegistry>,
    ) -> Result<()> {
        self.relocation_target(
            final_target_profile,
            operation_id,
            expected,
            registry,
            false,
        )
        .map(|_| ())
    }

    fn relocation_snapshot_locked(
        &self,
        registry: Option<&ProjectWorkspaceRegistry>,
    ) -> Result<ImportedProjectRelocationSnapshot> {
        let state = self.read()?;
        ensure!(
            self.birth.stage == BirthStage::Sealed,
            "imported_project_relocation_birth_unknown"
        );
        if !state.records.is_empty() {
            let registry = registry
                .ok_or_else(|| anyhow::anyhow!("imported_project_relocation_registry_required"))?;
            registry.verify_relocation_records(&state.records)?;
            for record in state.records.values() {
                validation::target(&self.profile, &record.target)?;
            }
        }
        let birth = bytes(&self.directory, BIRTH, 32 * 1024)?;
        let data = bytes(&self.directory, STATE, MAX_BYTES)?;
        ensure!(
            serde_json::from_slice::<Birth>(&birth)? == self.birth
                && hash(&serde_json::from_slice::<State>(&data)?)? == hash(&state)?,
            "imported_project_relocation_source_changed"
        );
        Ok(ImportedProjectRelocationSnapshot {
            profile_identity: self.parent.directory_identity()?,
            directory_identity: self.directory.directory_identity()?,
            birth_identity: self
                .directory
                .portable_regular_identity(OsStr::new(BIRTH))?,
            birth_sha256: digest(&birth),
            state_identity: self
                .directory
                .portable_regular_identity(OsStr::new(STATE))?,
            state_sha256: digest(&data),
            epoch: state.epoch,
            generation: state.generation,
            registry_sha256: registry
                .map(ProjectWorkspaceRegistry::relocation_binding_sha256)
                .transpose()?,
        })
    }

    fn relocation_target(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedProjectRelocationSnapshot,
        registry: Option<&ProjectWorkspaceRegistry>,
        publish: bool,
    ) -> Result<Self> {
        ensure!(
            valid_operation(operation_id),
            "imported_project_invalid_owner"
        );
        let _registry_lease = registry.map(ProjectWorkspaceRegistry::lock).transpose()?;
        let _source_lease = self.lock(PrivateLeaseMode::Exclusive)?;
        ensure!(
            self.relocation_snapshot_locked(registry)? == *expected,
            "imported_project_relocation_source_changed"
        );
        let profile = dunce::canonicalize(final_target_profile)?;
        let parent = PrivateDirectory::open_existing(&profile)?;
        parent.verify_config_root_directory()?;
        ensure!(
            parent.directory_identity()? != expected.profile_identity,
            "imported_project_relocation_same_profile"
        );
        let directory = parent.open_child(OsStr::new(DIRECTORY), false)?;
        directory.verify_private_directory()?;
        let lock = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let lock_identity = directory.portable_regular_handle_identity(&lock)?;
        let _target_lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("imported_project_busy"))?;
        let source_birth = bytes(&self.directory, BIRTH, 32 * 1024)?;
        let source_state = bytes(&self.directory, STATE, MAX_BYTES)?;
        let original_birth = bytes(&directory, BIRTH, 32 * 1024)?;
        let original_birth_identity = directory.portable_regular_identity(OsStr::new(BIRTH))?;
        let mut birth = self.birth.clone();
        birth.lock_identity = lock_identity;
        let committed = serde_json::from_slice::<Birth>(&original_birth)? == birth;
        ensure!(
            committed || original_birth == source_birth,
            "imported_project_relocation_conflict"
        );
        ensure!(
            publish || committed,
            "imported_project_relocation_unconfirmed"
        );
        let verify = || -> Result<()> {
            ensure!(
                self.relocation_snapshot_locked(registry)? == *expected
                    && PrivateDirectory::open_existing(&profile)?.directory_identity()?
                        == parent.directory_identity()?
                    && parent
                        .open_child(OsStr::new(DIRECTORY), false)?
                        .directory_identity()?
                        == directory.directory_identity()?
                    && directory.portable_regular_identity(OsStr::new(LOCK))?
                        == birth.lock_identity
                    && bytes(&directory, STATE, MAX_BYTES)? == source_state
                    && bytes(&directory, LOCK, 32 * 1024)?
                        == bytes(&self.directory, LOCK, 32 * 1024)?,
                "imported_project_relocation_data_changed"
            );
            for record in self.read()?.records.values() {
                validation::target(&profile, &record.target)?;
            }
            Ok(())
        };
        verify()?;
        if !committed {
            let output = serde_json::to_vec(&birth)?;
            directory
                .atomic_publish_from_reader(OsStr::new(BIRTH), &mut output.as_slice(), true, || {
                    verify()?;
                    ensure!(
                        directory.portable_regular_identity(OsStr::new(BIRTH))?
                            == original_birth_identity
                            && bytes(&directory, BIRTH, 32 * 1024)? == original_birth,
                        "imported_project_relocation_conflict"
                    );
                    Ok(())
                })
                .map_err(|error| error.context("imported_project_relocation_unconfirmed"))?;
        }
        verify()?;
        let target = Self {
            profile,
            parent,
            directory,
            birth,
        };
        ensure!(
            bytes(&target.directory, BIRTH, 32 * 1024)? == serde_json::to_vec(&target.birth)?
                && target.read()?.generation == expected.generation,
            "imported_project_relocation_unconfirmed"
        );
        Ok(target)
    }
}

fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}

fn bytes(directory: &PrivateDirectory, name: &str, max: u64) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= max,
        "imported_project_budget_exceeded"
    );
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
