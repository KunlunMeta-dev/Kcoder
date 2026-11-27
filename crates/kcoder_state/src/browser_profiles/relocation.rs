//! Offline copy preserves logical records and converts only the writer lock pin.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfileRelocationSnapshot {
    owner: IntegrationOwner,
    parent_identity: String,
    directory_identity: String,
    header_identity: PortableLeaseIdentity,
    header_sha256: String,
    data_identity: PortableLeaseIdentity,
    data_sha256: String,
    revision: u64,
    data_directories: BTreeMap<String, String>,
}

pub struct PreparedBrowserProfileRelocation<'a> {
    owner: &'a BrowserProfileStore,
    snapshot: BrowserProfileRelocationSnapshot,
    _lease: VerifiedPrivateLease,
}
impl PreparedBrowserProfileRelocation<'_> {
    pub fn snapshot(&self) -> &BrowserProfileRelocationSnapshot {
        &self.snapshot
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.owner.relocation_snapshot_locked()? == self.snapshot,
            "BROWSER_PROFILE_RELOCATION_SOURCE_CHANGED"
        );
        Ok(())
    }
    pub fn relocate(
        self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<BrowserProfileStore> {
        self.verify()?;
        self.owner
            .relocation_target_locked(final_target_parent, operation_id, &self.snapshot, true)
    }
    pub fn verify_relocation(
        self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<()> {
        self.verify()?;
        self.owner
            .relocation_target_locked(final_target_parent, operation_id, &self.snapshot, false)
            .map(|_| ())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelocatedDirectory {
    recorded_identity: String,
    target_identity: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelocationReceipt {
    operation_id: String,
    source: BrowserProfileRelocationSnapshot,
    data_directories: BTreeMap<String, RelocatedDirectory>,
}

pub(super) fn valid_header(header: &Header) -> bool {
    match (header.version, &header.relocation) {
        (1, None) => true,
        (2, Some(receipt)) => {
            valid_operation(&receipt.operation_id)
                && receipt.source.owner == header.owner
                && receipt.source.directory_identity != header.directory
                && receipt.source.revision > 0
                && sha(&receipt.source.header_sha256)
                && sha(&receipt.source.data_sha256)
                && receipt.data_directories.len() <= 128
                && receipt
                    .data_directories
                    .keys()
                    .eq(receipt.source.data_directories.keys())
                && receipt.data_directories.values().all(|binding| {
                    !binding.recorded_identity.is_empty() && !binding.target_identity.is_empty()
                })
        }
        _ => false,
    }
}

impl BrowserProfileStore {
    /// Retain the catalog's real writer exclusion across inventory and copy.
    pub fn prepare_relocation(&self) -> Result<PreparedBrowserProfileRelocation<'_>> {
        let lease = self.lease(true)?;
        let snapshot = self.relocation_snapshot_locked()?;
        Ok(PreparedBrowserProfileRelocation {
            owner: self,
            snapshot,
            _lease: lease,
        })
    }
    /// Read-only preflight. The host must first settle every browser use through
    /// its existing owned cleanup path; partial or missing receipts remain busy.
    pub fn relocation_snapshot(&self) -> Result<BrowserProfileRelocationSnapshot> {
        let _lease = self.lease(false)?;
        self.relocation_snapshot_locked()
    }

    /// Called only by the stopped same-account owner after the full copy has
    /// been verified at the final target. The logical owner and data are retained.
    pub fn relocate(
        &self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
        expected: &BrowserProfileRelocationSnapshot,
    ) -> Result<Self> {
        self.relocation_target(final_target_parent, operation_id, expected, true)
    }

    /// Observe this exact operation's destination without creating a catalog,
    /// releasing uses, rewriting business state, or replaying a browser launch.
    pub fn verify_relocation(
        &self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
        expected: &BrowserProfileRelocationSnapshot,
    ) -> Result<()> {
        self.relocation_target(final_target_parent, operation_id, expected, false)
            .map(|_| ())
    }

    fn relocation_snapshot_locked(&self) -> Result<BrowserProfileRelocationSnapshot> {
        self.verify()?;
        let data = self.read_data()?;
        ensure!(
            data.active_uses.is_empty(),
            "BROWSER_PROFILE_RELOCATION_ACTIVE_USE"
        );
        let mut data_directories = BTreeMap::new();
        for id in data.data_directories.keys() {
            let directory = cookie_directory(&self.directory, id)?;
            let identity = directory.directory_identity()?;
            data_directories.insert(id.clone(), identity);
        }
        let header_bytes = read(&self.directory, HEADER, MAX_BYTES)?;
        let data_bytes = read(&self.directory, DATA, MAX_BYTES)?;
        ensure!(
            serde_json::from_slice::<Header>(&header_bytes)? == self.header
                && hash(&serde_json::from_slice::<Data>(&data_bytes)?)? == hash(&data)?,
            "BROWSER_PROFILE_RELOCATION_SOURCE_CHANGED"
        );
        let snapshot = BrowserProfileRelocationSnapshot {
            owner: self.header.owner.clone(),
            parent_identity: self.parent.directory_identity()?,
            directory_identity: self.directory.directory_identity()?,
            header_identity: self.header_identity.clone(),
            header_sha256: digest(&header_bytes),
            data_identity: self.directory.portable_regular_identity(OsStr::new(DATA))?,
            data_sha256: digest(&data_bytes),
            revision: data.revision,
            data_directories,
        };
        self.verify()?;
        Ok(snapshot)
    }

    fn relocation_target(
        &self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
        expected: &BrowserProfileRelocationSnapshot,
        publish: bool,
    ) -> Result<Self> {
        let _source_lease = self.lease(true)?;
        self.relocation_target_locked(final_target_parent, operation_id, expected, publish)
    }

    fn relocation_target_locked(
        &self,
        final_target_parent: &PrivateDirectory,
        operation_id: &str,
        expected: &BrowserProfileRelocationSnapshot,
        publish: bool,
    ) -> Result<Self> {
        ensure!(
            valid_operation(operation_id),
            "BROWSER_PROFILE_OPERATION_INVALID"
        );
        ensure!(
            self.relocation_snapshot_locked()? == *expected,
            "BROWSER_PROFILE_RELOCATION_SOURCE_CHANGED"
        );
        final_target_parent.verify_private_directory()?;
        let target = final_target_parent
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        target.verify_private_directory()?;
        ensure!(
            final_target_parent.directory_identity()? != expected.parent_identity
                && target.directory_identity()? != expected.directory_identity,
            "BROWSER_PROFILE_RELOCATION_SAME_NAMESPACE"
        );
        let lock_anchor = target.open_single_link_regular_file(OsStr::new(LOCK))?;
        let lock_identity = target.portable_regular_handle_identity(&lock_anchor)?;
        let _target_lease = target
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("BROWSER_PROFILE_BUSY")?;
        let source_header = read(&self.directory, HEADER, MAX_BYTES)?;
        let source_data = read(&self.directory, DATA, MAX_BYTES)?;
        let original_header = read(&target, HEADER, MAX_BYTES)?;
        let original_header_identity = target.portable_regular_identity(OsStr::new(HEADER))?;
        let data = self.read_data()?;
        let mut cookie_handles = BTreeMap::new();
        for id in data.data_directories.keys() {
            cookie_handles.insert(id, cookie_directory(&target, id)?);
        }
        let mut header = self.header.clone();
        header.lock = lock_identity;
        let committed = serde_json::from_slice::<Header>(&original_header)? == header;
        ensure!(
            committed || original_header == source_header,
            "BROWSER_PROFILE_RELOCATION_CONFLICT"
        );
        ensure!(
            publish || committed,
            "BROWSER_PROFILE_RELOCATION_UNCONFIRMED"
        );
        let verify = || -> Result<()> {
            ensure!(
                self.relocation_snapshot_locked()? == *expected
                    && final_target_parent
                        .open_entry_handle(&self.name)?
                        .open_child_directory()?
                        .directory_identity()?
                        == target.directory_identity()?
                    && target.portable_regular_identity(OsStr::new(LOCK))? == header.lock
                    && read(&target, DATA, MAX_BYTES)? == source_data
                    && read(&target, LOCK, 8192)? == read(&self.directory, LOCK, 8192)?,
                "BROWSER_PROFILE_RELOCATION_DATA_CHANGED"
            );
            for (id, handle) in &cookie_handles {
                ensure!(
                    cookie_directory(&target, id)?.directory_identity()?
                        == handle.directory_identity()?,
                    "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
                );
            }
            Ok(())
        };
        verify()?;
        if !committed {
            let output = serde_json::to_vec(&header)?;
            ensure!(
                output.len() as u64 <= MAX_BYTES,
                "BROWSER_PROFILE_DATA_LIMIT"
            );
            target
                .atomic_publish_from_reader(
                    OsStr::new(HEADER),
                    &mut output.as_slice(),
                    true,
                    || {
                        verify()?;
                        ensure!(
                            target.portable_regular_identity(OsStr::new(HEADER))?
                                == original_header_identity
                                && read(&target, HEADER, MAX_BYTES)? == original_header,
                            "BROWSER_PROFILE_RELOCATION_CONFLICT"
                        );
                        Ok(())
                    },
                )
                .map_err(|error| error.context("BROWSER_PROFILE_RELOCATION_UNCONFIRMED"))?;
        }
        verify()?;
        let header_anchor = target.open_single_link_regular_file(OsStr::new(HEADER))?;
        let header_identity = target.portable_regular_handle_identity(&header_anchor)?;
        let result = Self {
            parent: final_target_parent.duplicate_handle()?,
            name: self.name.clone(),
            directory: target,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
        };
        result.verify()?;
        ensure!(
            result.read_data()?.revision == expected.revision,
            "BROWSER_PROFILE_RELOCATION_UNCONFIRMED"
        );
        Ok(result)
    }
}

fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}

fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
