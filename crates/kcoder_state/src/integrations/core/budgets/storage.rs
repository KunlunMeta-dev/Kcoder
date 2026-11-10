use super::model::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
};

const MAX_LEDGER_BYTES: u64 = 16 * 1024 * 1024;
const LOCK: &str = "budgets.lock";
const HEADER: &str = "owner.json";
const DATA: &str = "ledger.json";
#[cfg(any(target_os = "linux", windows))]
const MAX_SNAPSHOT_REOPENS: usize = 8;

#[cfg(all(test, any(target_os = "linux", windows)))]
thread_local! {
    static AFTER_SNAPSHOT_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, any(target_os = "linux", windows)))]
pub(super) fn after_snapshot_read_once(hook: impl FnOnce() + 'static) {
    AFTER_SNAPSHOT_READ.with(|slot| assert!(slot.borrow_mut().replace(Box::new(hook)).is_none()));
}
#[path = "observations.rs"]
mod observations;
#[path = "parents.rs"]
mod parents;
#[path = "subscription_windows.rs"]
mod subscription_windows;
pub use parents::NativeBudgetTaskParent;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}
pub struct NativeBudgetStore {
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
}
impl std::fmt::Debug for NativeBudgetStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeBudgetStore { native_namespace: bound }")
    }
}
impl NativeBudgetStore {
    /// Only the native host's authorized first write may call this.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let lock_anchor = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let lock_identity = directory.portable_regular_handle_identity(&lock_anchor)?;
        let owner = IntegrationOwner::from(scope);
        let header = Header {
            version: 1,
            owner: owner.clone(),
            directory_identity: directory.directory_identity()?,
            lock_identity,
        };
        directory.atomic_replace(
            OsStr::new(DATA),
            &serde_json::to_vec(&Ledger::empty(owner))?,
        )?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        Self::from_directory(parent, name, directory, scope)
    }
    /// Pure observation. Missing children return None; an existing damaged store errors.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        Self::from_directory(parent, name, entry.open_child_directory()?, scope).map(Some)
    }
    fn from_directory(
        parent: &PrivateDirectory,
        name: &OsStr,
        directory: PrivateDirectory,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        let header: Header = serde_json::from_slice(&read(&directory, HEADER, 8192)?)?;
        ensure!(
            header.owner == IntegrationOwner::from(scope),
            "BUDGET_OWNER_MISMATCH"
        );
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let header_identity = directory.portable_regular_handle_identity(&header_anchor)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.to_os_string(),
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
        };
        store.load()?;
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
                && actual.directory_identity()? == header.directory_identity
                && self.directory.directory_identity()? == header.directory_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(HEADER))?
                    == self.header_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.header_anchor)?
                    == self.header_identity
                && self.directory.portable_regular_identity(OsStr::new(LOCK))?
                    == header.lock_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.lock_anchor)?
                    == header.lock_identity,
            "BUDGET_STORAGE_CHANGED"
        );
        Ok(())
    }
    fn load(&self) -> Result<Ledger> {
        self.load_with(|directory| read_data_observation(directory, MAX_LEDGER_BYTES))
    }

    fn load_for_mutation(&self) -> Result<Ledger> {
        self.load_with(|directory| read(directory, DATA, MAX_LEDGER_BYTES))
    }

    fn load_with(
        &self,
        read_data: impl FnOnce(&PrivateDirectory) -> Result<Vec<u8>>,
    ) -> Result<Ledger> {
        self.verify()?;
        let data: Ledger = serde_json::from_slice(&read_data(&self.directory)?)?;
        ensure!(data.owner == self.header.owner, "BUDGET_OWNER_MISMATCH");
        data.validate()?;
        self.verify()?;
        Ok(data)
    }

    fn mutate<T>(&self, operation: impl FnOnce(&mut Ledger) -> Result<T>) -> Result<T> {
        self.verify()?;
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.header.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("BUDGET_BUSY")?;
        let mut data = self.load_for_mutation()?;
        let revision = data.revision;
        let result = operation(&mut data)?;
        if data.revision != revision {
            data.validate()?;
            let bytes = serde_json::to_vec(&data)?;
            ensure!(
                bytes.len() <= MAX_LEDGER_BYTES as usize,
                "BUDGET_LEDGER_CAPACITY"
            );
            self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
        }
        self.verify()?;
        Ok(result)
    }
    pub fn storage_directory_identity(&self) -> Result<String> {
        self.verify()?;
        self.directory.directory_identity()
    }
    pub fn read_reservation(&self, id: &str) -> Result<Option<BudgetReservationReceipt>> {
        label(id)?;
        Ok(self
            .load()?
            .reservations
            .get(id)
            .map(|value| value.receipt.clone()))
    }
    /// Privileged shared-ledger adapters bind reads to their authenticated member facts.
    pub fn read_reservation_for_principal(
        &self,
        id: &str,
        principal: &NativeBudgetPrincipal,
    ) -> Result<Option<BudgetReservationReceipt>> {
        label(id)?;
        let data = self.load()?;
        let Some(record) = data.reservations.get(id) else {
            return Ok(None);
        };
        ensure!(
            record.request.matches_native_principal(principal),
            "BUDGET_PRINCIPAL_MISMATCH"
        );
        self.verify()?;
        Ok(Some(record.receipt.clone()))
    }
    /// Native config publication is independent of allocation. A stricter new
    /// version remains current even when its following admission is denied.
    pub fn install_policies(&self, policies: &[NativeBudgetPolicy]) -> Result<()> {
        self.mutate(|data| data.install_policies(policies))
    }
    pub fn reserve(
        &self,
        request: &NativeBudgetRequest,
        policies: &[NativeBudgetPolicy],
        now_ms: u64,
    ) -> Result<BudgetReservationResult> {
        if self.read_reservation(&request.reservation_id)?.is_none() {
            self.install_policies(policies)?;
        }
        self.mutate(|data| data.reserve(request, policies, now_ms))
    }
    pub fn bind_task(
        &self,
        id: &str,
        expected_revision: u64,
        binding: &NativeBudgetTaskBinding,
        now_ms: u64,
    ) -> Result<BudgetReservationReceipt> {
        label(id)?;
        self.mutate(|data| data.bind_task(id, expected_revision, binding, now_ms))
    }
    pub fn mark_dispatched(
        &self,
        id: &str,
        expected_revision: u64,
        policies: &[NativeBudgetPolicy],
        now_ms: u64,
    ) -> Result<BudgetDispatchResult> {
        label(id)?;
        self.mutate(|data| data.dispatch(id, expected_revision, policies, now_ms))
    }
    pub fn record_usage(
        &self,
        id: &str,
        expected_revision: u64,
        update_id: &str,
        report: &NativeBudgetUsage,
        terminal: Option<&NativeBudgetTerminal>,
        now_ms: u64,
    ) -> Result<BudgetReservationReceipt> {
        label(id)?;
        self.mutate(|data| data.usage(id, expected_revision, update_id, report, terminal, now_ms))
    }
    pub fn observe_policy(
        &self,
        policy: &NativeBudgetPolicy,
    ) -> Result<Option<BudgetWindowObservation>> {
        let data = self.load()?;
        let key = policy.record.key()?;
        data.windows
            .get(&key)
            .map(|record| data.observation(record))
            .transpose()
    }
}
fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    read_open_file(&mut file, limit)
}

