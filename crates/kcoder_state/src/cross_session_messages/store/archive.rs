//! One SQLite authority after an exact, owner-driven JSON bootstrap.
use super::*;
use crate::durable_receipt_archive::{
    DurableReceiptArchive, DurableReceiptArchiveBinding, DurableReceiptArchiveRow,
    DurableReceiptArchiveTransaction,
};

const MAX_DISK_BYTES: u64 = MAX_DATA_BYTES + 16 * 1024;
pub(super) const WAKE_GRACE_MS: u64 = 15 * 60 * 1000;
const BODY_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;

#[cfg(test)]
thread_local! { pub(super) static FAILURE_POINT: std::cell::Cell<Option<&'static str>> = const {std::cell::Cell::new(None)}; }
fn fail_at(_point: &'static str) -> Result<()> {
    #[cfg(test)]
    if FAILURE_POINT.with(|point| {
        if point.get() == Some(_point) {
            point.set(None);
            true
        } else {
            false
        }
    }) {
        anyhow::bail!("owned archive checkpoint failure");
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchivedWakeClaims {
    pub generation: u64,
    pub count: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchivedClaim {
    message_id: String,
    marker: PeerWakeClaimMarker,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "snake_case", deny_unknown_fields)]
enum Disk {
    Bootstrap {
        binding: DurableReceiptArchiveBinding,
        data: Box<Data>,
    },
    Sqlite {
        binding: DurableReceiptArchiveBinding,
    },
}
pub(super) struct ArchiveHint {
    manifest: PortableLeaseIdentity,
    binding: DurableReceiptArchiveBinding,
}

/// Body-free original binding for receipt reconciliation after retained content
/// expires. This is provenance only and is never source or target permission.
#[derive(Clone)]
pub struct CrossSessionReceiptBinding {
    pub source: CrossSessionMessageSource,
    pub receipt: AgentMessageReceipt,
    pub target_thread_id: String,
    pub target_address: Option<kcoder_types::session_address::SessionAddressV1>,
    pub mode: AgentMessageMode,
    pub expected_turn_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub created_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub namespace_id: String,
    pub history_uuid: Option<String>,
    pub body_sha256: String,
    pub intent_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Terminal {
    version: u32,
    // The original request shape is retained with text removed. Its exact
    // canonical fingerprint and body digest remain permanently bound below.
    value: StoredMessage,
    pub(super) fingerprint: String,
    body_sha256: String,
    pub(super) wake_deadline_ms: Option<u64>,
    body_deadline_ms: u64,
}
pub(super) fn is_pending(status: AgentMessageStatus) -> bool {
    matches!(
        status,
        AgentMessageStatus::Queued | AgentMessageStatus::Delivering | AgentMessageStatus::Unknown
    )
}
pub(super) fn fingerprint(
    source: &CrossSessionMessageSource,
    intent: &AgentMessageIntent,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(source, intent))?)
    ))
}
impl Terminal {
    fn from_value(value: &StoredMessage, now: u64) -> Result<Self> {
        let mut stored = value.clone();
        let fingerprint = fingerprint(&value.source, &value.intent)?;
        let body_sha256 = format!("{:x}", Sha256::digest(value.intent.text.as_bytes()));
        stored.intent.text.clear();
        let body_deadline_ms = value
            .terminal_at_ms
            .unwrap_or(now)
            .checked_add(BODY_RETENTION_MS)
            .context("AGENT_MESSAGE_RETENTION_OVERFLOW")?;
        let wake_deadline_ms = if value.receipt.status == AgentMessageStatus::Applied
            && value.intent.mode == AgentMessageMode::WakeIfIdle
        {
            value
                .terminal_at_ms
                .and_then(|at| at.checked_add(WAKE_GRACE_MS))
        } else {
            None
        };
        Ok(Self {
            version: 1,
            value: stored,
            fingerprint,
            body_sha256,
            wake_deadline_ms,
            body_deadline_ms,
        })
    }
    fn validate(&self, store: &CrossSessionMessageStore, key: &str) -> Result<()> {
        self.value.source.validate().map_err(anyhow::Error::msg)?;
        let mut shape = self.value.intent.clone();
        shape.text = "retired reference".into();
        shape.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            self.version == 1
                && !is_pending(self.value.receipt.status)
                && self.value.intent.text.is_empty()
                && key == request_key(&self.value.source, &self.value.intent.client_message_id)?
                && self.value.namespace_id == store.header.directory
                && self.value.receipt.client_message_id == self.value.intent.client_message_id
                && self.value.receipt.target_thread_id == self.value.intent.target_thread_id
                && self.value.receipt.source_address == self.value.source.address
                && self.value.receipt.target_address == self.value.intent.target_address
                && self.value.receipt.reply_to_message_id == self.value.intent.reply_to_message_id
                && self
                    .value
                    .intent
                    .target_address
                    .as_ref()
                    .is_none_or(|address| address.target_id == store.header.scope.target_id
                        && address.workspace_id == store.header.scope.workspace_id)
                && [self.fingerprint.as_str(), self.body_sha256.as_str()]
                    .into_iter()
                    .all(|hash| hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
                && self.body_deadline_ms > 0,
            "AGENT_MESSAGE_ARCHIVE_BINDING_INVALID"
        );
        if let Some(claim) = &self.value.peer_wake_claim {
            claim.validate()?;
            ensure!(
                self.value.receipt.status == AgentMessageStatus::Applied
                    && self.value.intent.mode == AgentMessageMode::WakeIfIdle,
                "PEER_WAKE_ARCHIVED_CLAIM_INVALID"
            );
        }
        ensure!(
            valid_agent_message_id(&self.value.receipt.message_id)
                && self.value.receipt.revision > 0
                && self.value.sequence > 0,
            "AGENT_MESSAGE_ARCHIVE_BINDING_INVALID"
        );
        Ok(())
    }
    pub(super) fn receipt(&self) -> AgentMessageReceipt {
        self.value.receipt.clone()
    }
    pub(super) fn thread_id(&self) -> &str {
        &self.value.intent.target_thread_id
    }
    pub(super) fn history_uuid(&self) -> Option<&str> {
        self.value.history_uuid.as_deref()
    }
    pub(super) fn binding(&self) -> CrossSessionReceiptBinding {
        CrossSessionReceiptBinding {
            source: self.value.source.clone(),
            receipt: self.receipt(),
            target_thread_id: self.value.intent.target_thread_id.clone(),
            target_address: self.value.intent.target_address.clone(),
            mode: self.value.intent.mode,
            expected_turn_id: self.value.intent.expected_turn_id.clone(),
            reply_to_message_id: self.value.intent.reply_to_message_id.clone(),
            created_at_ms: (self.value.created_at_ms != 0).then_some(self.value.created_at_ms),
            expires_at_ms: self.value.expires_at_ms,
            namespace_id: self.value.namespace_id.clone(),
            history_uuid: self.value.history_uuid.clone(),
            body_sha256: self.body_sha256.clone(),
            intent_sha256: self.fingerprint.clone(),
        }
    }
    pub(super) fn record_from_witness(
        &self,
        witness: &crate::peer_agent_history::PeerHistoryCommitWitness,
    ) -> Result<CrossSessionMessageRecord> {
        let (_, text) = witness
            .message()
            .peer_agent_data()
            .context("AGENT_MESSAGE_ARCHIVE_WITNESS_INVALID")?;
        ensure!(
            format!("{:x}", Sha256::digest(text.as_bytes())) == self.body_sha256,
            "AGENT_MESSAGE_ARCHIVE_BODY_CHANGED"
        );
        let mut value = self.value.clone();
        value.intent.text = text.into();
        ensure!(
            fingerprint(&value.source, &value.intent)? == self.fingerprint,
            "AGENT_MESSAGE_ARCHIVE_REQUEST_CHANGED"
        );
        Ok(CrossSessionMessageRecord::from(&value))
    }
    pub(super) fn record(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        key: &str,
        now: u64,
    ) -> Result<CrossSessionMessageRecord> {
        ensure!(now < self.body_deadline_ms, "AGENT_MESSAGE_BODY_RETIRED");
        let (deadline, body) = tx.payload(key)?.context("AGENT_MESSAGE_BODY_RETIRED")?;
        ensure!(
            deadline == self.body_deadline_ms
                && format!("{:x}", Sha256::digest(&body)) == self.body_sha256,
            "AGENT_MESSAGE_ARCHIVE_BODY_CHANGED"
        );
        let mut value = self.value.clone();
        value.intent.text =
            String::from_utf8(body).context("AGENT_MESSAGE_ARCHIVE_BODY_CHANGED")?;
        ensure!(
            fingerprint(&value.source, &value.intent)? == self.fingerprint,
            "AGENT_MESSAGE_ARCHIVE_REQUEST_CHANGED"
        );
        Ok(CrossSessionMessageRecord::from(&value))
    }
}

