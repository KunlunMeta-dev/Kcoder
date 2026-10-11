//! Bounded redo transactions beneath one verified account root. No network or
//! upload bytes may execute while this metadata lock is held. Bounded owner
//! publication/retirement syscalls use checkpoints without releasing the lock.
use super::model::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, PrivateLeaseMode, VerifiedPrivateEntry};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{collections::BTreeMap, ffi::OsStr, io::Read, path::Path};
use uuid::Uuid;

pub(super) fn digest(bytes: &[u8]) -> String {
    super::super::private_files::hex_sha256(bytes)
}
pub(super) fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
pub(super) fn leaf(id: &str) -> String {
    format!("{}.json", digest(id.as_bytes()))
}
fn bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let result = serde_json::to_vec(value)?;
    ensure!(
        result.len() as u64 <= RECORD_BYTES,
        "retention record exceeds bounded size"
    );
    Ok(result)
}
fn raw(directory: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    directory.retention_regular_identity(OsStr::new(name))?;
    let mut result = Vec::new();
    file.take(RECORD_BYTES + 1).read_to_end(&mut result)?;
    ensure!(
        result.len() as u64 <= RECORD_BYTES,
        "oversized retention authority record"
    );
    Ok(Some(result))
}

pub(super) struct Store {
    root: PrivateDirectory,
    pub header: Header,
}

// Only namespace locks use explicit unlock. A forked child can retain the
// same open-file description until exec even when its FD has O_CLOEXEC.
// Owner leases and ordinary verified entries keep their existing semantics.
enum NamespaceLock {
    Initializing(std::fs::File),
    Transaction(VerifiedPrivateEntry),
}

impl Drop for NamespaceLock {
    fn drop(&mut self) {
        let file = match self {
            Self::Initializing(file) => file,
            Self::Transaction(entry) => entry.file(),
        };
        let _ = fs2::FileExt::unlock(file);
    }
}

