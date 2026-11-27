use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::cross_session_messages::*;
use serde::{Deserialize, Serialize};
#[path = "store/admission.rs"]
mod admission;
mod archive;
#[path = "store/cold_targets.rs"]
mod cold_targets;
mod idle_handoff;
pub use idle_handoff::{
    COLD_WAKE_DEFERRED_REASONS, ColdWakeIdleHint, ColdWakeIdleObservation, PendingColdWake,
};
#[path = "store/idle_wake.rs"]
mod idle_wake;
#[path = "store/peer_wake_budget.rs"]
mod peer_wake_budget;
use crate::peer_wake_budget::{PeerWakeBudgetRecord, PeerWakeClaimMarker};
pub use archive::{CrossSessionReceiptBinding, OriginalReceiptQuery};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
};

const HEADER: &str = "message-owner.json";
const LOCK: &str = "messages.lock";
const DATA: &str = "messages.json";
const MAX_DATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MESSAGES: usize = 128;
const READ_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug)]
struct ReceiptReadBusy;
impl std::fmt::Display for ReceiptReadBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AGENT_MESSAGE_READ_BUSY")
    }
}
impl std::error::Error for ReceiptReadBusy {}

mod maintenance;
pub use maintenance::CrossSessionMessageMaintenance;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    scope: CrossSessionMessageScope,
    directory: String,
    lock: PortableLeaseIdentity,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reservation {
    nonce: String,
    fence: u64,
    deadline_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMessage {
    source: CrossSessionMessageSource,
    intent: AgentMessageIntent,
    receipt: AgentMessageReceipt,
    sequence: u64,
    #[serde(default)]
    created_at_ms: u64,
    #[serde(default)]
    expires_at_ms: Option<u64>,
    #[serde(default)]
    terminal_at_ms: Option<u64>,
    #[serde(default)]
    namespace_id: String,
    #[serde(default)]
    history_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    peer_wake_claim: Option<PeerWakeClaimMarker>,
    reservation: Option<Reservation>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u32,
    scope: CrossSessionMessageScope,
    revision: u64,
    last_sequence: u64,
    messages: BTreeMap<String, StoredMessage>,
    #[serde(default)]
    peer_wake_budgets: BTreeMap<String, PeerWakeBudgetRecord>,
    #[serde(default)]
    peer_wake_archived_claims: BTreeMap<String, archive::ArchivedWakeClaims>,
    #[serde(default)]
    archive_clock_ms: u64,
    #[serde(default)]
    wake_grace_deadlines: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    peer_idle_wakes: BTreeMap<String, crate::peer_agent_history::PeerIdleWakeAdmission>,
}

/// A private payload for a host that has already established current access.
#[derive(Debug, Clone)]
pub struct CrossSessionMessageRecord {
    pub source: CrossSessionMessageSource,
    pub intent: AgentMessageIntent,
    pub receipt: AgentMessageReceipt,
    pub sequence: u64,
    pub created_at_ms: u64,
    pub namespace_id: String,
}
impl From<&StoredMessage> for CrossSessionMessageRecord {
    fn from(value: &StoredMessage) -> Self {
        Self {
            source: value.source.clone(),
            intent: value.intent.clone(),
            receipt: value.receipt.clone(),
            sequence: value.sequence,
            created_at_ms: value.created_at_ms,
            namespace_id: value.namespace_id.clone(),
        }
    }
}

/// In-process reservation identity, never serializable or accepted from a caller.
/// Expiry permits reconciliation only, not a second attempt to insert history.
pub struct CrossSessionDeliveryLease {
    directory: String,
    message_id: String,
    reservation: Reservation,
    record: CrossSessionMessageRecord,
    history_claimed: std::sync::atomic::AtomicBool,
    writer_attempted: std::sync::atomic::AtomicBool,
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PeerDeliveryCommitIdentity {
    directory: String,
    message_id: String,
    reservation: Reservation,
}
impl CrossSessionDeliveryLease {
    pub fn record(&self) -> &CrossSessionMessageRecord {
        &self.record
    }
    pub(crate) fn claim_history_attempt(&self) -> Result<()> {
        ensure!(
            self.history_claimed
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire
                )
                .is_ok(),
            "PEER_HISTORY_LEASE_ALREADY_ATTEMPTED"
        );
        Ok(())
    }
    pub(crate) fn mark_writer_attempted(&self) {
        self.writer_attempted
            .store(true, std::sync::atomic::Ordering::Release);
    }
    pub(crate) fn writer_never_attempted(&self) -> bool {
        self.history_claimed
            .load(std::sync::atomic::Ordering::Acquire)
            && !self
                .writer_attempted
                .load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn commit_identity(&self) -> PeerDeliveryCommitIdentity {
        PeerDeliveryCommitIdentity {
            directory: self.directory.clone(),
            message_id: self.message_id.clone(),
            reservation: self.reservation.clone(),
        }
    }
}

/// A cheap wake-up hint only. This does not prove queue validity, authorization,
/// revocation status or that any message can be delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossSessionMessageObservationStamp {
    namespace: String,
    file: PortableLeaseIdentity,
    bytes: u64,
    modified: std::time::SystemTime,
    manifest: Option<(PortableLeaseIdentity, u64, std::time::SystemTime)>,
}

pub struct CrossSessionMessageStore {
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
    maintenance_hint: std::sync::Mutex<Option<maintenance::MaintenanceHint>>,
    archive_hint: std::sync::Mutex<Option<archive::ArchiveHint>>,
    #[cfg(test)]
    reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    body_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    writes: std::sync::atomic::AtomicUsize,
}

fn bounded_read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(file.metadata()?.len() <= limit, "AGENT_MESSAGE_DATA_LIMIT");
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "AGENT_MESSAGE_DATA_LIMIT");
    Ok(bytes)
}
fn request_key(source: &CrossSessionMessageSource, id: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(source, id))?)
    ))
}
fn next_revision(data: &Data) -> Result<u64> {
    data.revision
        .checked_add(1)
        .context("AGENT_MESSAGE_REVISION_OVERFLOW")
}
fn revision_is(data: &Data, expected: u64) -> Result<()> {
    ensure!(data.revision == expected, "AGENT_MESSAGE_REVISION_CHANGED");
    Ok(())
}
impl CrossSessionMessageStore {
    /// An explicit authorized initialization. Incomplete existing directories are never overwritten.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &CrossSessionMessageScope,
    ) -> Result<Self> {
        scope.validate().map_err(anyhow::Error::msg)?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            version: 1,
            scope: scope.clone(),
            directory: directory.directory_identity()?,
            lock: directory.portable_regular_handle_identity(&lock)?,
        };
        let data = Data {
            version: 1,
            scope: scope.clone(),
            revision: 1,
            last_sequence: 0,
            messages: BTreeMap::new(),
            peer_wake_budgets: BTreeMap::new(),
            peer_wake_archived_claims: BTreeMap::new(),
            archive_clock_ms: 0,
            wake_grace_deadlines: BTreeMap::new(),
            peer_idle_wakes: BTreeMap::new(),
        };
        directory.atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        Self::bind(parent, name, directory, scope)
    }

    /// Pure observation: absent, unreadable, damaged and future formats remain distinct.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &CrossSessionMessageScope,
    ) -> Result<Option<Self>> {
        scope.validate().map_err(anyhow::Error::msg)?;
        parent.verify_private_directory()?;
        let entry = match parent.open_entry_handle(name) {
            Ok(value) => value,
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
        scope: &CrossSessionMessageScope,
    ) -> Result<Self> {
        let header: Header = serde_json::from_slice(&bounded_read(&directory, HEADER, 8192)?)?;
        ensure!(
            header.version == 1 && header.scope == *scope,
            "AGENT_MESSAGE_OWNER_MISMATCH"
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
            maintenance_hint: std::sync::Mutex::new(None),
            archive_hint: std::sync::Mutex::new(None),
            #[cfg(test)]
            reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            body_reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            writes: std::sync::atomic::AtomicUsize::new(0),
        };
        store.access(false, |_| Ok(((), false)))?;
        Ok(store)
    }

    fn read(&self, name: &str, limit: u64) -> Result<Vec<u8>> {
        #[cfg(test)]
        self.reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        #[cfg(test)]
        if name == DATA {
            self.body_reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        bounded_read(&self.directory, name, limit)
    }
    fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        let actual = self
            .parent
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        let header: Header = serde_json::from_slice(&self.read(HEADER, 8192)?)?;
        ensure!(
            header == self.header
                && actual.directory_identity()? == self.directory.directory_identity()?
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
            "AGENT_MESSAGE_NAMESPACE_CHANGED"
        );
        Ok(())
    }
    fn lease(&self, write: bool) -> Result<VerifiedPrivateLease> {
        let deadline = std::time::Instant::now() + READ_LOCK_WAIT;
        loop {
            let lease = self.try_lease(write)?;
            if let Some(lease) = lease {
                return Ok(lease);
            }
            ensure!(!write, "AGENT_MESSAGE_BUSY");
            if std::time::Instant::now() >= deadline {
                return Err(ReceiptReadBusy.into());
            }
            // Callers already execute storage access on owned blocking workers.
            // Only acquisition waits; no action, mutation or allow verdict repeats.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    fn try_lease(&self, write: bool) -> Result<Option<VerifiedPrivateLease>> {
        self.verify()?;
        let lease = self.directory.try_existing_portable_lock(
            OsStr::new(LOCK),
            &self.header.lock,
            if write {
                PrivateLeaseMode::Exclusive
            } else {
                PrivateLeaseMode::Shared
            },
        )?;
        if lease.is_some() {
            self.verify()?;
        }
        Ok(lease)
    }
    pub fn is_temporary_read_contention(error: &anyhow::Error) -> bool {
        error.is::<ReceiptReadBusy>()
            || error.chain().any(|cause| {
                cause.downcast_ref::<rusqlite::Error>().is_some_and(|error| {
                    matches!(error,
                        rusqlite::Error::SqliteFailure(code, _) if matches!(code.code,
                            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
                })
            })
    }
    fn access<R>(
        &self,
        write: bool,
        action: impl FnOnce(&mut Data) -> Result<(R, bool)>,
    ) -> Result<R> {
        self.access_observed(write, false, action)
            .map(|(result, _)| result)
    }
    fn access_observed<R>(
        &self,
        write: bool,
        observe: bool,
        action: impl FnOnce(&mut Data) -> Result<(R, bool)>,
    ) -> Result<(R, Option<CrossSessionMessageObservationStamp>)> {
        self.access_with_archive_observed(write, observe, |data, _| action(data))
    }
    fn validate_data(&self, data: &Data) -> Result<()> {
        self.validate_peer_wake_budgets(data)?;
        self.validate_idle_wakes(data)?;
        ensure!(
            data.version == 1
                && data.scope == self.header.scope
                && data.revision > 0
                && data.messages.len() <= MAX_MESSAGES * 2
                && data
                    .messages
                    .values()
                    .filter(|row| archive::is_pending(row.receipt.status))
                    .count()
                    <= MAX_MESSAGES
                && data.wake_grace_deadlines.len() <= 4096,
            "AGENT_MESSAGE_DATA_INVALID"
        );
        let mut sequences = std::collections::BTreeSet::new();
        let mut ids = std::collections::BTreeSet::new();
        for (key, value) in &data.messages {
            ensure!(value.expires_at_ms.is_none_or(|deadline| value.created_at_ms > 0
                && deadline > value.created_at_ms
                && deadline - value.created_at_ms <= u64::from(kcoder_config::CrossSessionMessagesSettings::MAX_MESSAGE_TTL_SECONDS) * 1000),
                "AGENT_MESSAGE_EXPIRY_INVALID");
            value.source.validate().map_err(anyhow::Error::msg)?;
            value.intent.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                value
                    .intent
                    .target_address
                    .as_ref()
                    .is_none_or(|address| address.target_id == self.header.scope.target_id
                        && address.workspace_id == self.header.scope.workspace_id),
                "AGENT_MESSAGE_DESTINATION_SCOPE_MISMATCH"
            );
            ensure!(
                key == &request_key(&value.source, &value.intent.client_message_id)?
                    && (value.namespace_id.is_empty()
                        || value.namespace_id == self.header.directory)
                    && !same_peer_session(&value.source, &value.intent)
                        .map_err(anyhow::Error::msg)?
                    && value.receipt.client_message_id == value.intent.client_message_id
                    && value.receipt.target_thread_id == value.intent.target_thread_id
                    && value.receipt.source_address == value.source.address
                    && value.receipt.target_address == value.intent.target_address
                    && value.receipt.reply_to_message_id == value.intent.reply_to_message_id
                    && valid_agent_message_id(&value.receipt.message_id)
                    && value.sequence > 0
                    && value.sequence <= data.last_sequence
                    && sequences.insert(value.sequence)
                    && ids.insert(value.receipt.message_id.clone())
                    && value.receipt.revision > 0
                    && value.receipt.revision <= data.revision,
                "AGENT_MESSAGE_DATA_INVALID"
            );
            match (&value.receipt.status, &value.reservation) {
                (
                    AgentMessageStatus::Queued
                    | AgentMessageStatus::Rejected
                    | AgentMessageStatus::Expired,
                    None,
                ) => {
                    ensure!(value.history_uuid.is_none(), "AGENT_MESSAGE_DATA_INVALID");
                }
                (AgentMessageStatus::Applied, Some(_)) => {
                    let record = CrossSessionMessageRecord::from(value);
                    ensure!(
                        value.history_uuid.as_deref()
                            == Some(
                                crate::peer_agent_history::peer_history_uuid(&record)?.as_str()
                            ),
                        "AGENT_MESSAGE_HISTORY_BINDING_INVALID"
                    );
                }
                (
                    AgentMessageStatus::Delivering | AgentMessageStatus::Unknown,
                    Some(reservation),
                ) => {
                    ensure!(
                        valid_agent_message_id(&reservation.nonce)
                            && reservation.fence > 0
                            && reservation.fence <= value.receipt.revision
                            && reservation.deadline_ms > 0,
                        "AGENT_MESSAGE_DATA_INVALID"
                    );
                }
                _ => anyhow::bail!("AGENT_MESSAGE_UNSUPPORTED_TRANSITION"),
            }
        }
        Ok(())
    }
    /// Inspect only the held directory and one no-follow data leaf. Real
    /// delivery always runs the original namespace and current-access checks.
    pub fn observation_stamp(&self) -> Result<CrossSessionMessageObservationStamp> {
        let file = self
            .directory
            .open_single_link_regular_file(OsStr::new(DATA))?;
        let metadata = file.metadata()?;
        ensure!(metadata.len() <= MAX_DATA_BYTES, "AGENT_MESSAGE_DATA_LIMIT");
        self.archive_observation_stamp(&file, &metadata)
    }

    pub fn revision(&self) -> Result<u64> {
        self.access(false, |data| Ok((data.revision, false)))
    }
    pub fn enqueue(
        &self,
        source: &CrossSessionMessageSource,
        intent: AgentMessageIntent,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        self.enqueue_with_ttl_seconds(
            source,
            intent,
            expected_revision,
            kcoder_config::CrossSessionMessagesSettings::DEFAULT_MESSAGE_TTL_SECONDS,
        )
    }
    /// The actual destination supplies its User policy, never a message field.
    /// An existing operation keeps its original deadline and receipt.
    pub fn enqueue_with_ttl_seconds(
        &self,
        source: &CrossSessionMessageSource,
        intent: AgentMessageIntent,
        expected_revision: u64,
        ttl_seconds: u32,
    ) -> Result<AgentMessageReceipt> {
        self.enqueue_with_admission(source, intent, expected_revision, ttl_seconds, || Ok(None))
    }
    /// Query within the original source identity. This never reads target history.
    pub fn get_by_client_id(
        &self,
        source: &CrossSessionMessageSource,
        client_message_id: &str,
    ) -> Result<Option<AgentMessageReceipt>> {
        source.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            valid_agent_message_id(client_message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        let key = request_key(source, client_message_id)?;
        self.access_with_archive(false, |data, archive| {
            let receipt = if let Some(value) = data.messages.get(&key) {
                Some(value.receipt.clone())
            } else {
                archive
                    .map(|tx| self.terminal_by_key(tx, &key))
                    .transpose()?
                    .flatten()
                    .map(|terminal| terminal.receipt())
            };
            Ok((receipt, false))
        })
    }

    /// Reserve the oldest unresolved message for one target. Unknown outcomes block later messages.
    /// This identity is not authority to touch native history or start a target.
    pub fn reserve_next(
        &self,
        target_thread_id: &str,
        expected_revision: u64,
        now_ms: u64,
        deadline_ms: u64,
    ) -> Result<Option<CrossSessionDeliveryLease>> {
        ensure!(
            valid_agent_message_id(target_thread_id)
                && deadline_ms > now_ms
                && deadline_ms - now_ms <= 60_000,
            "AGENT_MESSAGE_LEASE_INVALID"
        );
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let key = data
                .messages
                .iter()
                .filter(|(_, value)| {
                    value.intent.target_thread_id == target_thread_id
                        && matches!(
                            value.receipt.status,
                            AgentMessageStatus::Queued
                                | AgentMessageStatus::Delivering
                                | AgentMessageStatus::Unknown
                        )
                })
                .min_by_key(|(_, value)| value.sequence)
                .map(|(key, _)| key.clone());
            let Some(key) = key else {
                return Ok((None, false));
            };
            ensure!(
                data.messages[&key].receipt.status == AgentMessageStatus::Queued,
                "AGENT_MESSAGE_RECONCILIATION_REQUIRED"
            );
            let revision = next_revision(data)?;
            let reservation = Reservation {
                nonce: uuid::Uuid::new_v4().to_string(),
                fence: revision,
                deadline_ms,
            };
            let value = data
                .messages
                .get_mut(&key)
                .expect("oldest message remains in locked snapshot");
            if value
                .expires_at_ms
                .is_some_and(|deadline| now_ms >= deadline)
            {
                value.receipt.status = AgentMessageStatus::Expired;
                value.terminal_at_ms = Some(crate::now_millis());
                value.receipt.reason_code = Some("message_expired".into());
                value.receipt.revision = revision;
                data.revision = revision;
                return Ok((None, true));
            }
            if value.created_at_ms == 0 || value.namespace_id.is_empty() {
                value.receipt.status = AgentMessageStatus::Unknown;
                value.receipt.reason_code = Some(
                    if value.created_at_ms == 0 {
                        "legacy_message_time_unknown"
                    } else {
                        "message_namespace_unknown"
                    }
                    .into(),
                );
                value.receipt.revision = revision;
                value.reservation = Some(reservation);
                data.revision = revision;
                return Ok((None, true));
            }
            value.receipt.status = AgentMessageStatus::Delivering;
            value.receipt.reason_code = None;
            value.receipt.revision = revision;
            value.reservation = Some(reservation.clone());
            data.revision = revision;
            Ok((
                Some(CrossSessionDeliveryLease {
                    directory: self.header.directory.clone(),
                    message_id: value.receipt.message_id.clone(),
                    reservation,
                    record: CrossSessionMessageRecord::from(&*value),
                    history_claimed: std::sync::atomic::AtomicBool::new(false),
                    writer_attempted: std::sync::atomic::AtomicBool::new(false),
                }),
                true,
            ))
        })
    }
    pub fn mark_unknown(
        &self,
        lease: &CrossSessionDeliveryLease,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            lease.directory == self.header.directory,
            "AGENT_MESSAGE_LEASE_MISMATCH"
        );
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let revision = next_revision(data)?;
            let value = data
                .messages
                .values_mut()
                .find(|value| value.receipt.message_id == lease.message_id)
                .context("AGENT_MESSAGE_LEASE_MISMATCH")?;
            ensure!(
                value.receipt.status == AgentMessageStatus::Delivering
                    && value.reservation.as_ref() == Some(&lease.reservation),
                "AGENT_MESSAGE_LEASE_MISMATCH"
            );
            value.receipt.status = AgentMessageStatus::Unknown;
            value.receipt.reason_code = Some("delivery_result_unknown".into());
            value.receipt.revision = revision;
            data.revision = revision;
            Ok((value.receipt.clone(), true))
        })
    }
    /// A fresh lease can return to FIFO only with an opaque State proof that
    /// this one-shot attempt never reached its writer and had no earlier row.
    pub fn defer_unstarted(
        &self,
        lease: &CrossSessionDeliveryLease,
        proof: &crate::peer_agent_history::PeerHistoryNoWriteWitness,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            lease.directory == self.header.directory,
            "AGENT_MESSAGE_LEASE_MISMATCH"
        );
        proof.matches_delivery(lease)?;
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            proof.matches_delivery(lease)?;
            let revision = next_revision(data)?;
            let value = data
                .messages
                .values_mut()
                .find(|value| value.receipt.message_id == lease.message_id)
                .context("AGENT_MESSAGE_LEASE_MISMATCH")?;
            ensure!(
                value.receipt.status == AgentMessageStatus::Delivering
                    && value.reservation.as_ref() == Some(&lease.reservation),
                "AGENT_MESSAGE_LEASE_MISMATCH"
            );
            value.receipt.status = AgentMessageStatus::Queued;
            value.receipt.reason_code = Some("delivery_deferred_before_history".into());
            value.receipt.revision = revision;
            value.reservation = None;
            data.revision = revision;
            Ok((value.receipt.clone(), true))
        })
    }
    /// Expiry never proves absence from native history. There is deliberately no automatic requeue.
    pub fn reconcile_expired(&self, expected_revision: u64, now_ms: u64) -> Result<usize> {
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let revision = next_revision(data)?;
            let mut count = 0;
            for value in data.messages.values_mut() {
                if value.receipt.status == AgentMessageStatus::Delivering
                    && value
                        .reservation
                        .as_ref()
                        .is_some_and(|lease| lease.deadline_ms <= now_ms)
                {
                    value.receipt.status = AgentMessageStatus::Unknown;
                    value.receipt.reason_code = Some("delivery_result_unknown".into());
                    value.receipt.revision = revision;
                    count += 1;
                }
            }
            if count > 0 {
                data.revision = revision;
            }
            Ok((count, count > 0))
        })
    }
    /// Scope data is never an authorization grant; callers recheck actual host policy.
    pub fn scope(&self) -> &CrossSessionMessageScope {
        &self.header.scope
    }
    /// Native namespace identity for a host's durable mailbox binding, never an access grant.
    pub fn namespace_identity(&self) -> Result<String> {
        self.verify()?;
        Ok(self.header.directory.clone())
    }

    pub fn get_record_by_message_id(
        &self,
        message_id: &str,
    ) -> Result<Option<CrossSessionMessageRecord>> {
        ensure!(
            valid_agent_message_id(message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        self.access_with_archive(false, |data, archive| {
            if let Some(value) = data
                .messages
                .values()
                .find(|value| value.receipt.message_id == message_id)
            {
                return Ok((Some(CrossSessionMessageRecord::from(value)), false));
            }
            let record = if let Some(tx) = archive {
                self.terminal_by_message_id(tx, message_id)?
                    .map(|(key, terminal)| {
                        terminal.record(tx, &key, crate::now_millis().max(data.archive_clock_ms))
                    })
                    .transpose()?
            } else {
                None
            };
            Ok((record, false))
        })
    }

    pub fn get_by_message_id(
        &self,
        source: &CrossSessionMessageSource,
        message_id: &str,
    ) -> Result<Option<AgentMessageReceipt>> {
        source.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            valid_agent_message_id(message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        self.access_with_archive(false, |data, archive| {
            if let Some(value) = data
                .messages
                .values()
                .find(|value| value.source == *source && value.receipt.message_id == message_id)
            {
                return Ok((Some(value.receipt.clone()), false));
            }
            let receipt = archive
                .map(|tx| self.terminal_by_message_id(tx, message_id))
                .transpose()?
                .flatten()
                .filter(|(_, terminal)| terminal.binding().source == *source)
                .map(|(_, terminal)| terminal.receipt());
            Ok((receipt, false))
        })
    }

    /// Unresolved rows only, in target FIFO order. Presence never authorizes delivery.
    pub fn pending_for_target(
        &self,
        target_thread_id: &str,
    ) -> Result<Vec<CrossSessionMessageRecord>> {
        ensure!(
            valid_agent_message_id(target_thread_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        self.access(false, |data| {
            let mut rows = data
                .messages
                .values()
                .filter(|value| {
                    value.intent.target_thread_id == target_thread_id
                        && matches!(
                            value.receipt.status,
                            AgentMessageStatus::Queued
                                | AgentMessageStatus::Delivering
                                | AgentMessageStatus::Unknown
                        )
                })
                .map(CrossSessionMessageRecord::from)
                .collect::<Vec<_>>();
            rows.sort_by_key(|value| value.sequence);
            Ok((rows, false))
        })
    }

    pub fn finish_applied(
        &self,
        lease: &CrossSessionDeliveryLease,
        witness: &crate::peer_agent_history::PeerHistoryCommitWitness,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            lease.directory == self.header.directory,
            "AGENT_MESSAGE_LEASE_MISMATCH"
        );
        self.apply_witness(
            &lease.message_id,
            Some(&lease.reservation),
            witness,
            expected_revision,
            false,
        )
    }

    /// Recovery needs an exact native-history witness, never a received model response.
    pub fn reconcile_applied(
        &self,
        message_id: &str,
        witness: &crate::peer_agent_history::PeerHistoryCommitWitness,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        self.apply_witness(message_id, None, witness, expected_revision, false)
    }
    fn apply_witness(
        &self,
        message_id: &str,
        reservation: Option<&Reservation>,
        witness: &crate::peer_agent_history::PeerHistoryCommitWitness,
        expected_revision: u64,
        original_idle: bool,
    ) -> Result<AgentMessageReceipt> {
        self.access_with_archive(true, |data, archive| {
            if let Some(tx) = archive
                && let Some((_key, terminal)) = self.terminal_by_message_id(tx, message_id)?
            {
                ensure!(
                    terminal.receipt().status == AgentMessageStatus::Applied,
                    "AGENT_MESSAGE_LEASE_MISMATCH"
                );
                witness.matches_record(&terminal.record_from_witness(witness)?)?;
                return Ok((terminal.receipt(), false));
            }
            let value = data
                .messages
                .values()
                .find(|value| value.receipt.message_id == message_id)
                .context("AGENT_MESSAGE_NOT_FOUND")?;
            ensure!(
                value.namespace_id == self.header.directory,
                "AGENT_MESSAGE_NAMESPACE_CHANGED"
            );
            witness.matches_record(&CrossSessionMessageRecord::from(value))?;
            if value.receipt.status == AgentMessageStatus::Applied {
                return Ok((value.receipt.clone(), false));
            }
            revision_is(data, expected_revision)?;
            let revision = next_revision(data)?;
            let value = data
                .messages
                .values_mut()
                .find(|value| value.receipt.message_id == message_id)
                .expect("validated original record remains in transaction");
            ensure!(
                matches!(
                    value.receipt.status,
                    AgentMessageStatus::Delivering | AgentMessageStatus::Unknown
                ) && value.reservation.is_some()
                    && reservation
                        .is_none_or(|expected| value.reservation.as_ref() == Some(expected)),
                "AGENT_MESSAGE_LEASE_MISMATCH"
            );
            value.history_uuid = Some(witness.history_uuid().to_owned());
            value.receipt.status = AgentMessageStatus::Applied;
            value.terminal_at_ms = Some(crate::now_millis());
            value.receipt.reason_code = None;
            value.receipt.revision = revision;
            let receipt = value.receipt.clone();
            let record = CrossSessionMessageRecord::from(&*value);
            let terminal_at_ms = value
                .terminal_at_ms
                .expect("Applied has its terminal clock");
            if original_idle {
                self.register_original_idle_wake(data, &record, witness, terminal_at_ms)?;
            }
            data.revision = revision;
            Ok((receipt, true))
        })
    }

    /// Only rows which have never been reserved may be rejected without native-history reconciliation.
    pub fn reject_queued(
        &self,
        message_id: &str,
        reason_code: &str,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            valid_agent_message_id(reason_code),
            "AGENT_MESSAGE_INVALID_REASON"
        );
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let revision = next_revision(data)?;
            let value = data
                .messages
                .values_mut()
                .find(|value| value.receipt.message_id == message_id)
                .context("AGENT_MESSAGE_NOT_FOUND")?;
            ensure!(
                value.receipt.status == AgentMessageStatus::Queued
                    && value.reservation.is_none()
                    && value.history_uuid.is_none(),
                "AGENT_MESSAGE_RECONCILIATION_REQUIRED"
            );
            value.receipt.status = AgentMessageStatus::Rejected;
            value.terminal_at_ms = Some(crate::now_millis());
            value.receipt.reason_code = Some(reason_code.to_owned());
            value.receipt.revision = revision;
            data.revision = revision;
            Ok((value.receipt.clone(), true))
        })
    }

    /// Explicit host retention policy only; unknown creation times and reserved rows never expire here.
    pub fn expire_queued(&self, expected_revision: u64, created_before_ms: u64) -> Result<usize> {
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let revision = next_revision(data)?;
            let mut count = 0;
            for value in data.messages.values_mut() {
                if value.receipt.status == AgentMessageStatus::Queued
                    && value.reservation.is_none()
                    && value.created_at_ms != 0
                    && value.created_at_ms < created_before_ms
                {
                    value.receipt.status = AgentMessageStatus::Expired;
                    value.terminal_at_ms = Some(crate::now_millis());
                    value.receipt.reason_code = Some("message_expired".into());
                    value.receipt.revision = revision;
                    count += 1;
                }
            }
            if count > 0 {
                data.revision = revision;
            }
            Ok((count, count > 0))
        })
    }

    #[cfg(test)]
    pub(super) fn io_counts(&self) -> (usize, usize) {
        use std::sync::atomic::Ordering;
        (
            self.reads.load(Ordering::Relaxed),
            self.writes.load(Ordering::Relaxed),
        )
    }
    #[cfg(test)]
    pub(super) fn queue_body_io_counts(&self) -> (usize, usize) {
        use std::sync::atomic::Ordering;
        (
            self.body_reads.load(Ordering::Relaxed),
            self.writes.load(Ordering::Relaxed),
        )
    }
}