impl CrossSessionMessageStore {
    pub(super) fn archived_wake_claim(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        message_id: &str,
    ) -> Result<Option<PeerWakeClaimMarker>> {
        tx.get(&format!("wake-claim/{message_id}"))?
            .map(|row| {
                let claim: ArchivedClaim = serde_json::from_slice(&row.body)?;
                claim.marker.validate()?;
                ensure!(
                    claim.message_id == message_id
                        && row.message_id == format!("claim/{}", claim.marker.claim_id),
                    "PEER_WAKE_ARCHIVED_CLAIM_INVALID"
                );
                Ok(claim.marker)
            })
            .transpose()
    }
    pub(super) fn insert_archived_wake_claim(
        &self,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
        message_id: &str,
        marker: &PeerWakeClaimMarker,
    ) -> Result<()> {
        marker.validate()?;
        tx.insert(&DurableReceiptArchiveRow {
            request_key: format!("wake-claim/{message_id}"),
            message_id: format!("claim/{}", marker.claim_id),
            body: serde_json::to_vec(&ArchivedClaim {
                message_id: message_id.into(),
                marker: marker.clone(),
            })?,
        })?;
        Ok(())
    }
    fn publish_disk(&self, disk: &Disk) -> Result<()> {
        let bytes = serde_json::to_vec(disk)?;
        ensure!(
            bytes.len() as u64 <= MAX_DISK_BYTES,
            "AGENT_MESSAGE_DATA_LIMIT"
        );
        self.verify()?;
        self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
        #[cfg(test)]
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.verify()?;
        Ok(())
    }
    fn complete_bootstrap(
        &self,
        binding: DurableReceiptArchiveBinding,
        data: &Data,
        lease: &VerifiedPrivateLease,
    ) -> Result<DurableReceiptArchiveBinding> {
        binding.verify_seed(&serde_json::to_vec(data)?)?;
        binding.prepare_bootstrap_anchor(lease)?;
        DurableReceiptArchive::initialize(&self.directory, &binding, &serde_json::to_vec(data)?)?;
        fail_at("seed_committed")?;
        self.publish_disk(&Disk::Sqlite {
            binding: binding.clone(),
        })?;
        fail_at("manifest_published")?;
        binding.finish_commit_anchor(lease)?;
        Ok(binding)
    }
    fn start_bootstrap(
        &self,
        data: &Data,
        lease: &VerifiedPrivateLease,
    ) -> Result<DurableReceiptArchiveBinding> {
        let seed = serde_json::to_vec(data)?;
        let scope = serde_json::to_string(&(
            "kcoder.peer-receipts.v1",
            &self.header.directory,
            &self.header.scope,
        ))?;
        let binding = DurableReceiptArchiveBinding::reserve(&self.directory, &scope, &seed)?;
        fail_at("reserved")?;
        self.publish_disk(&Disk::Bootstrap {
            binding: binding.clone(),
            data: serde_json::from_slice(&seed)?,
        })?;
        fail_at("bootstrap_published")?;
        self.complete_bootstrap(binding, data, lease)
    }
    fn remember_archive(&self, binding: &DurableReceiptArchiveBinding) -> Result<()> {
        let manifest = self.directory.portable_regular_identity(OsStr::new(DATA))?;
        *self
            .archive_hint
            .lock()
            .map_err(|_| anyhow::anyhow!("AGENT_MESSAGE_BUSY"))? = Some(ArchiveHint {
            manifest,
            binding: binding.clone(),
        });
        Ok(())
    }
    pub(super) fn access_with_archive<R>(
        &self,
        write: bool,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<R> {
        self.access_with_archive_observed(write, false, action)
            .map(|(result, _)| result)
    }
    pub(super) fn access_with_archive_observed<R>(
        &self,
        write: bool,
        observe: bool,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<(R, Option<CrossSessionMessageObservationStamp>)> {
        let lease = self.lease(write)?;
        self.access_with_archive_observed_leased(write, observe, lease, action)
    }
    pub(super) fn access_with_archive_observed_leased<R>(
        &self,
        write: bool,
        observe: bool,
        lease: VerifiedPrivateLease,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<(R, Option<CrossSessionMessageObservationStamp>)> {
        self.access_with_archive_observed_lease_ref(write, observe, &lease, action)
    }
    pub(super) fn access_with_archive_observed_lease_ref<R>(
        &self,
        write: bool,
        observe: bool,
        lease: &VerifiedPrivateLease,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<(R, Option<CrossSessionMessageObservationStamp>)> {
        let bytes = self.read(DATA, MAX_DISK_BYTES)?;
        let json: serde_json::Value = serde_json::from_slice(&bytes)?;
        let mut legacy = None;
        let binding = if json.get("format").is_some() {
            match serde_json::from_value::<Disk>(json)? {
                Disk::Sqlite { binding } => {
                    binding.verify_committed_anchor(lease)?;
                    if write {
                        binding.finish_commit_anchor(lease)?;
                    }
                    Some(binding)
                }
                Disk::Bootstrap { binding, data } => {
                    self.validate_data(&data)?;
                    binding.verify_seed(&serde_json::to_vec(&data)?)?;
                    if write {
                        Some(self.complete_bootstrap(binding, &data, lease)?)
                    } else {
                        binding.verify_bootstrap_anchor(lease)?;
                        legacy = Some(*data);
                        None
                    }
                }
            }
        } else {
            DurableReceiptArchiveBinding::verify_unbound_anchor(lease)?;
            legacy = Some(serde_json::from_value::<Data>(json)?);
            self.validate_data(legacy.as_ref().context("AGENT_MESSAGE_BOOTSTRAP_INVALID")?)?;
            if write
                && legacy
                    .as_ref()
                    .context("AGENT_MESSAGE_BOOTSTRAP_INVALID")?
                    .messages
                    .values()
                    .any(|value| !is_pending(value.receipt.status))
            {
                Some(self.start_bootstrap(
                    legacy.as_ref().context("AGENT_MESSAGE_BOOTSTRAP_INVALID")?,
                    lease,
                )?)
            } else {
                None
            }
        };
        let result = if let Some(binding) = binding {
            self.remember_archive(&binding)?;
            let mut archive = DurableReceiptArchive::open(&self.directory, &binding, write)?;
            archive.access(|tx| {
                let mut data: Data = serde_json::from_slice(&tx.checkpoint()?)?;
                self.validate_data(&data)?;
                let (result, changed) = action(&mut data, Some(tx))?;
                let archived = if write {
                    self.archive_terminals(&mut data, tx)?
                } else {
                    false
                };
                if changed || archived {
                    ensure!(write, "AGENT_MESSAGE_READ_ONLY");
                    if archived && !changed {
                        data.revision = next_revision(&data)?;
                    }
                    self.validate_data(&data)?;
                    tx.set_checkpoint(&serde_json::to_vec(&data)?)?;
                    fail_at("before_sql_commit")?;
                    #[cfg(test)]
                    self.writes
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                Ok(result)
            })?
        } else {
            let legacy = legacy.as_mut().context("AGENT_MESSAGE_BOOTSTRAP_INVALID")?;
            let (result, changed) = action(legacy, None)?;
            if changed {
                ensure!(write, "AGENT_MESSAGE_READ_ONLY");
                self.validate_data(legacy)?;
                if legacy
                    .messages
                    .values()
                    .any(|value| !is_pending(value.receipt.status))
                {
                    // The logical result is already frozen in Bootstrap before
                    // cutover. Its final rows and checkpoint then move in one
                    // SQL commit; an uncertain observer retries only its ID.
                    let binding = self.start_bootstrap(legacy, lease)?;
                    self.remember_archive(&binding)?;
                    let mut archive = DurableReceiptArchive::open(&self.directory, &binding, true)?;
                    archive.access(|tx| {
                        let mut data: Data = serde_json::from_slice(&tx.checkpoint()?)?;
                        self.validate_data(&data)?;
                        self.archive_terminals(&mut data, tx)?;
                        self.validate_data(&data)?;
                        tx.set_checkpoint(&serde_json::to_vec(&data)?)?;
                        fail_at("before_sql_commit")?;
                        Ok(())
                    })?;
                } else {
                    let bytes = serde_json::to_vec(legacy)?;
                    ensure!(
                        bytes.len() as u64 <= MAX_DATA_BYTES,
                        "AGENT_MESSAGE_DATA_LIMIT"
                    );
                    self.verify()?;
                    self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
                    #[cfg(test)]
                    self.writes
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
            result
        };
        if write {
            fail_at("after_sql_commit")?;
        }
        self.verify()?;
        Ok((
            result,
            observe.then(|| self.observation_stamp()).transpose()?,
        ))
    }
    pub(super) fn archive_observation_stamp(
        &self,
        file: &File,
        metadata: &std::fs::Metadata,
    ) -> Result<CrossSessionMessageObservationStamp> {
        let manifest = self.directory.portable_regular_handle_identity(file)?;
        let hint = self
            .archive_hint
            .lock()
            .map_err(|_| anyhow::anyhow!("AGENT_MESSAGE_BUSY"))?;
        if let Some(hint) = hint.as_ref()
            && hint.manifest == manifest
        {
            let stamp = hint.binding.observation_stamp(&self.directory)?;
            return Ok(CrossSessionMessageObservationStamp {
                namespace: self.header.directory.clone(),
                file: stamp.file,
                bytes: stamp.bytes,
                modified: stamp.modified,
                manifest: Some((manifest, metadata.len(), metadata.modified()?)),
            });
        }
        Ok(CrossSessionMessageObservationStamp {
            namespace: self.directory.directory_identity()?,
            file: manifest,
            bytes: metadata.len(),
            modified: metadata.modified()?,
            manifest: None,
        })
    }
    fn archive_terminals(
        &self,
        data: &mut Data,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
    ) -> Result<bool> {
        let now = data.archive_clock_ms.max(crate::now_millis());
        let keys = data
            .messages
            .iter()
            .filter(|(_, row)| !is_pending(row.receipt.status))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in &keys {
            let value = data.messages[key].clone();
            let terminal = Terminal::from_value(&value, now)?;
            let row = DurableReceiptArchiveRow {
                request_key: key.clone(),
                message_id: value.receipt.message_id.clone(),
                body: serde_json::to_vec(&terminal)?,
            };
            let inserted = if now < terminal.body_deadline_ms {
                tx.insert_with_payload(
                    &row,
                    terminal.body_deadline_ms,
                    value.intent.text.as_bytes(),
                )?
            } else {
                tx.insert(&row)?
            };
            ensure!(inserted, "AGENT_MESSAGE_ARCHIVE_CHECKPOINT_CONFLICT");
            if let Some(claim) = &value.peer_wake_claim {
                self.insert_archived_wake_claim(tx, &value.receipt.message_id, claim)?;
                self.count_archived_claim(
                    data,
                    &value.intent.target_thread_id.clone(),
                    claim.clone(),
                )?;
            }
            if value.peer_wake_claim.is_none()
                && terminal
                    .wake_deadline_ms
                    .is_some_and(|deadline| deadline > now)
            {
                ensure!(
                    data.wake_grace_deadlines.len() < 4096,
                    "AGENT_MESSAGE_WAKE_GRACE_CAPACITY"
                );
                data.wake_grace_deadlines.insert(
                    value.receipt.message_id.clone(),
                    terminal.wake_deadline_ms.unwrap(),
                );
            }
            data.messages.remove(key);
        }
        if !keys.is_empty() {
            data.archive_clock_ms = now;
        }
        Ok(!keys.is_empty())
    }
    pub(super) fn count_archived_claim(
        &self,
        data: &mut Data,
        target: &str,
        claim: PeerWakeClaimMarker,
    ) -> Result<()> {
        let budget = data
            .peer_wake_budgets
            .get(target)
            .context("PEER_WAKE_CLAIM_BUDGET_MISSING")?;
        ensure!(
            claim.budget_generation <= budget.generation,
            "PEER_WAKE_CLAIM_FUTURE_GENERATION"
        );
        if claim.budget_generation == budget.generation {
            let summary = data
                .peer_wake_archived_claims
                .entry(target.into())
                .or_insert(ArchivedWakeClaims {
                    generation: budget.generation,
                    count: 0,
                });
            if summary.generation != budget.generation {
                *summary = ArchivedWakeClaims {
                    generation: budget.generation,
                    count: 0,
                };
            }
            summary.count = summary
                .count
                .checked_add(1)
                .context("PEER_WAKE_CLAIM_COUNTER_INVALID")?;
        }
        Ok(())
    }
    pub(super) fn terminal_by_key(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        key: &str,
    ) -> Result<Option<Terminal>> {
        tx.get(key)?
            .map(|row| {
                let terminal: Terminal = serde_json::from_slice(&row.body)?;
                terminal.validate(self, &row.request_key)?;
                ensure!(
                    row.message_id == terminal.value.receipt.message_id,
                    "AGENT_MESSAGE_ARCHIVE_BINDING_INVALID"
                );
                Ok(terminal)
            })
            .transpose()
    }
    pub(super) fn terminal_by_message_id(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        message_id: &str,
    ) -> Result<Option<(String, Terminal)>> {
        tx.get_by_message_id(message_id)?
            .map(|row| {
                let terminal: Terminal = serde_json::from_slice(&row.body)?;
                terminal.validate(self, &row.request_key)?;
                ensure!(
                    row.message_id == terminal.value.receipt.message_id,
                    "AGENT_MESSAGE_ARCHIVE_BINDING_INVALID"
                );
                Ok((row.request_key, terminal))
            })
            .transpose()
    }
    pub fn get_receipt_binding_by_message_id(
        &self,
        message_id: &str,
    ) -> Result<Option<CrossSessionReceiptBinding>> {
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
                return Ok((
                    Some(Terminal::from_value(value, crate::now_millis())?.binding()),
                    false,
                ));
            }
            Ok((
                archive
                    .map(|tx| self.terminal_by_message_id(tx, message_id))
                    .transpose()?
                    .flatten()
                    .map(|(_, terminal)| terminal.binding()),
                false,
            ))
        })
    }
    pub(super) fn maintain_archive(
        &self,
        data: &mut Data,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
        now: u64,
    ) -> Result<bool> {
        let effective = now.max(data.archive_clock_ms);
        let expired = data
            .wake_grace_deadlines
            .values()
            .any(|deadline| *deadline <= effective);
        if expired {
            data.wake_grace_deadlines
                .retain(|_, deadline| *deadline > effective);
            data.peer_idle_wakes
                .retain(|_, admission| admission.deadline_ms > effective);
            data.archive_clock_ms = effective;
        }
        let purged = tx.purge_payloads(effective, 128)?;
        Ok(expired || purged > 0)
    }
    pub(super) fn retained_deadline(&self) -> Result<Option<u64>> {
        self.access_with_archive(false, |data, archive| {
            let mut next = data.wake_grace_deadlines.values().copied().min();
            if let Some(tx) = archive
                && let Some(deadline) = tx.next_payload_deadline()?
            {
                next = Some(next.map_or(deadline, |old| old.min(deadline)));
            }
            Ok((next, false))
        })
    }
}

#[path = "archive/query.rs"]
mod query;
pub use query::OriginalReceiptQuery;
#[cfg(test)]
#[path = "archive/tests.rs"]
mod tests;
