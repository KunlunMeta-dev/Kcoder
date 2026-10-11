//! Private authority records. Public receipt projections never grant mutation authority.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    RetentionReceiptV1, RetentionReleaseReasonV1, TrustedRetentionContextV1,
    WorkspaceParentAccountV2,
};
use kcoder_types::PrivateFileIdentityV1;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const RECORD_BYTES: u64 = 65_536;
pub(super) const INDEX_PAGE_SIZE: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Limits {
    pub owners: u64,
    pub entries: u64,
    pub receipt_slots: u64,
    pub entry_bytes: u64,
    pub owner_bytes: u64,
    pub staged_bytes: u64,
    pub transfer_bytes: u64,
    pub pending_uploads_per_owner: usize,
    pub entries_per_owner: usize,
    pub metadata_bytes: u64,
    pub tombstones: u64,
    pub tombstone_bytes: u64,
    pub owner_proofs: u64,
    pub epoch_allocations: u64,
    pub epochs: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            owners: 64,
            entries: 16_384,
            receipt_slots: 4096,
            entry_bytes: 100 * 1024 * 1024,
            owner_bytes: 200 * 1024 * 1024,
            staged_bytes: 1024 * 1024 * 1024,
            transfer_bytes: 1024 * 1024 * 1024,
            pending_uploads_per_owner: 4,
            entries_per_owner: 32,
            metadata_bytes: 64 * 1024 * 1024,
            tombstones: 65_536,
            tombstone_bytes: 16 * 1024 * 1024,
            owner_proofs: 4096,
            epoch_allocations: 4096,
            epochs: 8,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<()> {
        let max = Self::default();
        ensure!(
            self.owners > 0
                && self.owners <= max.owners
                && self.entries > 0
                && self.entries <= max.entries
                && self.receipt_slots > 0
                && self.receipt_slots <= max.receipt_slots
                && self.entry_bytes > 0
                && self.entry_bytes <= max.entry_bytes
                && self.owner_bytes >= self.entry_bytes
                && self.owner_bytes <= max.owner_bytes
                && self.staged_bytes >= self.entry_bytes
                && self.staged_bytes <= max.staged_bytes
                && self.transfer_bytes > 0
                && self.transfer_bytes <= max.transfer_bytes
                && self.pending_uploads_per_owner > 0
                && self.pending_uploads_per_owner <= 4
                && self.entries_per_owner > 0
                && self.entries_per_owner <= 32
                && self.metadata_bytes >= RECORD_BYTES * 3
                && self.metadata_bytes <= max.metadata_bytes
                && self.tombstones > 0
                && self.tombstones <= max.tombstones
                && self.tombstone_bytes > 0
                && self.tombstone_bytes <= max.tombstone_bytes
                && self.owner_proofs > 0
                && self.owner_proofs <= max.owner_proofs
                && self.epoch_allocations > 0
                && self.epoch_allocations <= 4096
                && self.epochs > 0
                && self.epochs <= 8,
            "invalid retention budgets"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Header {
    pub version: u8,
    pub namespace: String,
    pub identity: PrivateFileIdentityV1,
    pub lock_identity: PrivateFileIdentityV1,
    pub areas: BTreeMap<Area, PrivateFileIdentityV1>,
    pub limits: Limits,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Area {
    Owners,
    Entries,
    Uploads,
    Intents,
    Receipts,
    Consumed,
    Index,
    Data,
    Leases,
}
impl Area {
    pub const ALL: [Self; 9] = [
        Self::Owners,
        Self::Entries,
        Self::Uploads,
        Self::Intents,
        Self::Receipts,
        Self::Consumed,
        Self::Index,
        Self::Data,
        Self::Leases,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Owners => "owners",
            Self::Entries => "entries",
            Self::Uploads => "uploads",
            Self::Intents => "intents",
            Self::Receipts => "receipts",
            Self::Consumed => "consumed",
            Self::Index => "index",
            Self::Data => "data",
            Self::Leases => "leases",
        }
    }
    pub fn records(self) -> bool {
        !matches!(self, Self::Data | Self::Leases)
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Charges {
    pub owners: u64,
    pub entries: u64,
    pub receipt_slots: u64,
    pub staged_bytes: u64,
    pub transfer_bytes: u64,
    pub metadata_bytes: u64,
    pub tombstones: u64,
    pub tombstone_bytes: u64,
    pub owner_proofs: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cleanup_metadata_bytes: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub prepaid_tombstones: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub prepaid_tombstone_bytes: u64,
}
fn is_zero(value: &u64) -> bool {
    *value == 0
}
impl Charges {
    pub fn validate(&self, limits: &Limits) -> Result<()> {
        ensure!(
            self.owners <= limits.owners && self.entries <= limits.entries
            && self.receipt_slots <= limits.receipt_slots && self.staged_bytes <= limits.staged_bytes
            && self.transfer_bytes <= limits.transfer_bytes
            // Keep room for the bounded redo journal and its atomic replacement.
            && self.metadata_bytes.checked_add(self.cleanup_metadata_bytes)
                .is_some_and(|total| total <= limits.metadata_bytes - 2 * RECORD_BYTES)
            && self.tombstones.checked_add(self.prepaid_tombstones).is_some_and(|total| total <= limits.tombstones)
            && self.tombstone_bytes.checked_add(self.prepaid_tombstone_bytes).is_some_and(|total| total <= limits.tombstone_bytes)
            && self.owner_proofs <= limits.owner_proofs,
            super::RetentionFailure::Capacity
        );
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(Default)]
pub(super) struct Epoch {
    pub allocations: u64,
    pub closing: bool,
    pub nonterminal_allocations: u64,
    pub unconsumed_references: u64,
    pub records: u64,
    pub gc_cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct State {
    pub version: u8,
    pub namespace: String,
    pub revision: u64,
    pub current_epoch: u64,
    pub retired_through: u64,
    pub epochs: BTreeMap<u64, Epoch>,
    pub charges: Charges,
}
impl State {
    pub fn new(namespace: String) -> Self {
        Self {
            version: 1,
            namespace,
            revision: 0,
            current_epoch: 1,
            retired_through: 0,
            epochs: [(1, Epoch::default())].into(),
            charges: Charges::default(),
        }
    }
    pub fn allocate(&mut self, limits: &Limits) -> Result<u64> {
        let current = self
            .epochs
            .get_mut(&self.current_epoch)
            .expect("validated current epoch");
        if current.allocations >= limits.epoch_allocations || current.closing {
            current.closing = true;
            ensure!(
                self.epochs.len() < limits.epochs,
                super::RetentionFailure::Capacity
            );
            self.current_epoch = self
                .current_epoch
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("epoch overflow"))?;
            self.epochs.insert(self.current_epoch, Epoch::default());
        }
        let current = self
            .epochs
            .get_mut(&self.current_epoch)
            .expect("inserted epoch");
        current.allocations += 1;
        current.nonterminal_allocations += 1;
        Ok(self.current_epoch)
    }
    pub fn upload_admission_epoch(&self, limits: &Limits) -> Result<u64> {
        let current = self
            .epochs
            .get(&self.current_epoch)
            .context("upload epoch missing")?;
        if !current.closing
            && current
                .allocations
                .checked_add(2)
                .is_some_and(|n| n <= limits.epoch_allocations)
        {
            return Ok(self.current_epoch);
        }
        ensure!(
            self.epochs.len() < limits.epochs && limits.epoch_allocations >= 2,
            super::RetentionFailure::Capacity
        );
        self.current_epoch
            .checked_add(1)
            .context("retention epoch overflow")
    }
    pub fn allocate_requested(&mut self, requested: u64, limits: &Limits) -> Result<u64> {
        let eligible = if requested == self.current_epoch {
            self.current_epoch
        } else {
            self.upload_admission_epoch(limits)?
        };
        // The second allocation in an atomic owner+entry transaction can spend
        // the final slot in the epoch it has just selected.
        ensure!(
            requested > self.retired_through
                && (requested == self.current_epoch || requested == eligible),
            super::RetentionFailure::Conflict
        );
        if requested != self.current_epoch {
            self.epochs
                .get_mut(&self.current_epoch)
                .context("upload epoch missing")?
                .closing = true;
            self.current_epoch = requested;
            self.epochs.insert(requested, Epoch::default());
        }
        let epoch = self
            .epochs
            .get_mut(&requested)
            .context("upload epoch missing")?;
        ensure!(
            !epoch.closing && epoch.allocations < limits.epoch_allocations,
            super::RetentionFailure::Capacity
        );
        epoch.allocations += 1;
        epoch.nonterminal_allocations += 1;
        Ok(requested)
    }
    pub fn validate(&self, header: &Header) -> Result<()> {
        ensure!(
            self.version == 1
                && self.namespace == header.namespace
                && self.current_epoch > self.retired_through
                && self.epochs.contains_key(&self.current_epoch)
                && self.epochs.len() <= header.limits.epochs + 1,
            "invalid retention epoch state"
        );
        for (id, epoch) in &self.epochs {
            ensure!(
                *id <= self.current_epoch
                    && epoch.allocations <= header.limits.epoch_allocations
                    && epoch.nonterminal_allocations <= epoch.allocations
                    && epoch.gc_cursor <= epoch.records
                    && epoch.records <= epoch.allocations.saturating_mul(8),
                "invalid retention epoch counts"
            );
        }
        self.charges.validate(&header.limits)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::app_server) struct Scope {
    pub context: TrustedRetentionContextV1,
    pub workspace_identity: String,
    pub hash: String,
    #[serde(
        default = "legacy_scope_version",
        skip_serializing_if = "is_legacy_scope"
    )]
    pub version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_account: Option<WorkspaceParentAccountV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_target_id: Option<String>,
}
fn legacy_scope_version() -> u8 {
    1
}
fn is_legacy_scope(value: &u8) -> bool {
    *value == 1
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum OwnerPhase {
    Allocating,
    Publishing,
    Active,
    Retiring,
    Quarantined,
    PayloadGone,
    Retired,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Owner {
    pub id: String,
    pub epoch: u64,
    pub scope: Scope,
    pub phase: OwnerPhase,
    pub data_identity: Option<PrivateFileIdentityV1>,
    pub marker_identity: Option<PrivateFileIdentityV1>,
    pub lease_directory_identity: Option<PrivateFileIdentityV1>,
    pub lease_identity: Option<PrivateFileIdentityV1>,
    pub entries: Vec<String>,
    pub bytes: u64,
    pub retirement: Option<OwnerRetirement>,
    #[serde(
        default = "legacy_owner_layout",
        skip_serializing_if = "is_legacy_owner_layout"
    )]
    pub layout_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<OwnerRequestBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<OwnerManifestV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_retirement: Option<RemovalPhase>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cleanup_capacity: u64,
}
fn legacy_owner_layout() -> u8 {
    1
}
fn is_legacy_owner_layout(version: &u8) -> bool {
    *version == 1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerRequestBinding {
    pub client_request_id: String,
    pub params_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerManifestPayloadV2 {
    pub version: u8,
    pub namespace: String,
    pub owner_id: String,
    pub epoch: u64,
    pub scope_hash: String,
    pub lease_parent: PrivateFileIdentityV1,
    pub inode: PrivateFileIdentityV1,
    pub mode: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerManifestFileV2 {
    pub payload: OwnerManifestPayloadV2,
    pub payload_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerManifestV2 {
    pub payload: OwnerManifestPayloadV2,
    pub payload_sha256: String,
    pub file_sha256: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum RemovalPhase {
    RenamePending,
    Quarantined,
    LeavesGone,
    Gone,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerRetirement {
    pub data: RemovalPhase,
    pub lease: RemovalPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum EntryPhase {
    Allocating,
    Sealing,
    Sealed,
    Ready,
    Materializing,
    Copied,
    ReleasePending,
    RenamePending,
    Quarantined,
    PayloadGone,
    Released,
    Transferred,
    Cancelled,
    Unknown,
}
impl EntryPhase {
    pub fn physical_terminal(self) -> bool {
        matches!(self, Self::Released | Self::Transferred | Self::Cancelled)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TransferBinding {
    pub thread_id: String,
    pub client_message_id: String,
    pub attempt_id: String,
    pub input_sha256: String,
    pub artifact_identity: PrivateFileIdentityV1,
    pub artifact_sha256: String,
    pub artifact_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    pub id: String,
    pub owner_id: String,
    pub epoch: u64,
    pub scope_hash: String,
    pub client_upload_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload: Option<UploadProgress>,
    pub params_hash: String,
    pub size: u64,
    pub content_sha256: String,
    pub phase: EntryPhase,
    pub revision: u64,
    pub directory_identity: Option<PrivateFileIdentityV1>,
    pub payload_identity: Option<PrivateFileIdentityV1>,
    pub retention_id: Option<String>,
    pub quarantine: String,
    pub transfer: Option<TransferBinding>,
    /// A maximum-size metadata slot prepaid before physical publication.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cleanup_capacity: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UploadIndex {
    pub scope_hash: String,
    pub owner_id: String,
    pub entry_id: String,
    pub params_hash: String,
    pub epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub scope_hash: String,
    pub client_request_id: String,
    pub retention_id: String,
    pub params_hash: String,
    pub epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub scope_hash: String,
    pub epoch: u64,
    pub referenced_epochs: Vec<u64>,
    pub wire: RetentionReceiptV1,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cleanup_capacity: u64,
    /// Covers one consume tombstone and one catalog page (each RECORD_BYTES).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub terminal_budget: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_intent: Option<ReleaseIntent>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReleaseIntent {
    pub expected_revision: u64,
    pub reason: RetentionReleaseReasonV1,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tombstone {
    pub scope_hash: String,
    pub retention_id: String,
    pub revision: u64,
    pub client_ack_id: String,
    pub epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Locator {
    pub area: Area,
    pub leaf: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IndexPage {
    pub records: Vec<Locator>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingUploadChunk {
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UploadProgress {
    #[serde(default, skip_serializing_if = "UploadStorageLayout::is_directory")]
    pub storage_layout: UploadStorageLayout,
    pub filename: String,
    pub confirmed_bytes: u64,
    pub pending: Option<PendingUploadChunk>,
    /// Identity of an unpublished empty inode, durable before publishing payload.
    pub payload_publishing: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum UploadStorageLayout {
    #[default]
    DirectoryV1,
    RootLeafV1,
}
impl UploadStorageLayout {
    fn is_directory(&self) -> bool {
        *self == Self::DirectoryV1
    }
}
impl Entry {
    pub(super) fn storage_layout(&self) -> UploadStorageLayout {
        self.upload
            .as_ref()
            .map_or(UploadStorageLayout::DirectoryV1, |progress| {
                progress.storage_layout
            })
    }
    pub(super) fn upload_leaf(&self) -> String {
        format!("u-entry-{}", self.id)
    }
}