fn read_open_file(file: &mut File, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "BUDGET_LEDGER_CAPACITY");
    Ok(bytes)
}

#[cfg(target_os = "linux")]
type DataIdentity = (u64, u64);

#[cfg(target_os = "linux")]
fn data_identity(file: &File) -> Result<Option<DataIdentity>> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    match metadata.nlink() {
        0 => Ok(None),
        1 => Ok(Some((metadata.dev(), metadata.ino()))),
        _ => anyhow::bail!("file has multiple links"),
    }
}

#[cfg(windows)]
type DataIdentity = (u64, [u8; 16]);

#[cfg(windows)]
fn data_identity(file: &File) -> Result<Option<DataIdentity>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx,
    };

    let handle = file.as_raw_handle().cast();
    let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the file owns a live handle and basic is an aligned output value.
    ensure!(
        unsafe { GetFileInformationByHandle(handle, &mut basic) } != 0
            && basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "BUDGET_DATA_IDENTITY_UNAVAILABLE"
    );
    match basic.nNumberOfLinks {
        0 => return Ok(None),
        1 => {}
        _ => anyhow::bail!("file has multiple links"),
    }
    let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: the live handle and output buffer have the type and size required
    // by FileIdInfo; this identity is only compared while both handles remain open.
    ensure!(
        unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0
            && id.VolumeSerialNumber != 0
            && id.FileId.Identifier.iter().any(|byte| *byte != 0),
        "BUDGET_DATA_IDENTITY_UNAVAILABLE"
    );
    Ok(Some((id.VolumeSerialNumber, id.FileId.Identifier)))
}

#[cfg(any(target_os = "linux", windows))]
fn read_data_observation(directory: &PrivateDirectory, limit: u64) -> Result<Vec<u8>> {
    for _ in 0..MAX_SNAPSHOT_REOPENS {
        let mut file = directory.open_regular_file(OsStr::new(DATA))?;
        let Some(before) = data_identity(&file)? else {
            continue;
        };
        let bytes = read_open_file(&mut file, limit)?;
        #[cfg(test)]
        AFTER_SNAPSHOT_READ.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let Some(after) = data_identity(&file)? else {
            continue;
        };
        let named = directory.open_regular_file(OsStr::new(DATA))?;
        let Some(named_identity) = data_identity(&named)? else {
            continue;
        };
        let Some(final_identity) = data_identity(&file)? else {
            continue;
        };
        ensure!(
            before == after && after == named_identity && final_identity == named_identity,
            "BUDGET_STORAGE_CHANGED"
        );
        return Ok(bytes);
    }
    anyhow::bail!("BUDGET_BUSY")
}

#[cfg(not(any(target_os = "linux", windows)))]
fn read_data_observation(directory: &PrivateDirectory, limit: u64) -> Result<Vec<u8>> {
    read(directory, DATA, limit)
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
