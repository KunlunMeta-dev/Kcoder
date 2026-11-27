//! One read page owns its verified index bytes, never a Native allow decision.
use super::*;
use std::sync::Arc;

pub struct WorkspaceAddressReader {
    profile_identity: String,
    index: Option<HeldDocument<AddressIndex>>,
}

impl WorkspaceAddressReader {
    pub(super) fn observe(profile: &PrivateDirectory) -> Result<Self> {
        let result = Self {
            profile_identity: profile.directory_identity()?,
            index: read_index(profile)?,
        };
        result.verify(profile)?;
        Ok(result)
    }

    /// Normal writes replace the index atomically. Detect named replacement,
    /// in-place changes, privacy/link changes and absence before using held data.
    /// Stale pages must restart observation; they never silently refresh midway.
    pub fn verify(&self, profile: &PrivateDirectory) -> Result<()> {
        let checked = (|| -> Result<()> {
            profile.verify_config_root_directory()?;
            ensure!(
                profile.directory_identity()? == self.profile_identity,
                "profile changed"
            );
            match &self.index {
                Some(index) => index.verify_named_stamp(profile, INDEX),
                None => match profile.entry_metadata(OsStr::new(INDEX)) {
                    Err(error) if storage::missing(&error) => Ok(()),
                    Err(error) => Err(error),
                    Ok(_) => anyhow::bail!("index appeared"),
                },
            }
        })();
        checked.context("WORKSPACE_IDENTITY_OBSERVATION_STALE")
    }

    /// Reuses the same held index for every row; only exact current workspace
    /// leaves are read. Old directories are never opened or scanned.
    pub fn lookup(
        self: &Arc<Self>,
        profile: &PrivateDirectory,
        address: &Path,
    ) -> Result<Option<WorkspaceAddressLookup>> {
        validate_path(address)?;
        self.verify(profile)?;
        let Some(binding) = self
            .index
            .as_ref()
            .and_then(|index| index.value.value.addresses.get(address))
        else {
            return Ok(None);
        };
        let identity = &binding.current_identity;
        let record =
            read_record(profile, identity)?.context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
        let path = record.value.value.workspace_path.clone();
        let workspace = PrivateDirectory::open_existing(&path)?;
        ensure!(
            workspace.directory_identity()? == *identity,
            "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
        );
        let location = WorkspaceLocation {
            requested: address.into(),
            source_identity: binding.source_identity.clone(),
            path: path.clone(),
            workspace,
            identity: WorkspaceIdentity::from_record(profile, identity.clone(), Some(record))?,
            observation: self.clone(),
        };
        location.verify(profile)?;
        Ok(Some(if address == path {
            WorkspaceAddressLookup::Current(location)
        } else {
            WorkspaceAddressLookup::Moved(location)
        }))
    }

    pub(super) fn verify_location(&self, path: &Path, current: &str, source: &str) -> Result<()> {
        ensure!(
            self.index
                .as_ref()
                .and_then(|index| index.value.value.addresses.get(path))
                .is_some_and(|binding| binding.current_identity == current
                    && binding.source_identity == source),
            "WORKSPACE_IDENTITY_ADDRESS_CHANGED"
        );
        Ok(())
    }
}
