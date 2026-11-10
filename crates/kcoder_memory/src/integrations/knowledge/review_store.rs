use anyhow::{Result, bail, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::IntegrationScope;
use kcoder_types::integrations::knowledge::{
    KnowledgeOwner, KnowledgePage, MemoryProposal, MemoryReview, MemoryReviewStatus,
    MemoryTaskSnapshot, ReviewedMemory,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;

const FILE: &str = "memory-review.json";
const LOCK: &str = "memory-review.lock";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    intent: Value,
    result: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    schema_version: u32,
    owner: KnowledgeOwner,
    next_id: u64,
    records: BTreeMap<String, ReviewedMemory>,
    receipts: BTreeMap<String, Receipt>,
    snapshots: BTreeMap<String, MemoryTaskSnapshot>,
}

/// Private, cross-process locked curation state; it does not rewrite legacy memories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreBinding {
    version: u32,
    owner: KnowledgeOwner,
    lock_identity: PortableLeaseIdentity,
}
pub struct MemoryReviewStore {
    directory: PrivateDirectory,
    owner: KnowledgeOwner,
    binding: StoreBinding,
    binding_identity: PortableLeaseIdentity,
    lock_anchor: std::fs::File,
    binding_anchor: std::fs::File,
    #[cfg(test)]
    ack_loss: std::sync::atomic::AtomicBool,
}
impl MemoryReviewStore {
    /// Scope is a storage binding only. Authorization belongs to the native host.
    pub fn owner(&self) -> &KnowledgeOwner {
        &self.owner
    }
    /// Host-only storage identity; it grants no resource or caller authorization.
    pub fn storage_directory_identity(&self) -> Result<String> {
        self.verify_binding()?;
        self.directory.directory_identity()
    }

