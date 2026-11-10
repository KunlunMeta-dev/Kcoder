use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::{
    browser_profiles::*,
    integrations::core::{IntegrationOwner, IntegrationScope},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
};

const HEADER: &str = "profile-owner.json";
const LOCK: &str = "profiles.lock";
const DATA: &str = "profiles.json";
const MAX_BYTES: u64 = 512 * 1024;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    directory: String,
    lock: PortableLeaseIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    intent: String,
    result: BrowserAccountProfile,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u32,
    owner: IntegrationOwner,
    revision: u64,
    profiles: BTreeMap<String, BrowserAccountProfile>,
    operations: BTreeMap<String, Receipt>,
    #[serde(default)]
    active_uses: BTreeMap<String, ActiveUse>,
    #[serde(default)]
    data_directories: BTreeMap<String, String>,
    #[serde(default)]
    use_operations: BTreeMap<String, UseOperation>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UseOperation {
    profile_id: String,
    intent_sha256: String,
    use_id: String,
    released: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveUse {
    use_id: String,
    profile_revision: u64,
    #[serde(default)]
    cleanup_receipt: Option<PortableLeaseIdentity>,
}

/// An in-memory host handle. Dropping it never claims browser cleanup or clears use.
/// The host must retain this handle until its owned browser tree has terminated.
pub struct BrowserProfileUse {
    owner: IntegrationOwner,
    directory: String,
    profile_id: String,
    use_id: String,
    operation_id: Option<String>,
}

fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= limit,
        "BROWSER_PROFILE_DATA_LIMIT"
    );
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "BROWSER_PROFILE_DATA_LIMIT");
    Ok(bytes)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn operation(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "BROWSER_PROFILE_OPERATION_INVALID"
    );
    Ok(())
}
pub struct BrowserProfileStore {
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
}
impl BrowserProfileStore {
    /// Authorized first write only. No browser process or Cookie store is created.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            version: 1,
            owner: scope.into(),
            directory: directory.directory_identity()?,
            lock: directory.portable_regular_handle_identity(&lock)?,
        };
        let data = Data {
            version: 1,
            owner: header.owner.clone(),
            revision: 1,
            profiles: BTreeMap::new(),
            operations: BTreeMap::new(),
            active_uses: BTreeMap::new(),
            data_directories: BTreeMap::new(),
            use_operations: BTreeMap::new(),
        };
        directory.atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        Self::bind(parent, name, directory, scope)
    }
    /// Observe only. Existing damage never becomes an empty namespace.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Self::bind(parent, name, entry.open_child_directory()?, scope).map(Some)
    }
    fn bind(
        parent: &PrivateDirectory,
        name: &OsStr,
        directory: PrivateDirectory,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        let header: Header = serde_json::from_slice(&read(&directory, HEADER, 8192)?)?;
        ensure!(
            header.owner == IntegrationOwner::from(scope),
            "BROWSER_PROFILE_OWNER_MISMATCH"
        );
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let header_identity = directory.portable_regular_handle_identity(&header_anchor)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.to_owned(),
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
        };
        store.access(false, |_| Ok(()))?;
        Ok(store)
    }
    fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        let actual = self
            .parent
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        let header: Header = serde_json::from_slice(&read(&self.directory, HEADER, 8192)?)?;
        ensure!(
            header == self.header
                && header.version == 1
                && actual.directory_identity()? == header.directory
                && self.directory.directory_identity()? == header.directory
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(HEADER))?
                    == self.header_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.header_anchor)?
                    == self.header_identity
                && self.directory.portable_regular_identity(OsStr::new(LOCK))? == header.lock
                && self
                    .directory
                    .portable_regular_handle_identity(&self.lock_anchor)?
                    == header.lock,
            "BROWSER_PROFILE_NAMESPACE_CHANGED"
        );
        Ok(())
    }
    fn lease(&self, write: bool) -> Result<VerifiedPrivateLease> {
        let start = std::time::Instant::now();
        loop {
            self.verify()?;
            if let Some(lease) = self.directory.try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.header.lock,
                if write {
                    PrivateLeaseMode::Exclusive
                } else {
                    PrivateLeaseMode::Shared
                },
            )? {
                self.verify()?;
                return Ok(lease);
            }
            ensure!(
                !write && start.elapsed() < std::time::Duration::from_millis(250),
                "BROWSER_PROFILE_BUSY"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    fn access<T>(&self, write: bool, action: impl FnOnce(&mut Data) -> Result<T>) -> Result<T> {
        let _lease = self.lease(write)?;
        let mut data: Data = serde_json::from_slice(&read(&self.directory, DATA, MAX_BYTES)?)?;
        ensure!(
            data.version == 1
                && data.owner == self.header.owner
                && data.revision > 0
                && data.profiles.len() <= 128
                && data.operations.len() <= 4096
                && data.active_uses.len() <= 128,
            "BROWSER_PROFILE_DATA_INVALID"
        );
        ensure!(
            data.data_directories.len() <= 128
                && data
                    .data_directories
                    .keys()
                    .all(|id| data.profiles.contains_key(id)),
            "BROWSER_PROFILE_DATA_INVALID"
        );
        ensure!(
            data.use_operations.len() <= 4096,
            "BROWSER_PROFILE_OPERATION_LIMIT"
        );
        for (id, usage) in &data.use_operations {
            operation(id)?;
            operation(&usage.use_id)?;
            ensure!(
                data.profiles.contains_key(&usage.profile_id)
                    && usage.intent_sha256.len() == 64
                    && usage.intent_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "BROWSER_PROFILE_DATA_INVALID"
            );
            ensure!(
                usage.released
                    || data
                        .active_uses
                        .get(&usage.profile_id)
                        .is_some_and(|active| active.use_id == usage.use_id),
                "BROWSER_PROFILE_USE_INVALID"
            );
        }
        for (id, p) in &data.profiles {
            p.draft.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                *id == p.draft.id && p.revision > 0,
                "BROWSER_PROFILE_DATA_INVALID"
            );
        }
        for (id, receipt) in &data.operations {
            operation(id)?;
            receipt
                .result
                .draft
                .validate()
                .map_err(anyhow::Error::msg)?;
            ensure!(
                receipt.intent.len() == 64
                    && receipt.intent.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && receipt.result.revision > 0
                    && data
                        .profiles
                        .get(&receipt.result.draft.id)
                        .is_some_and(|profile| { receipt.result.revision <= profile.revision }),
                "BROWSER_PROFILE_RECEIPT_INVALID"
            );
        }
        for (id, usage) in &data.active_uses {
            operation(&usage.use_id)?;
            ensure!(
                data.profiles.get(id).is_some_and(|profile| {
                    !profile.archived && profile.revision == usage.profile_revision
                }),
                "BROWSER_PROFILE_USE_INVALID"
            );
        }
        let result = action(&mut data)?;
        self.verify()?;
        if write {
            let bytes = serde_json::to_vec(&data)?;
            ensure!(
                bytes.len() as u64 <= MAX_BYTES,
                "BROWSER_PROFILE_DATA_LIMIT"
            );
            self.directory
                .atomic_replace(OsStr::new(DATA), &bytes)
                .map_err(|_| anyhow::anyhow!("BROWSER_PROFILE_WRITE_UNCONFIRMED"))?;
            self.verify()
                .map_err(|_| anyhow::anyhow!("BROWSER_PROFILE_WRITE_UNCONFIRMED"))?;
        }
        Ok(result)
    }
    fn change(
        &self,
        op: &str,
        intent: Value,
        action: impl FnOnce(&mut Data) -> Result<BrowserAccountProfile>,
    ) -> Result<BrowserAccountProfile> {
        operation(op)?;
        let identity = hash(&intent)?;
        self.access(true, |data| {
            ensure!(
                !data.use_operations.contains_key(op),
                "BROWSER_PROFILE_OPERATION_CONFLICT"
            );
            if let Some(receipt) = data.operations.get(op) {
                ensure!(
                    receipt.intent == identity,
                    "BROWSER_PROFILE_OPERATION_CONFLICT"
                );
                return Ok(receipt.result.clone());
            }
            ensure!(
                data.operations.len() < 4096,
                "BROWSER_PROFILE_OPERATION_LIMIT"
            );
            let result = action(data)?;
            data.revision = data
                .revision
                .checked_add(1)
                .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            data.operations.insert(
                op.into(),
                Receipt {
                    intent: identity,
                    result: result.clone(),
                },
            );
            Ok(result)
        })
    }
    pub fn save(
        &self,
        op: &str,
        draft: BrowserAccountProfileDraft,
        expected: u64,
    ) -> Result<BrowserAccountProfile> {
        draft.validate().map_err(anyhow::Error::msg)?;
        self.change(op, json!(["save", draft, expected]), |data| {
            ensure!(
                !data.active_uses.contains_key(&draft.id),
                "BROWSER_PROFILE_IN_USE"
            );
            let current = data.profiles.get(&draft.id);
            ensure!(
                current.map_or(0, |p| p.revision) == expected,
                "BROWSER_PROFILE_REVISION_CONFLICT"
            );
            ensure!(
                current.is_some() || data.profiles.len() < 128,
                "BROWSER_PROFILE_CAPACITY"
            );
            let profile = BrowserAccountProfile {
                draft: draft.clone(),
                revision: expected
                    .checked_add(1)
                    .context("BROWSER_PROFILE_REVISION_LIMIT")?,
                archived: current.is_some_and(|p| p.archived),
            };
            data.profiles.insert(draft.id.clone(), profile.clone());
            Ok(profile)
        })
    }
    pub fn list(&self, after: Option<&str>, archived: bool) -> Result<BrowserAccountProfilePage> {
        self.access(false, |data| {
            let bound = hash(&("browser-profile-page-v1", &self.header.owner, archived))?;
            let last = if let Some(cursor) = after {
                let fields = cursor.split(':').collect::<Vec<_>>();
                ensure!(
                    fields.len() == 3
                        && fields[0] == bound
                        && fields[1] == data.revision.to_string()
                        && data.profiles.contains_key(fields[2]),
                    "BROWSER_PROFILE_CURSOR_INVALID"
                );
                Some(fields[2])
            } else {
                None
            };
            let mut profiles = data.profiles.iter().filter(|(id, p)| {
                last.is_none_or(|last| id.as_str() > last) && (archived || !p.archived)
            });
            let items = profiles
                .by_ref()
                .take(10)
                .map(|(_, p)| p.clone())
                .collect::<Vec<_>>();
            let next_cursor = if profiles.next().is_some() {
                items
                    .last()
                    .map(|p| format!("{bound}:{}:{}", data.revision, p.draft.id))
            } else {
                None
            };
            Ok(BrowserAccountProfilePage { items, next_cursor })
        })
    }
    pub fn set_archived(
        &self,
        op: &str,
        id: &str,
        expected: u64,
        archived: bool,
    ) -> Result<BrowserAccountProfile> {
        self.change(op, json!(["archive", id, expected, archived]), |data| {
            ensure!(!data.active_uses.contains_key(id), "BROWSER_PROFILE_IN_USE");
            let profile = data
                .profiles
                .get_mut(id)
                .context("BROWSER_PROFILE_NOT_FOUND")?;
            ensure!(
                profile.revision == expected,
                "BROWSER_PROFILE_REVISION_CONFLICT"
            );
            profile.revision = profile
                .revision
                .checked_add(1)
                .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            profile.archived = archived;
            Ok(profile.clone())
        })
    }

    /// Called by the already-authorized host before launching its owned browser.
    /// Existing or abandoned use remains busy; a restart never silently takes over.
    pub fn begin_use(&self, id: &str, expected: u64) -> Result<BrowserProfileUse> {
        self.begin_use_inner(id, expected, None)
    }

    /// Record the original launch intent durably before starting any browser.
    /// The same ID remains non-replayable after cleanup and process restart.
    pub fn begin_use_operation(
        &self,
        id: &str,
        expected: u64,
        operation_id: &str,
        intent_sha256: &str,
    ) -> Result<BrowserProfileUse> {
        operation(operation_id)?;
        ensure!(
            intent_sha256.len() == 64 && intent_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "BROWSER_PROFILE_INTENT_INVALID"
        );
        self.begin_use_inner(id, expected, Some((operation_id, intent_sha256)))
    }

    fn begin_use_inner(
        &self,
        id: &str,
        expected: u64,
        original: Option<(&str, &str)>,
    ) -> Result<BrowserProfileUse> {
        self.access(true, |data| {
            if let Some((operation, intent)) = original {
                ensure!(
                    !data.operations.contains_key(operation),
                    "BROWSER_PROFILE_OPERATION_CONFLICT"
                );
                if let Some(recorded) = data.use_operations.get(operation) {
                    ensure!(
                        recorded.profile_id == id && recorded.intent_sha256 == intent,
                        "BROWSER_PROFILE_OPERATION_CONFLICT"
                    );
                    anyhow::bail!("BROWSER_PROFILE_START_RECONCILE_REQUIRED");
                }
                ensure!(
                    data.use_operations.len() < 4096,
                    "BROWSER_PROFILE_OPERATION_LIMIT"
                );
            }
            let profile = data.profiles.get(id).context("BROWSER_PROFILE_NOT_FOUND")?;
            ensure!(!profile.archived, "BROWSER_PROFILE_ARCHIVED");
            ensure!(
                profile.revision == expected,
                "BROWSER_PROFILE_REVISION_CONFLICT"
            );
            ensure!(!data.active_uses.contains_key(id), "BROWSER_PROFILE_IN_USE");
            let use_id = uuid::Uuid::new_v4().to_string();
            if let Some((operation, intent)) = original {
                data.use_operations.insert(
                    operation.into(),
                    UseOperation {
                        profile_id: id.into(),
                        intent_sha256: intent.into(),
                        use_id: use_id.clone(),
                        released: false,
                    },
                );
            }
            data.active_uses.insert(
                id.into(),
                ActiveUse {
                    use_id: use_id.clone(),
                    profile_revision: expected,
                    cleanup_receipt: None,
                },
            );
            data.revision = data
                .revision
                .checked_add(1)
                .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            Ok(BrowserProfileUse {
                owner: self.header.owner.clone(),
                directory: self.header.directory.clone(),
                profile_id: id.into(),
                use_id,
                operation_id: original.map(|(operation, _)| operation.into()),
            })
        })
    }

    /// This storage transition is not process cleanup evidence. Its host caller must
    /// first confirm termination of the exact browser tree it owns.
    pub fn finish_use_after_owned_cleanup(&self, usage: &BrowserProfileUse) -> Result<()> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        self.access(true, |data| {
            if let Some(id) = &usage.operation_id {
                let recorded = data
                    .use_operations
                    .get(id)
                    .context("BROWSER_PROFILE_USE_UNCONFIRMED")?;
                ensure!(
                    recorded.profile_id == usage.profile_id && recorded.use_id == usage.use_id,
                    "BROWSER_PROFILE_USE_MISMATCH"
                );
            }
            let Some(current) = data.active_uses.get(&usage.profile_id) else {
                return Ok(());
            };
            ensure!(
                current.use_id == usage.use_id,
                "BROWSER_PROFILE_USE_MISMATCH"
            );
            data.active_uses.remove(&usage.profile_id);
            if let Some(id) = &usage.operation_id {
                let recorded = data
                    .use_operations
                    .get_mut(id)
                    .context("BROWSER_PROFILE_USE_MISSING")?;
                ensure!(
                    recorded.use_id == usage.use_id,
                    "BROWSER_PROFILE_USE_MISMATCH"
                );
                recorded.released = true;
            }
            data.revision = data
                .revision
                .checked_add(1)
                .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            Ok(())
        })
    }

    /// Create or reopen only the Cookie directory pinned by this exact live use.
    /// Once recorded, a missing/replaced directory is damage, never a new profile.
    pub fn user_data_directory(&self, usage: &BrowserProfileUse) -> Result<PrivateDirectory> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        self.access(true, |data| {
            let active = data
                .active_uses
                .get(&usage.profile_id)
                .context("BROWSER_PROFILE_USE_MISSING")?;
            ensure!(
                active.use_id == usage.use_id,
                "BROWSER_PROFILE_USE_MISMATCH"
            );
            let name = OsString::from(format!("browser-data-{}", usage.profile_id));
            let directory = if let Some(identity) = data.data_directories.get(&usage.profile_id) {
                let directory = self
                    .directory
                    .open_entry_handle(&name)?
                    .open_child_directory()?;
                directory.verify_private_directory()?;
                ensure!(
                    &directory.directory_identity()? == identity,
                    "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
                );
                directory
            } else {
                let directory = self.directory.create_private_child(&name)?;
                data.data_directories
                    .insert(usage.profile_id.clone(), directory.directory_identity()?);
                data.revision = data
                    .revision
                    .checked_add(1)
                    .context("BROWSER_PROFILE_REVISION_LIMIT")?;
                directory
            };
            Ok(directory)
        })
    }

    /// Relative name only; the host still verifies the pinned directory before launch.
    pub fn user_data_name(&self, usage: &BrowserProfileUse) -> Result<OsString> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        Ok(OsString::from(format!("browser-data-{}", usage.profile_id)))
    }

    pub fn verify_user_data_directory(
        &self,
        usage: &BrowserProfileUse,
        directory: &PrivateDirectory,
    ) -> Result<()> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        self.access(false, |data| {
            let active = data
                .active_uses
                .get(&usage.profile_id)
                .context("BROWSER_PROFILE_USE_MISSING")?;
            ensure!(
                active.use_id == usage.use_id,
                "BROWSER_PROFILE_USE_MISMATCH"
            );
            let current = self
                .directory
                .open_entry_handle(&self.user_data_name(usage)?)?
                .open_child_directory()?;
            current.verify_private_directory()?;
            directory.verify_private_directory()?;
            ensure!(
                data.data_directories.get(&usage.profile_id)
                    == Some(&current.directory_identity()?)
                    && current.directory_identity()? == directory.directory_identity()?,
                "BROWSER_PROFILE_DATA_DIRECTORY_CHANGED"
            );
            Ok(())
        })
    }

    /// The native host passes this exact descriptor only to its cleanup owner.
    /// A pathname/PID supplied by a client is never accepted as a receipt.
    pub fn prepare_cleanup_receipt(&self, usage: &BrowserProfileUse) -> Result<File> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        self.access(true, |data| {
            let active = data
                .active_uses
                .get_mut(&usage.profile_id)
                .context("BROWSER_PROFILE_USE_MISSING")?;
            ensure!(
                active.use_id == usage.use_id && active.cleanup_receipt.is_none(),
                "BROWSER_PROFILE_CLEANUP_RECEIPT_CONFLICT"
            );
            let name = OsString::from(format!("cleanup-{}.receipt", usage.use_id));
            let file = self.directory.open_read_write_file(&name, true)?;
            active.cleanup_receipt = Some(self.directory.portable_regular_handle_identity(&file)?);
            data.revision = data
                .revision
                .checked_add(1)
                .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            Ok(file)
        })
    }

    /// Observe only this original host use; never release or relaunch it.
    pub fn cleanup_receipt_confirmed(&self, usage: &BrowserProfileUse) -> Result<bool> {
        ensure!(
            usage.owner == self.header.owner && usage.directory == self.header.directory,
            "BROWSER_PROFILE_USE_OWNER_MISMATCH"
        );
        self.access(false, |data| {
            let Some(active) = data.active_uses.get(&usage.profile_id) else {
                return Ok(usage
                    .operation_id
                    .as_ref()
                    .and_then(|id| data.use_operations.get(id))
                    .is_some_and(|record| {
                        record.use_id == usage.use_id
                            && record.profile_id == usage.profile_id
                            && record.released
                    }));
            };
            ensure!(
                active.use_id == usage.use_id,
                "BROWSER_PROFILE_USE_MISMATCH"
            );
            self.cleanup_receipt_complete(active)
        })
    }

    fn cleanup_receipt_complete(&self, active: &ActiveUse) -> Result<bool> {
        let Some(expected) = &active.cleanup_receipt else {
            return Ok(false);
        };
        let name = OsString::from(format!("cleanup-{}.receipt", active.use_id));
        let mut file = self.directory.open_single_link_regular_file(&name)?;
        ensure!(
            &self.directory.portable_regular_handle_identity(&file)? == expected,
            "BROWSER_PROFILE_CLEANUP_RECEIPT_CHANGED"
        );
        ensure!(
            file.metadata()?.len() <= 64,
            "BROWSER_PROFILE_CLEANUP_RECEIPT_INVALID"
        );
        let mut bytes = Vec::new();
        (&mut file).take(65).read_to_end(&mut bytes)?;
        ensure!(
            self.directory.portable_regular_identity(&name)? == *expected,
            "BROWSER_PROFILE_CLEANUP_RECEIPT_CHANGED"
        );
        let complete = b"kcoder-owned-cleanup/v1\nconfirmed\n";
        if bytes.is_empty() || complete.starts_with(&bytes) && bytes.len() < complete.len() {
            return Ok(false);
        }
        ensure!(bytes == complete, "BROWSER_PROFILE_CLEANUP_RECEIPT_INVALID");
        Ok(true)
    }

    /// Called only after the authenticated native host verifies its current scope.
    /// This observes the original pinned completion file; it does not stop/relaunch a process.
    pub fn reconcile_cleanup_receipts(&self) -> Result<usize> {
        self.access(true, |data| {
            let mut released = Vec::new();
            for (id, active) in &data.active_uses {
                if !self.cleanup_receipt_complete(active)? {
                    continue;
                }
                released.push((id.clone(), active.use_id.clone()));
            }
            for (id, use_id) in &released {
                data.active_uses.remove(id);
                for operation in data
                    .use_operations
                    .values_mut()
                    .filter(|operation| operation.use_id == *use_id)
                {
                    operation.released = true;
                }
            }
            if !released.is_empty() {
                data.revision = data
                    .revision
                    .checked_add(1)
                    .context("BROWSER_PROFILE_REVISION_LIMIT")?;
            }
            Ok(released.len())
        })
    }
}
