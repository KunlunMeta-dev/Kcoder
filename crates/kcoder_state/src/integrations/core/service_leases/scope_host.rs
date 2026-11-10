//! One infrastructure kernel slot per original service namespace, across owned runtimes.
//! Launch metadata never grants foreground, background, member or tool permission.
use super::*;
use kcoder_types::integrations::core::NativeScopeHostLaunchSpec;

pub(super) const HOST_SLOT: &str = "channel-host-owner.lock";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostLaunch {
    specification: NativeScopeHostLaunchSpec,
    first_operation_id: String,
    owner_lock_identity: PortableLeaseIdentity,
}
fn host_name(id: &str) -> Result<String> {
    ensure!(
        id.len() == 64
            && id
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)),
        "CHANNEL_HOST_LAUNCH_REFERENCE_INVALID"
    );
    Ok(format!("channel-host-launch-{id}.json"))
}
impl IntegrationServiceLeaseStore {
    pub fn list_scope_hosts(&self) -> Result<Vec<(String, NativeScopeHostLaunchSpec)>> {
        self.verify()?;
        let mut hosts = Vec::new();
        self.directory.visit_entry_names_bounded(1024, |name| {
            let Some(name) = name.to_str() else {
                return Ok(());
            };
            if let Some(id) = name
                .strip_prefix("channel-host-launch-")
                .and_then(|name| name.strip_suffix(".json"))
            {
                ensure!(hosts.len() < MAX_LEASES, "CHANNEL_HOST_LAUNCH_CAPACITY");
                let launch = self
                    .read_scope_host(id)?
                    .context("CHANNEL_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
                hosts.push((id.into(), launch));
            }
            Ok(())
        })?;
        self.verify()?;
        Ok(hosts)
    }
    /// Called only for a captured explicit Native management operation. Readers
    /// and background source labels cannot create the slot or repair a partial one.
    pub fn prepare_scope_host(
        &self,
        specification: &NativeScopeHostLaunchSpec,
        operation_id: &str,
    ) -> Result<String> {
        specification.validate()?;
        super::names(operation_id)?;
        ensure!(
            IntegrationOwner::from(&specification.scope) == self.header.owner,
            "CHANNEL_HOST_LAUNCH_OWNER_MISMATCH"
        );
        let id = format!("{:x}", Sha256::digest(serde_json::to_vec(specification)?));
        let name = host_name(&id)?;
        let _writer = self.writer()?;
        if let Some(existing) = self.read_scope_host(&id)? {
            ensure!(
                &existing == specification,
                "CHANNEL_HOST_ORIGINAL_LAUNCH_CHANGED"
            );
            return Ok(id);
        }
        ensure!(
            self.directory.count_regular_files_bounded(
                |name| name.to_str().is_some_and(
                    |name| name.starts_with("channel-host-launch-") && name.ends_with(".json")
                ),
                MAX_LEASES + 1
            )? < MAX_LEASES,
            "CHANNEL_HOST_LAUNCH_CAPACITY"
        );
        let anchor = self.prepare_original_host_slot()?;
        let record = HostLaunch {
            specification: specification.clone(),
            first_operation_id: operation_id.into(),
            owner_lock_identity: self.directory.portable_regular_handle_identity(&anchor)?,
        };
        let bytes = serde_json::to_vec(&record)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES,
            "CHANNEL_HOST_LAUNCH_TOO_LARGE"
        );
        self.directory.atomic_replace(OsStr::new(&name), &bytes)?;
        self.verify()?;
        Ok(id)
    }
    /// Both legacy migration owners and the persistent app-server use this
    /// exact slot. A new launch format must never permit a second task Core.
    pub(super) fn prepare_original_host_slot(&self) -> Result<File> {
        let mut original = self.app_server_host_slot_identity()?;
        if let Some(gateway) = self.gateway_app_server_slot_identity()? {
            ensure!(
                original
                    .as_ref()
                    .is_none_or(|identity| identity == &gateway),
                "CHANNEL_HOST_ORIGINAL_SLOT_REQUIRED"
            );
            original = Some(gateway);
        }
        self.directory.visit_entry_names_bounded(1024, |name| {
            if name.to_str().is_some_and(|name| {
                name.starts_with("channel-host-launch-") && name.ends_with(".json")
            }) {
                let record: HostLaunch =
                    serde_json::from_slice(&read(&self.directory, name.to_str().unwrap())?)?;
                record.specification.validate()?;
                ensure!(
                    IntegrationOwner::from(&record.specification.scope) == self.header.owner,
                    "CHANNEL_HOST_LAUNCH_OWNER_MISMATCH"
                );
                if let Some(original) = &original {
                    ensure!(
                        original == &record.owner_lock_identity,
                        "CHANNEL_HOST_ORIGINAL_SLOT_REQUIRED"
                    );
                } else {
                    original = Some(record.owner_lock_identity);
                }
            }
            Ok(())
        })?;
        match self
            .directory
            .open_single_link_regular_file(OsStr::new(HOST_SLOT))
        {
            Ok(anchor) => {
                // A shared slot is accepted only through an existing immutable
                // preparation, never merely because an orphan file exists.
                ensure!(
                    original.as_ref()
                        == Some(&self.directory.portable_regular_handle_identity(&anchor)?),
                    "CHANNEL_HOST_ORIGINAL_SLOT_REQUIRED"
                );
                Ok(anchor)
            }
            Err(error) if missing(&error) => {
                ensure!(original.is_none(), "CHANNEL_HOST_ORIGINAL_SLOT_REQUIRED");
                self.directory
                    .open_read_write_file(OsStr::new(HOST_SLOT), true)
            }
            Err(error) => Err(error),
        }
    }
    pub fn read_scope_host(&self, id: &str) -> Result<Option<NativeScopeHostLaunchSpec>> {
        self.verify()?;
        let name = host_name(id)?;
        let record = match self
            .directory
            .open_single_link_regular_file(OsStr::new(&name))
        {
            Ok(file) => serde_json::from_slice::<HostLaunch>(&read_file(file)?)?,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        record.specification.validate()?;
        ensure!(
            IntegrationOwner::from(&record.specification.scope) == self.header.owner
                && format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&record.specification)?)
                ) == id
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(HOST_SLOT))?
                    == record.owner_lock_identity,
            "CHANNEL_HOST_ORIGINAL_LAUNCH_CHANGED"
        );
        self.verify()?;
        Ok(Some(record.specification))
    }
    pub fn try_claim_scope_host(&self, id: &str) -> Result<Option<VerifiedPrivateLease>> {
        self.read_scope_host(id)?
            .context("CHANNEL_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        let name = host_name(id)?;
        let record: HostLaunch = serde_json::from_slice(&read(&self.directory, &name)?)?;
        self.directory.try_existing_portable_lock(
            OsStr::new(HOST_SLOT),
            &record.owner_lock_identity,
            PrivateLeaseMode::Exclusive,
        )
    }
    /// The actual inherited descriptor must name the original single scope
    /// slot. Serialized paths, PIDs and "Running" observations cannot replace it.
    pub fn verify_scope_host_descriptor(&self, id: &str, descriptor: &File) -> Result<()> {
        self.read_scope_host(id)?
            .context("CHANNEL_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        let record: HostLaunch = serde_json::from_slice(&read(&self.directory, &host_name(id)?)?)?;
        ensure!(
            self.directory
                .portable_regular_handle_identity(descriptor)?
                == record.owner_lock_identity,
            "CHANNEL_HOST_ORIGINAL_DESCRIPTOR_REQUIRED"
        );
        self.verify()
    }
}

#[cfg(test)]
mod tests;