    /// Explicit first initialization; an existing domain directory is never adopted.
    pub fn create(path: &Path, scope: &IntegrationScope) -> Result<Self> {
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("MEMORY_INVALID_STORE_PATH"))?,
        )?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("MEMORY_INVALID_STORE_PATH"))?;
        Self::create_in(&parent, name, scope)
    }
    /// Initialize beneath an already authenticated parent without reopening its path.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent
            .create_private_child(name)
            .map_err(|_| anyhow::anyhow!("MEMORY_STORE_CREATE_UNAVAILABLE"))?;
        let owner = KnowledgeOwner::from(scope);
        let initialized = (|| -> Result<()> {
            let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
            lock.sync_all()?;
            directory.sync()?;
            let lock_identity = directory.portable_regular_handle_identity(&lock)?;
            let binding = StoreBinding {
                version: 1,
                owner: owner.clone(),
                lock_identity,
            };
            let data = Data {
                schema_version: 1,
                owner: owner.clone(),
                next_id: 1,
                records: BTreeMap::new(),
                receipts: BTreeMap::new(),
                snapshots: BTreeMap::new(),
            };
            directory.atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&data)?)?;
            directory.atomic_replace(
                OsStr::new("memory-binding.json"),
                &serde_json::to_vec(&binding)?,
            )?;
            Ok(())
        })();
        initialized.map_err(|_| anyhow::anyhow!("MEMORY_INITIALIZATION_UNCONFIRMED"))?;
        Self::from_directory(directory, scope)
    }
    /// Pure existing-store open: missing or damaged state never becomes an empty store.
    pub fn open(path: &Path, scope: &IntegrationScope) -> Result<Self> {
        Self::from_directory(PrivateDirectory::open_existing(path)?, scope)
    }
    /// Read an existing child through held native handles; missing entries stay missing.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        parent.verify_private_directory()?;
        let entry = parent.open_entry_handle(name)?;
        Self::from_directory(entry.open_child_directory()?, scope)
    }
    fn from_directory(directory: PrivateDirectory, scope: &IntegrationScope) -> Result<Self> {
        scope.validate()?;
        directory.verify_private_directory()?;
        let owner = KnowledgeOwner::from(scope);
        let binding: StoreBinding = read_private_json(&directory, "memory-binding.json", 16 * 1024)
            .map_err(|_| anyhow::anyhow!("MEMORY_STORE_BINDING_INVALID"))?;
        ensure!(
            binding.version == 1 && binding.owner == owner,
            "MEMORY_SCOPE_MISMATCH"
        );
        let binding_anchor =
            directory.open_single_link_regular_file(OsStr::new("memory-binding.json"))?;
        let binding_identity = directory.portable_regular_handle_identity(&binding_anchor)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        ensure!(
            directory.portable_regular_handle_identity(&lock_anchor)? == binding.lock_identity,
            "MEMORY_STORE_LOCK_CHANGED"
        );
        let store = Self {
            directory,
            owner,
            binding,
            binding_identity,
            lock_anchor,
            binding_anchor,
            #[cfg(test)]
            ack_loss: std::sync::atomic::AtomicBool::new(false),
        };
        store.access(false, |_| Ok(()))?;
        Ok(store)
    }
    fn verify_binding(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory
                .portable_regular_handle_identity(&self.lock_anchor)?
                == self.binding.lock_identity,
            "MEMORY_STORE_LOCK_CHANGED"
        );
        ensure!(
            self.directory
                .portable_regular_handle_identity(&self.binding_anchor)?
                == self.binding_identity,
            "MEMORY_STORE_BINDING_CHANGED"
        );
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new("memory-binding.json"))?
                == self.binding_identity,
            "MEMORY_STORE_BINDING_CHANGED"
        );
        let current: StoreBinding =
            read_private_json(&self.directory, "memory-binding.json", 16 * 1024)?;
        ensure!(current == self.binding, "MEMORY_STORE_BINDING_CHANGED");
        ensure!(
            self.directory.portable_regular_identity(OsStr::new(LOCK))?
                == self.binding.lock_identity,
            "MEMORY_STORE_LOCK_CHANGED"
        );
        Ok(())
    }
    fn access<T>(&self, write: bool, action: impl FnOnce(&mut Data) -> Result<T>) -> Result<T> {
        self.verify_binding()?;
        let mode = if write {
            PrivateLeaseMode::Exclusive
        } else {
            PrivateLeaseMode::Shared
        };
        let _lease = self
            .directory
            .try_existing_portable_lock(OsStr::new(LOCK), &self.binding.lock_identity, mode)
            .map_err(|_| anyhow::anyhow!("MEMORY_STORE_LOCK_CHANGED"))?
            .ok_or_else(|| anyhow::anyhow!("MEMORY_BUSY"))?;
        let mut data: Data = read_private_json(&self.directory, FILE, MAX_BYTES)
            .map_err(|_| anyhow::anyhow!("MEMORY_STORE_UNAVAILABLE"))?;
        ensure!(data.schema_version == 1, "MEMORY_STORE_VERSION_UNSUPPORTED");
        ensure!(data.owner == self.owner, "MEMORY_SCOPE_MISMATCH");
        let result = action(&mut data)?;
        self.verify_binding()?;
        if write {
            let bytes = serde_json::to_vec(&data)?;
            ensure!(bytes.len() <= MAX_BYTES, "MEMORY_STORE_FULL");
            self.directory
                .atomic_replace(OsStr::new(FILE), &bytes)
                .map_err(|_| anyhow::anyhow!("MEMORY_WRITE_UNCONFIRMED"))?;
            #[cfg(test)]
            if self
                .ack_loss
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                anyhow::bail!("MEMORY_WRITE_UNCONFIRMED");
            }
            self.verify_binding()
                .map_err(|_| anyhow::anyhow!("MEMORY_WRITE_UNCONFIRMED"))?;
        }
        Ok(result)
    }
    fn replay<T: for<'de> Deserialize<'de>>(
        data: &Data,
        operation: &str,
        intent: &Value,
    ) -> Result<Option<T>> {
        validate_id(operation)?;
        match data.receipts.get(operation) {
            Some(receipt) => {
                ensure!(&receipt.intent == intent, "MEMORY_OPERATION_CONFLICT");
                Ok(Some(serde_json::from_value(receipt.result.clone())?))
            }
            None => {
                ensure!(data.receipts.len() < MAX_RECORDS, "MEMORY_RECEIPT_CAPACITY");
                Ok(None)
            }
        }
    }
    fn receipt(
        data: &mut Data,
        operation: &str,
        intent: Value,
        result: &impl Serialize,
    ) -> Result<()> {
        data.receipts.insert(
            operation.into(),
            Receipt {
                intent,
                result: serde_json::to_value(result)?,
            },
        );
        Ok(())
    }
    /// Reads only an existing single-record receipt for this exact operation and store owner.
    /// It does not replay, initialize, repair, or infer a caller scope.
    pub fn read_operation_result(&self, operation_id: &str) -> Result<Option<ReviewedMemory>> {
        validate_id(operation_id)?;
        self.access(false, |data| {
            let Some(receipt) = data.receipts.get(operation_id) else {
                return Ok(None);
            };
            let action = receipt.intent.get("action").and_then(Value::as_str);
            if !matches!(
                action,
                Some("propose" | "review" | "edit" | "set_enabled" | "remove")
            ) {
                return Ok(None);
            }
            let memory: ReviewedMemory = serde_json::from_value(receipt.result.clone())
                .map_err(|_| anyhow::anyhow!("MEMORY_RECEIPT_INVALID"))?;
            ensure!(memory.owner == self.owner, "MEMORY_SCOPE_MISMATCH");
            validate_id(&memory.id)?;
            ensure!(memory.revision > 0, "MEMORY_RECEIPT_INVALID");
            Ok(Some(memory))
        })
    }
    pub fn propose(
        &self,
        operation: &str,
        proposal: MemoryProposal,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        validate_proposal(&proposal)?;
        let intent = json!({"action":"propose","proposal":proposal});
        self.access(true, |data| {
            if let Some(result) = Self::replay(data, operation, &intent)? {
                return Ok(result);
            }
            ensure!(data.records.len() < MAX_RECORDS, "MEMORY_CAPACITY");
            let id = format!("memory-{:016x}", data.next_id);
            data.next_id = data
                .next_id
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("MEMORY_ID_EXHAUSTED"))?;
            let memory = ReviewedMemory {
                id: id.clone(),
                owner: self.owner.clone(),
                revision: 1,
                proposal,
                review_status: MemoryReviewStatus::Candidate,
                enabled: false,
                deleted: false,
                source_verified: false,
                updated_at_ms: now_ms,
            };
            data.records.insert(id, memory.clone());
            Self::receipt(data, operation, intent, &memory)?;
            Ok(memory)
        })
    }
    /// Append an entire validated extraction batch atomically; no partial candidate success.
    pub fn propose_candidates(
        &self,
        operation: &str,
        proposals: Vec<MemoryProposal>,
        now_ms: u64,
    ) -> Result<Vec<ReviewedMemory>> {
        ensure!(proposals.len() <= 32, "MEMORY_MAINTENANCE_BUDGET_EXCEEDED");
        for proposal in &proposals {
            validate_proposal(proposal)?;
        }
        let intent = json!({"action":"propose_candidates","proposals":proposals});
        self.access(true, |data| {
            if let Some(replay) = Self::replay(data, operation, &intent)? {
                return Ok(replay);
            }
            ensure!(
                data.records.len().saturating_add(proposals.len()) <= MAX_RECORDS,
                "MEMORY_CAPACITY"
            );
            ensure!(
                data.next_id.checked_add(proposals.len() as u64).is_some(),
                "MEMORY_ID_EXHAUSTED"
            );
            let mut records = Vec::new();
            for proposal in proposals {
                let id = format!("memory-{:016x}", data.next_id);
                data.next_id += 1;
                let memory = ReviewedMemory {
                    id: id.clone(),
                    owner: self.owner.clone(),
                    revision: 1,
                    proposal,
                    review_status: MemoryReviewStatus::Candidate,
                    enabled: false,
                    deleted: false,
                    source_verified: false,
                    updated_at_ms: now_ms,
                };
                data.records.insert(id, memory.clone());
                records.push(memory);
            }
            Self::receipt(data, operation, intent, &records)?;
            Ok(records)
        })
    }
    pub fn read(&self, id: &str) -> Result<ReviewedMemory> {
        validate_id(id)?;
        self.access(false, |data| {
            Ok(data
                .records
                .get(id)
                .filter(|m| !m.deleted)
                .ok_or_else(|| anyhow::anyhow!("MEMORY_NOT_FOUND"))?
                .clone())
        })
    }
    pub fn list(
        &self,
        after: Option<&str>,
        include_candidates: bool,
    ) -> Result<KnowledgePage<ReviewedMemory>> {
        if let Some(cursor) = after {
            validate_id(cursor)?;
        }
        self.access(false, |data| {
            let mut items = Vec::new();
            let mut encoded_bytes = 0usize;
            let mut has_more = false;
            for memory in data.records.values().filter(|m| {
                !m.deleted
                    && (include_candidates || m.review_status == MemoryReviewStatus::Confirmed)
                    && after.is_none_or(|cursor| m.id.as_str() > cursor)
            }) {
                let bytes = serde_json::to_vec(memory)?.len();
                ensure!(bytes <= 768 * 1024 - 4096, "MEMORY_PROPOSAL_TOO_LARGE");
                if items.len() == 10 || encoded_bytes.saturating_add(bytes) > 768 * 1024 - 4096 {
                    has_more = true;
                    break;
                }
                encoded_bytes += bytes;
                items.push(memory.clone());
            }
            let next_cursor = if has_more {
                items.last().map(|m| m.id.clone())
            } else {
                None
            };
            Ok(KnowledgePage { items, next_cursor })
        })
    }
    pub fn review(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        review: MemoryReview,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        if let MemoryReview::Accept {
            edited_content: Some(content),
        } = &review
        {
            validate_content(content)?;
        }
        let intent = json!({"action":"review","id":id,"revision":revision,"review":review});
        self.change(operation, id, revision, intent, now_ms, |m| {
            ensure!(
                m.review_status == MemoryReviewStatus::Candidate,
                "MEMORY_ALREADY_REVIEWED"
            );
            match review {
                MemoryReview::Accept { edited_content } => {
                    if let Some(content) = edited_content {
                        m.proposal.content = content;
                    }
                    m.review_status = MemoryReviewStatus::Confirmed;
                    m.enabled = true;
                }
                MemoryReview::Reject => {
                    m.review_status = MemoryReviewStatus::Rejected;
                    m.enabled = false;
                }
            }
            validate_proposal(&m.proposal)?;
            // Review confirms the user's choice, not the external source's truth.
            m.source_verified = false;
            Ok(())
        })
    }
    pub fn edit(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        content: String,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        validate_content(&content)?;
        let intent = json!({"action":"edit","id":id,"revision":revision,"content":content});
        self.change(operation, id, revision, intent, now_ms, |m| {
            m.proposal.content = content;
            validate_proposal(&m.proposal)?;
            Ok(())
        })
    }
    pub fn set_enabled(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        enabled: bool,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        let intent = json!({"action":"set_enabled","id":id,"revision":revision,"enabled":enabled});
        self.change(operation, id, revision, intent, now_ms, |m| {
            ensure!(
                !enabled || m.review_status == MemoryReviewStatus::Confirmed,
                "MEMORY_REVIEW_REQUIRED"
            );
            m.enabled = enabled;
            Ok(())
        })
    }
    pub fn remove(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        let intent = json!({"action":"remove","id":id,"revision":revision});
        self.change(operation, id, revision, intent, now_ms, |m| {
            m.deleted = true;
            m.enabled = false;
            Ok(())
        })
    }
    fn change(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        intent: Value,
        now_ms: u64,
        update: impl FnOnce(&mut ReviewedMemory) -> Result<()>,
    ) -> Result<ReviewedMemory> {
        validate_id(id)?;
        self.access(true, |data| {
            if let Some(result) = Self::replay(data, operation, &intent)? {
                return Ok(result);
            }
            let memory = data
                .records
                .get_mut(id)
                .filter(|m| !m.deleted)
                .ok_or_else(|| anyhow::anyhow!("MEMORY_NOT_FOUND"))?;
            ensure!(memory.revision == revision, "MEMORY_REVISION_CONFLICT");
            update(memory)?;
            memory.revision = memory
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("MEMORY_REVISION_EXHAUSTED"))?;
            memory.updated_at_ms = now_ms;
            let result = memory.clone();
            Self::receipt(data, operation, intent, &result)?;
            Ok(result)
        })
    }
    /// Observe only an admitted task's existing frozen input; display does not create a snapshot.
    pub fn read_task_snapshot(&self, task_id: &str) -> Result<Option<MemoryTaskSnapshot>> {
        validate_id(task_id)?;
        self.access(false, |data| Ok(data.snapshots.get(task_id).cloned()))
    }
    /// Capture once; later edits cannot reinterpret the task's original memory input.
    pub fn capture_task_snapshot(&self, task: &str, now_ms: u64) -> Result<MemoryTaskSnapshot> {
        validate_id(task)?;
        self.access(true, |data| {
            if let Some(snapshot) = data.snapshots.get(task) {
                return Ok(snapshot.clone());
            }
            ensure!(
                data.snapshots.len() < MAX_RECORDS,
                "MEMORY_SNAPSHOT_CAPACITY"
            );
            let eligible: Vec<_> = data
                .records
                .values()
                .filter(|m| {
                    !m.deleted
                        && m.enabled
                        && m.review_status == MemoryReviewStatus::Confirmed
                        && m.proposal
                            .valid_until_ms
                            .is_none_or(|expiry| expiry > now_ms)
                })
                .collect();
            let total = eligible.len();
            let mut bytes = 0usize;
            let mut memories = Vec::new();
            for memory in eligible {
                let size = serde_json::to_vec(memory)?.len();
                if memories.len() < 64 && bytes.saturating_add(size) <= 64 * 1024 {
                    bytes += size;
                    memories.push(memory.clone());
                }
            }
            let omitted_count = total - memories.len();
            let snapshot = MemoryTaskSnapshot {
                owner: self.owner.clone(),
                task_id: task.into(),
                memories,
                captured_at_ms: now_ms,
                omitted_count,
            };
            data.snapshots.insert(task.into(), snapshot.clone());
            Ok(snapshot)
        })
    }
}
fn read_private_json<T: for<'de> Deserialize<'de>>(
    directory: &PrivateDirectory,
    name: &str,
    max: usize,
) -> Result<T> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= max as u64,
        "PRIVATE_DOMAIN_RECORD_TOO_LARGE"
    );
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "PRIVATE_DOMAIN_RECORD_TOO_LARGE");
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.trim().is_empty() && id.chars().count() <= 256,
        "MEMORY_INVALID_ID"
    );
    Ok(())
}
fn validate_content(content: &str) -> Result<()> {
    ensure!(
        !content.trim().is_empty() && content.len() <= 8192,
        "MEMORY_INVALID_CONTENT"
    );
    let lower = content.to_lowercase();
    for marker in [
        "bearer ",
        "ghp_",
        "-----begin private key",
        "api_key=",
        "api-key:",
    ] {
        if lower.contains(marker) {
            bail!("MEMORY_SENSITIVE_CONTENT");
        }
    }
    Ok(())
}
fn validate_proposal(proposal: &MemoryProposal) -> Result<()> {
    ensure!(
        serde_json::to_vec(proposal)?.len() <= 64 * 1024,
        "MEMORY_PROPOSAL_TOO_LARGE"
    );
    validate_content(&proposal.content)?;
    ensure!(
        !proposal.title.trim().is_empty() && proposal.title.len() <= 512,
        "MEMORY_INVALID_TITLE"
    );
    ensure!(
        !proposal.category.trim().is_empty() && proposal.category.len() <= 128,
        "MEMORY_INVALID_CATEGORY"
    );
    ensure!(
        !proposal.provenance.is_empty() && proposal.provenance.len() <= 32,
        "MEMORY_SOURCE_REQUIRED"
    );
    for source in &proposal.provenance {
        validate_id(&source.source_id)?;
        validate_id(&source.source_revision)?;
        ensure!(
            source.kind.len() <= 128 && source.description.len() <= 2048,
            "MEMORY_INVALID_SOURCE"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