impl Store {
    /// Called only with the OS-trusted account config directory and an Engine
    /// durable-storage fact. This is not a public RPC parameter or capability.
    pub fn open(account: &Path, durable: bool, limits: Limits) -> Result<Self> {
        ensure!(
            durable,
            "retention unavailable for ephemeral Engine storage"
        );
        limits.validate()?;
        let account = PrivateDirectory::open_existing(account)?;
        account.retention_identity()?;
        ensure!(
            account.retention_filesystem_supported()?,
            "retention filesystem is unsupported"
        );
        let (root, created) = match account.open_child(OsStr::new("attachment-retention-v1"), false)
        {
            Ok(root) => (root, false),
            Err(error) if missing(&error) => (
                account.open_child(OsStr::new("attachment-retention-v1"), true)?,
                true,
            ),
            Err(error) => return Err(error),
        };
        let identity = root.retention_identity()?;
        if let Some(header) = raw(&root, "retention-root.json")? {
            let header: Header = serde_json::from_slice(&header)?;
            ensure!(
                matches!(header.version, 1 | 2) && header.limits == limits,
                "retention root policy mismatch"
            );
            root.verify_retention_identity(&header.identity)?;
            for area in Area::ALL {
                root.open_verified_child(
                    OsStr::new(area.name()),
                    header
                        .areas
                        .get(&area)
                        .context("retention area identity missing")?,
                )?;
            }
            let store = Self { root, header };
            let _ = store.transaction()?;
            return Ok(store);
        }
        // A missing header on an existing unrelated directory is not permission
        // to reset budgets or mint a replacement namespace.
        if !created {
            ensure!(
                raw(&root, "initializing")?.is_some(),
                "retention root initialization is unknown; refusing reset"
            );
        }
        let initialization = NamespaceLock::Initializing(
            root.try_exclusive_lock(OsStr::new("namespace.lock"))?
                .context("retention root initialization busy")?,
        );
        let lock_identity = root.retention_regular_identity(OsStr::new("namespace.lock"))?;
        let bootstrap: Header = if let Some(previous) = raw(&root, "initializing")? {
            let header: Header = serde_json::from_slice(&previous)?;
            ensure!(
                header.version == 1
                    && header.identity == identity
                    && header.lock_identity == lock_identity
                    && header.limits == limits,
                "retention bootstrap identity mismatch"
            );
            header
        } else {
            let header = Header {
                version: 1,
                namespace: Uuid::new_v4().simple().to_string(),
                identity,
                lock_identity,
                areas: BTreeMap::new(),
                limits,
            };
            root.atomic_replace(OsStr::new("initializing"), &bytes(&header)?)?;
            header
        };
        // A previous initializer may have committed the final header while this
        // process awaited the nonblocking lock; never replace that namespace.
        if raw(&root, "retention-root.json")?.is_some() {
            anyhow::bail!(
                "retention initializer raced finalization; retry open without resetting namespace"
            );
        }
        let mut header = bootstrap;
        for area in Area::ALL {
            let child = root.open_child(OsStr::new(area.name()), true)?;
            header.areas.insert(area, child.retention_identity()?);
        }
        if let Some(prior) = raw(&root, "state")? {
            let state: State = serde_json::from_slice(&prior)?;
            state.validate(&header)?;
            ensure!(
                state.revision == 0,
                "unfinalized retention root has mutations"
            );
        } else {
            root.atomic_replace(
                OsStr::new("state"),
                &bytes(&State::new(header.namespace.clone()))?,
            )?;
        }
        root.atomic_replace(OsStr::new("retention-root.json"), &bytes(&header)?)?;
        root.remove_regular_file(OsStr::new("initializing"))?;
        drop(initialization);
        let store = Self { root, header };
        let _ = store.transaction()?;
        Ok(store)
    }
    fn area(&self, area: Area) -> Result<PrivateDirectory> {
        self.root.verify_retention_identity(&self.header.identity)?;
        self.root.open_verified_child(
            OsStr::new(area.name()),
            self.header
                .areas
                .get(&area)
                .context("missing retention area")?,
        )
    }
    #[cfg(test)]
    pub fn testing_area(&self, area: Area) -> Result<PrivateDirectory> {
        self.area(area)
    }
    #[cfg(test)]
    pub fn inject_state(&self, bytes: &[u8]) -> Result<()> {
        self.root.atomic_replace(OsStr::new("state"), bytes)
    }
    pub fn data(&self) -> Result<PrivateDirectory> {
        self.area(Area::Data)
    }
    pub fn leases(&self) -> Result<PrivateDirectory> {
        self.area(Area::Leases)
    }
    pub fn transaction(&self) -> Result<Transaction<'_>> {
        self.root.verify_retention_identity(&self.header.identity)?;
        let lock = NamespaceLock::Transaction(
            self.root
                .try_existing_verified_lock(
                    OsStr::new("namespace.lock"),
                    &self.header.lock_identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("retention metadata busy")?,
        );
        let header: Header = serde_json::from_slice(
            &raw(&self.root, "retention-root.json")?.context("retention header missing")?,
        )?;
        ensure!(
            matches!(header.version, 1 | 2)
                && header.namespace == self.header.namespace
                && header.identity == self.header.identity
                && header.lock_identity == self.header.lock_identity
                && header.areas == self.header.areas
                && header.limits == self.header.limits,
            "retention header changed; refusing stale authority"
        );
        self.recover()?;
        let initial =
            raw(&self.root, "state")?.context("retention state missing; refusing quota reset")?;
        let state: State = serde_json::from_slice(&initial)?;
        state.validate(&self.header)?;
        Ok(Transaction {
            store: self,
            _lock: lock,
            base_hash: digest(&initial),
            state,
            changes: BTreeMap::new(),
        })
    }
    fn recover(&self) -> Result<()> {
        let Some(raw_journal) = raw(&self.root, "transaction")? else {
            return Ok(());
        };
        let journal: Journal = serde_json::from_slice(&raw_journal)?;
        ensure!(
            journal.namespace == self.header.namespace
                && journal.version == 1
                && journal.changes.len() <= 128,
            "invalid retention redo journal"
        );
        journal.next_state.validate(&self.header)?;
        let state = raw(&self.root, "state")?.context("retention quota missing during recovery")?;
        let next = bytes(&journal.next_state)?;
        ensure!(
            digest(&state) == journal.base_hash || state == next,
            "retention redo state conflict"
        );
        for change in &journal.changes {
            self.apply(change)?;
        }
        self.root.atomic_replace(OsStr::new("state"), &next)?;
        self.root.remove_regular_file(OsStr::new("transaction"))
    }
    fn apply(&self, change: &Change) -> Result<()> {
        ensure!(
            change.locator.area.records() && safe_leaf(&change.locator.leaf),
            "unsafe redo locator"
        );
        let directory = self.area(change.locator.area)?;
        let current = raw(&directory, &change.locator.leaf)?;
        let next = change.next.as_ref().map(bytes).transpose()?;
        if current == next {
            // Visibility does not prove the last rename/unlink was durable.
            // Retry its directory fsync before committing quota or dropping WAL.
            return directory.sync();
        }
        ensure!(
            current.as_ref().map(|value| digest(value)) == change.old_hash,
            "retention record changed outside redo transaction"
        );
        match next {
            Some(next) => directory.atomic_replace(OsStr::new(&change.locator.leaf), &next),
            None => directory.remove_regular_file(OsStr::new(&change.locator.leaf)),
        }
    }
}
fn safe_leaf(name: &str) -> bool {
    name.len() == 69 && name.ends_with(".json") && name[..64].bytes().all(|b| b.is_ascii_hexdigit())
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    locator: Locator,
    old_hash: Option<String>,
    next: Option<Value>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    namespace: String,
    base_hash: String,
    next_state: State,
    changes: Vec<Change>,
}
pub(super) struct Transaction<'a> {
    store: &'a Store,
    _lock: NamespaceLock,
    base_hash: String,
    pub state: State,
    changes: BTreeMap<(Area, String), Change>,
}
impl Transaction<'_> {
    /// A missing request row is not a new intent if the bounded durable catalog
    /// still registers it. This is recovery metadata, never a directory scan.
    pub fn assert_unregistered(&self, area: Area, id: &str) -> Result<()> {
        let wanted = leaf(id);
        for (epoch_id, epoch) in &self.state.epochs {
            for number in 0..epoch.records.div_ceil(INDEX_PAGE_SIZE as u64) {
                let page: IndexPage = self
                    .read(Area::Index, &format!("{epoch_id}:{number}"))?
                    .context("owner request catalog missing; reconciliation required")?;
                ensure!(
                    page.records.len()
                        == (epoch.records - number * INDEX_PAGE_SIZE as u64)
                            .min(INDEX_PAGE_SIZE as u64) as usize,
                    "owner request catalog membership mismatch"
                );
                ensure!(
                    !page
                        .records
                        .iter()
                        .any(|record| record.area == area && record.leaf == wanted),
                    "owner request record missing; reconciliation required"
                );
            }
        }
        Ok(())
    }
    /// One-way upgrade under the existing namespace lock. Deployment must stop
    /// all old binaries before upgrading; cached old processes are unsupported.
    pub fn require_layout_v2(&self) -> Result<()> {
        let mut header: Header = serde_json::from_slice(
            &raw(&self.store.root, "retention-root.json")?
                .context("retention header missing during upgrade")?,
        )?;
        if header.version == 1 {
            header.version = 2;
            self.store
                .root
                .atomic_replace(OsStr::new("retention-root.json"), &bytes(&header)?)?;
        }
        ensure!(header.version == 2, "unsupported retention layout header");
        self.store.root.sync()
    }
    pub fn read<T: DeserializeOwned>(&self, area: Area, id: &str) -> Result<Option<T>> {
        let name = leaf(id);
        if let Some(change) = self.changes.get(&(area, name.clone())) {
            return change
                .next
                .clone()
                .map(serde_json::from_value)
                .transpose()
                .map_err(Into::into);
        }
        raw(&self.store.area(area)?, &name)?
            .map(|raw| serde_json::from_slice(&raw))
            .transpose()
            .map_err(Into::into)
    }
    /// Recovery-only fallback over the durable, bounded registration catalog,
    /// never a filesystem walk. Normal known-ID reads use the inverse intent
    /// index. A missing registered authority leaf or index page is unknown/error.
    pub fn registered_binding_scope(
        &self,
        epoch: u64,
        selector: &kcoder_app_protocol::RetentionReceiptSelectorV1,
    ) -> Result<Option<String>> {
        let records = self
            .state
            .epochs
            .get(&epoch)
            .context("retention lookup epoch missing")?
            .records;
        let pages = records.div_ceil(INDEX_PAGE_SIZE as u64);
        for page_number in 0..pages {
            let page: IndexPage = self
                .read(Area::Index, &format!("{epoch}:{page_number}"))?
                .context("registered retention catalog page missing; reconciliation required")?;
            let expected = (records - page_number * INDEX_PAGE_SIZE as u64)
                .min(INDEX_PAGE_SIZE as u64) as usize;
            ensure!(
                page.records.len() == expected,
                "retention catalog membership mismatch"
            );
            for locator in page.records {
                ensure!(
                    safe_leaf(&locator.leaf)
                        && locator.area.records()
                        && locator.area != Area::Index,
                    "invalid registered authority locator"
                );
                let wanted = match selector {
                    kcoder_app_protocol::RetentionReceiptSelectorV1::ClientRequestId { .. } => {
                        locator.area == Area::Intents
                    }
                    kcoder_app_protocol::RetentionReceiptSelectorV1::RetentionId { .. } => {
                        matches!(locator.area, Area::Intents | Area::Entries)
                    }
                };
                if !wanted {
                    continue;
                }
                let raw = raw(&self.store.area(locator.area)?, &locator.leaf)?
                    .context("registered retention authority missing; reconciliation required")?;
                if locator.area == Area::Intents {
                    let intent: Intent = serde_json::from_slice(&raw)?;
                    let found = match selector {
                        kcoder_app_protocol::RetentionReceiptSelectorV1::ClientRequestId {
                            client_request_id,
                        } => intent.client_request_id == *client_request_id,
                        kcoder_app_protocol::RetentionReceiptSelectorV1::RetentionId {
                            retention_id,
                        } => intent.retention_id == *retention_id,
                    };
                    if found {
                        return Ok(Some(intent.scope_hash));
                    }
                } else {
                    let entry: Entry = serde_json::from_slice(&raw)?;
                    if let kcoder_app_protocol::RetentionReceiptSelectorV1::RetentionId {
                        retention_id,
                    } = selector
                        && entry.retention_id.as_deref() == Some(retention_id.as_str())
                    {
                        return Ok(Some(entry.scope_hash));
                    }
                }
            }
        }
        Ok(None)
    }
    fn change(&mut self, area: Area, id: &str, value: Option<Value>) -> Result<bool> {
        ensure!(
            area.records(),
            "data and lease changes are not metadata transactions"
        );
        let name = leaf(id);
        let old = raw(&self.store.area(area)?, &name)?;
        let first_change = !self.changes.contains_key(&(area, name.clone()));
        let previous = match self.changes.get(&(area, name.clone())) {
            Some(change) => change.next.as_ref().map(bytes).transpose()?,
            None => old.clone(),
        };
        let next = value.as_ref().map(bytes).transpose()?;
        let old_size = previous.as_ref().map_or(0, |v| v.len() as u64);
        let new_size = next.as_ref().map_or(0, |v| v.len() as u64);
        // Slot credits are authority from the persisted record, not a global
        // capacity request during cleanup. Written growth spends unused bytes.
        let credit = |raw: &Option<Vec<u8>>, size: u64| -> Result<(u64, u64, u64)> {
            if !matches!(area, Area::Owners | Area::Entries | Area::Receipts) {
                return Ok((0, 0, 0));
            }
            let Some(raw) = raw else {
                return Ok((0, 0, 0));
            };
            let record: Value = serde_json::from_slice(raw)?;
            let capacity = record
                .get("cleanup_capacity")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let terminal = record
                .get("terminal_budget")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            ensure!(
                capacity == 0 || capacity == RECORD_BYTES,
                "invalid prepaid cleanup slot"
            );
            ensure!(
                terminal == 0 || (area == Area::Receipts && terminal == 2 * RECORD_BYTES),
                "invalid prepaid terminal budget"
            );
            let unused = if capacity == 0 {
                0
            } else {
                capacity
                    .checked_sub(size)
                    .context("prepaid cleanup slot exhausted")?
            };
            Ok((
                unused
                    .checked_add(terminal)
                    .context("cleanup credit overflow")?,
                u64::from(terminal != 0),
                if area == Area::Owners
                    && record
                        .get("request")
                        .is_some_and(|request| !request.is_null())
                {
                    unused
                } else if terminal == 0 {
                    0
                } else {
                    RECORD_BYTES
                },
            ))
        };
        let old_credit = credit(&previous, old_size)?;
        let new_credit = credit(&next, new_size)?;
        let adjust = |total: &mut u64, previous: u64, next: u64| -> Result<()> {
            *total = total
                .checked_sub(previous)
                .context("prepaid cleanup underflow")?
                .checked_add(next)
                .context("prepaid cleanup overflow")?;
            Ok(())
        };
        adjust(
            &mut self.state.charges.cleanup_metadata_bytes,
            old_credit.0,
            new_credit.0,
        )?;
        adjust(
            &mut self.state.charges.prepaid_tombstones,
            old_credit.1,
            new_credit.1,
        )?;
        adjust(
            &mut self.state.charges.prepaid_tombstone_bytes,
            old_credit.2,
            new_credit.2,
        )?;
        self.state.charges.metadata_bytes = self
            .state
            .charges
            .metadata_bytes
            .checked_sub(old_size)
            .context("retention metadata underflow")?
            .checked_add(new_size)
            .context("retention metadata overflow")?;
        let owner_request = |raw: &Option<Vec<u8>>| -> Result<bool> {
            Ok(raw
                .as_ref()
                .map(|bytes| serde_json::from_slice::<Value>(bytes))
                .transpose()?
                .is_some_and(|record| {
                    record
                        .get("request")
                        .is_some_and(|request| !request.is_null())
                }))
        };
        let old_owner_request = area == Area::Owners && owner_request(&previous)?;
        let new_owner_request = area == Area::Owners && owner_request(&next)?;
        // Stable owner request authority survives retirement. Reserve its hard
        // tombstone budget from the first row, not after physical deletion.
        if new_owner_request && !old_owner_request {
            self.state.charges.tombstones += 1;
        }
        if area == Area::Consumed || old_owner_request || new_owner_request {
            self.state.charges.tombstone_bytes = self
                .state
                .charges
                .tombstone_bytes
                .checked_sub(old_size)
                .context("tombstone bytes underflow")?
                .checked_add(new_size)
                .context("tombstone bytes overflow")?;
        }
        self.changes.insert(
            (area, name.clone()),
            Change {
                locator: Locator { area, leaf: name },
                old_hash: old.as_ref().map(|value| digest(value)),
                next: value,
            },
        );
        Ok(first_change && old.is_none())
    }
    pub fn put<T: Serialize>(&mut self, area: Area, id: &str, epoch: u64, value: &T) -> Result<()> {
        let new = self.change(area, id, Some(serde_json::to_value(value)?))?;
        if new && area != Area::Index {
            let count = self
                .state
                .epochs
                .get(&epoch)
                .context("retention record epoch missing")?
                .records;
            let page_id = format!("{epoch}:{}", count / INDEX_PAGE_SIZE as u64);
            let mut page: IndexPage = self.read(Area::Index, &page_id)?.unwrap_or_default();
            ensure!(
                page.records.len() == count as usize % INDEX_PAGE_SIZE,
                "retention index position conflict"
            );
            page.records.push(Locator {
                area,
                leaf: leaf(id),
            });
            self.change(Area::Index, &page_id, Some(serde_json::to_value(page)?))?;
            self.state
                .epochs
                .get_mut(&epoch)
                .expect("checked epoch")
                .records += 1;
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn delete_record_for_test(&mut self, area: Area, id: &str) -> Result<()> {
        self.change(area, id, None)?;
        Ok(())
    }
    /// Apply redo without reacquiring namespace.lock. Each caller checkpoint
    /// leaves the same OS lock pinned through the next publication phase.
    pub fn validate_pending(&self) -> Result<()> {
        self.state.validate(&self.store.header)?;
        bytes(&Journal {
            version: 1,
            namespace: self.store.header.namespace.clone(),
            base_hash: self.base_hash.clone(),
            next_state: self.state.clone(),
            changes: self.changes.values().cloned().collect(),
        })?;
        Ok(())
    }
    pub fn checkpoint_keep_lock(&mut self) -> Result<()> {
        self.state.revision = self
            .state
            .revision
            .checked_add(1)
            .context("retention revision overflow")?;
        self.state.validate(&self.store.header)?;
        let journal = Journal {
            version: 1,
            namespace: self.store.header.namespace.clone(),
            base_hash: self.base_hash.clone(),
            next_state: self.state.clone(),
            changes: self.changes.values().cloned().collect(),
        };
        let encoded = bytes(&journal)?;
        self.store
            .root
            .atomic_replace(OsStr::new("transaction"), &encoded)?;
        #[cfg(all(test, target_os = "linux"))]
        for change in &journal.changes {
            if change.locator.area == Area::Owners
                && let Some(next) = &change.next
            {
                let owner: Owner = serde_json::from_value(next.clone())?;
                if owner.layout_version == 2 && owner.phase == OwnerPhase::Active {
                    super::tests::pause_owner_init_test_hook("v2-active-journal", &owner.id);
                }
            }
        }
        #[cfg(test)]
        if FAIL_AFTER_JOURNAL.with(|value| value.replace(false)) {
            anyhow::bail!("injected crash after durable retention journal");
        }
        self.store.recover()?;
        let current =
            raw(&self.store.root, "state")?.context("retention state lost after checkpoint")?;
        let state: State = serde_json::from_slice(&current)?;
        state.validate(&self.store.header)?;
        ensure!(
            current == bytes(&journal.next_state)?,
            "retention checkpoint state mismatch"
        );
        self.base_hash = digest(&current);
        self.state = state;
        self.changes.clear();
        Ok(())
    }
    pub fn commit(mut self) -> Result<()> {
        self.checkpoint_keep_lock()
    }
}
#[cfg(test)]
thread_local! { pub(super) static FAIL_AFTER_JOURNAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
