//! Infrastructure selection only. Original sessions and authorization remain
//! in their existing stores, and all host generations share the legacy fence.
use super::*;
use kcoder_types::integrations::core::{AppServerHostLaunchSpec, AppServerHostSelection};

const JOURNAL: &str = "app-server-host.v1.json";
const GATEWAY_SLOT: &str = "gateway-app-server-slot.v1.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GatewaySlot {
    owner: IntegrationOwner,
    identity: PortableLeaseIdentity,
}
const MAX_CHANGES: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Launch {
    reference: String,
    specification: AppServerHostLaunchSpec,
    profile_identity: String,
    workspace_identity: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    operation_id: String,
    expected_revision: Option<u64>,
    selection: AppServerHostSelection,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    schema_version: u32,
    owner: IntegrationOwner,
    owner_lock_identity: PortableLeaseIdentity,
    launches: Vec<Launch>,
    changes: Vec<Change>,
}

impl IntegrationServiceLeaseStore {
    /// The authenticated first-party launcher calls this after verifying its
    /// target identity. This grants no background, channel, tool or task rights.
    /// Selection never claims a live owner's slot or stops its in-flight input.
    pub fn select_app_server_host(
        &self,
        specification: &AppServerHostLaunchSpec,
        enabled: bool,
        expected_revision: Option<u64>,
        operation_id: &str,
    ) -> Result<AppServerHostSelection> {
        specification.validate()?;
        names(operation_id)?;
        ensure!(
            specification.identity.owner == self.header.owner,
            "APP_SERVER_HOST_OWNER_MISMATCH"
        );
        let _writer = self.writer()?;
        let mut journal = self.read_app_server_host_journal()?;
        let reference = reference(specification)?;
        if let Some(old) = journal
            .as_ref()
            .and_then(|j| j.changes.iter().find(|c| c.operation_id == operation_id))
        {
            ensure!(
                old.selection.launch_ref == reference
                    && old.selection.enabled == enabled
                    && old.expected_revision == expected_revision,
                "APP_SERVER_HOST_OPERATION_CONFLICT"
            );
            return Ok(old.selection.clone());
        }
        let current = journal.as_ref().and_then(|j| j.changes.last());
        ensure!(
            current.map(|c| c.selection.revision) == expected_revision,
            "APP_SERVER_HOST_REVISION_CONFLICT"
        );
        let next = current
            .map_or(0, |c| c.selection.revision)
            .checked_add(1)
            .context("APP_SERVER_HOST_REVISION_OVERFLOW")?;
        let launch = capture(specification)?;
        let anchor = self.prepare_original_host_slot()?;
        let owner_lock_identity = self.directory.portable_regular_handle_identity(&anchor)?;
        // An upgrade cannot invalidate a still-running app-server's selected
        // image and thereby interrupt unknown in-flight work. The original
        // owner must first settle its input and release the shared scope fence.
        let _upgrade_boundary = if current
            .is_none_or(|c| c.selection.launch_ref != reference || !c.selection.enabled)
        {
            Some(
                self.directory
                    .try_existing_portable_lock(
                        OsStr::new(scope_host::HOST_SLOT),
                        &owner_lock_identity,
                        PrivateLeaseMode::Exclusive,
                    )?
                    .context("APP_SERVER_HOST_ORIGINAL_OWNER_BUSY")?,
            )
        } else {
            None
        };
        let journal = journal.get_or_insert_with(|| Journal {
            schema_version: 1,
            owner: self.header.owner.clone(),
            owner_lock_identity,
            launches: Vec::new(),
            changes: Vec::new(),
        });
        ensure!(
            journal.changes.len() < MAX_CHANGES,
            "APP_SERVER_HOST_CHANGE_CAPACITY"
        );
        if !journal.launches.iter().any(|l| l.reference == reference) {
            journal.launches.push(launch);
        }
        let selection = AppServerHostSelection {
            revision: next,
            launch_ref: reference,
            enabled,
        };
        journal.changes.push(Change {
            operation_id: operation_id.into(),
            expected_revision,
            selection: selection.clone(),
        });
        let bytes = serde_json::to_vec(journal)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES,
            "APP_SERVER_HOST_JOURNAL_TOO_LARGE"
        );
        self.directory.atomic_replace(OsStr::new(JOURNAL), &bytes)?;
        self.verify()?;
        Ok(selection)
    }

    /// Read-only recovery does not create a host or interpret selection as
    /// execution consent. Unknown input receipts are not touched here.
    pub fn current_app_server_host(
        &self,
    ) -> Result<Option<(AppServerHostSelection, AppServerHostLaunchSpec)>> {
        let Some(journal) = self.read_app_server_host_journal()? else {
            return Ok(None);
        };
        let Some(last) = journal.changes.last() else {
            anyhow::bail!("APP_SERVER_HOST_JOURNAL_INCOMPLETE")
        };
        let launch = journal
            .launches
            .iter()
            .find(|l| l.reference == last.selection.launch_ref)
            .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        Ok(Some((last.selection.clone(), launch.specification.clone())))
    }

    /// Bounded original infrastructure revisions for upgrade reconciliation and
    /// rollback. These records confer no task, platform or execution authority.
    pub fn app_server_host_selections(
        &self,
    ) -> Result<Vec<(AppServerHostSelection, AppServerHostLaunchSpec)>> {
        let Some(journal) = self.read_app_server_host_journal()? else {
            return Ok(Vec::new());
        };
        journal
            .changes
            .iter()
            .map(|change| {
                let launch = journal
                    .launches
                    .iter()
                    .find(|launch| launch.reference == change.selection.launch_ref)
                    .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
                Ok((change.selection.clone(), launch.specification.clone()))
            })
            .collect()
    }

    /// Claim the original fence without changing the recorded service selection.
    pub fn try_claim_gateway_app_server(&self) -> Result<Option<VerifiedPrivateLease>> {
        let _writer = self.writer()?;
        let file = self.prepare_original_host_slot()?;
        let identity = self.directory.portable_regular_handle_identity(&file)?;
        let Some(lease) = self.directory.try_existing_portable_lock(
            OsStr::new(scope_host::HOST_SLOT),
            &identity,
            PrivateLeaseMode::Exclusive,
        )?
        else {
            return Ok(None);
        };
        if self.gateway_app_server_slot_identity()?.is_none() {
            let locator = GatewaySlot {
                owner: self.header.owner.clone(),
                identity,
            };
            self.directory
                .atomic_replace(OsStr::new(GATEWAY_SLOT), &serde_json::to_vec(&locator)?)?;
        }
        Ok(Some(lease))
    }

    /// Ordinary stdio peers share the original slot and exclude a live legacy host.
    /// A fresh profile needs no legacy slot, and recovery never rewrites the journal.
    pub fn guard_stdio_against_legacy_host(&self) -> Result<Option<VerifiedPrivateLease>> {
        let Some(identity) = self.app_server_host_slot_identity()? else {
            return Ok(None);
        };
        let lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(scope_host::HOST_SLOT),
                &identity,
                PrivateLeaseMode::Shared,
            )?
            .context("APP_SERVER_HOST_ORIGINAL_OWNER_BUSY")?;
        Ok(Some(lease))
    }

    pub(super) fn gateway_app_server_slot_identity(&self) -> Result<Option<PortableLeaseIdentity>> {
        let record = match self
            .directory
            .open_single_link_regular_file(OsStr::new(GATEWAY_SLOT))
        {
            Ok(file) => serde_json::from_slice::<GatewaySlot>(&read_file(file)?)?,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            record.owner == self.header.owner,
            "APP_SERVER_HOST_OWNER_MISMATCH"
        );
        Ok(Some(record.identity))
    }

    pub fn verify_gateway_app_server_descriptor(&self, descriptor: &File) -> Result<()> {
        let slot = self
            .directory
            .portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?;
        ensure!(
            self.directory
                .portable_regular_handle_identity(descriptor)?
                == slot
                && self.gateway_app_server_slot_identity()?.as_ref() == Some(&slot)
                && self
                    .app_server_host_slot_identity()?
                    .is_none_or(|original| original == slot),
            "APP_SERVER_HOST_ORIGINAL_DESCRIPTOR_REQUIRED"
        );
        self.verify()
    }

    pub fn try_claim_app_server_host(
        &self,
        selection: &AppServerHostSelection,
    ) -> Result<Option<VerifiedPrivateLease>> {
        let (current, _) = self
            .current_app_server_host()?
            .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        ensure!(
            &current == selection && current.enabled,
            "APP_SERVER_HOST_SELECTION_CHANGED"
        );
        let identity = self
            .app_server_host_slot_identity()?
            .context("APP_SERVER_HOST_ORIGINAL_SLOT_REQUIRED")?;
        self.directory.try_existing_portable_lock(
            OsStr::new(scope_host::HOST_SLOT),
            &identity,
            PrivateLeaseMode::Exclusive,
        )
    }

    pub fn verify_app_server_host_descriptor(
        &self,
        selection: &AppServerHostSelection,
        descriptor: &File,
    ) -> Result<()> {
        let (current, _) = self
            .current_app_server_host()?
            .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        ensure!(
            &current == selection && current.enabled,
            "APP_SERVER_HOST_SELECTION_CHANGED"
        );
        ensure!(
            self.app_server_host_slot_identity()?.as_ref()
                == Some(
                    &self
                        .directory
                        .portable_regular_handle_identity(descriptor)?
                ),
            "APP_SERVER_HOST_ORIGINAL_DESCRIPTOR_REQUIRED"
        );
        self.verify()
    }

    pub(super) fn app_server_host_slot_identity(&self) -> Result<Option<PortableLeaseIdentity>> {
        Ok(self
            .read_app_server_host_journal()?
            .map(|j| j.owner_lock_identity))
    }

    fn read_app_server_host_journal(&self) -> Result<Option<Journal>> {
        self.verify()?;
        let bytes = match self
            .directory
            .open_single_link_regular_file(OsStr::new(JOURNAL))
        {
            Ok(file) => read_file(file)?,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut cached = self
            .host_journal
            .lock()
            .map_err(|_| anyhow::anyhow!("APP_SERVER_HOST_CACHE_UNAVAILABLE"))?;
        if let Some((previous, journal)) = &*cached
            && previous == &bytes
        {
            // The current selection and roots remain live facts. Historical
            // launches need not reopen their directories on every lookup.
            self.verify_selected_host_roots(journal)?;
            self.verify()?;
            return Ok(Some(journal.clone()));
        }
        let journal: Journal = serde_json::from_slice(&bytes)?;
        ensure!(
            journal.schema_version == 1
                && journal.owner == self.header.owner
                && !journal.changes.is_empty()
                && journal.changes.len() <= MAX_CHANGES
                && journal.launches.len() <= MAX_CHANGES
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?
                    == journal.owner_lock_identity,
            "APP_SERVER_HOST_JOURNAL_CHANGED"
        );
        let mut references = std::collections::BTreeSet::new();
        for launch in &journal.launches {
            let captured = capture(&launch.specification)?;
            ensure!(
                launch.specification.identity.owner == self.header.owner
                    && captured.reference == launch.reference
                    && captured.profile_identity == launch.profile_identity
                    && captured.workspace_identity == launch.workspace_identity
                    && references.insert(&launch.reference),
                "APP_SERVER_HOST_ORIGINAL_ROOTS_CHANGED"
            );
        }
        let mut operations = std::collections::BTreeSet::new();
        for (index, change) in journal.changes.iter().enumerate() {
            names(&change.operation_id)?;
            ensure!(
                change.selection.revision == index as u64 + 1
                    && change.expected_revision == (index != 0).then_some(index as u64)
                    && references.contains(&change.selection.launch_ref)
                    && operations.insert(&change.operation_id),
                "APP_SERVER_HOST_JOURNAL_CHANGED"
            );
        }
        self.verify()?;
        *cached = Some((bytes, journal.clone()));
        Ok(Some(journal))
    }

    fn verify_selected_host_roots(&self, journal: &Journal) -> Result<()> {
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new(scope_host::HOST_SLOT))?
                == journal.owner_lock_identity,
            "APP_SERVER_HOST_JOURNAL_CHANGED"
        );
        let selected = journal
            .changes
            .last()
            .context("APP_SERVER_HOST_JOURNAL_INCOMPLETE")?;
        let launch = journal
            .launches
            .iter()
            .find(|launch| launch.reference == selected.selection.launch_ref)
            .context("APP_SERVER_HOST_ORIGINAL_LAUNCH_REQUIRED")?;
        let current = capture(&launch.specification)?;
        ensure!(
            current.reference == launch.reference
                && current.profile_identity == launch.profile_identity
                && current.workspace_identity == launch.workspace_identity,
            "APP_SERVER_HOST_ORIGINAL_ROOTS_CHANGED"
        );
        Ok(())
    }
}

fn reference(specification: &AppServerHostLaunchSpec) -> Result<String> {
    specification.validate()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(specification)?)
    ))
}

fn capture(specification: &AppServerHostLaunchSpec) -> Result<Launch> {
    specification.validate()?;
    let profile = PrivateDirectory::open_existing(&specification.profile_path)?;
    profile.verify_private_directory()?;
    let workspace = PrivateDirectory::open_existing(&specification.workspace_path)?;
    Ok(Launch {
        reference: reference(specification)?,
        specification: specification.clone(),
        profile_identity: profile.directory_identity()?,
        workspace_identity: workspace.directory_identity()?,
    })
}

#[cfg(test)]
mod tests;
