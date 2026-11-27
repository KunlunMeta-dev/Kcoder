//! Native source facts share the original profile lease and one SQLite authority.
use super::*;
use kcoder_config::VerifiedPrivateLease;
use kcoder_state::durable_receipt_archive::{
    DurableReceiptArchive, DurableReceiptArchiveBinding, DurableReceiptArchiveRow,
    DurableReceiptArchiveTransaction,
};

const MAX_DISK_BYTES: u64 = MAX_DATA_BYTES + 16 * 1024;
#[cfg(test)]
thread_local! {pub(super) static FAILURE_POINT:std::cell::Cell<Option<&'static str>>=const {std::cell::Cell::new(None)};}
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
        anyhow::bail!("owned source archive failure");
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "snake_case", deny_unknown_fields)]
enum Disk {
    Bootstrap {
        binding: DurableReceiptArchiveBinding,
        data: Data,
    },
    Sqlite {
        binding: DurableReceiptArchiveBinding,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchivedOperation {
    version: u32,
    pub(super) operation: PeerRouterOperationV1,
    source_history: Option<kcoder_state::PeerSourceHistoryReference>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptVersion {
    operation_id: String,
    receipt: AgentMessageReceipt,
}

pub(super) fn terminal(operation: &PeerRouterOperationV1) -> bool {
    operation.stage == PeerRouterStageV1::Receipted
        && operation.receipt.as_ref().is_some_and(|receipt| {
            matches!(
                receipt.status,
                AgentMessageStatus::Applied
                    | AgentMessageStatus::Rejected
                    | AgentMessageStatus::Expired
            )
        })
}
pub(super) fn source_request_key(source: &SessionAddressV1, client_id: &str) -> Result<String> {
    Ok(format!("source/{}", incoming_key(source, client_id)?))
}
fn receipt_alias_prefix(source: &SessionAddressV1, message_id: &str) -> Result<String> {
    Ok(format!(
        "receipt-alias/{}/",
        incoming_key(source, message_id)?
    ))
}
fn version_prefix(operation_id: &str) -> String {
    format!("receipt-version/{operation_id}/")
}
fn alias_body(operation_id: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(operation_id)?)
}

impl NativePeerRouterStore {
    fn publish_archive_disk(&self, disk: &Disk) -> Result<()> {
        let bytes = serde_json::to_vec(disk)?;
        ensure!(
            bytes.len() as u64 <= MAX_DISK_BYTES,
            "peer_router_data_limit"
        );
        self.verify()?;
        self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
        self.verify()
    }
    fn complete_archive_bootstrap(
        &self,
        binding: DurableReceiptArchiveBinding,
        data: &Data,
        lease: &VerifiedPrivateLease,
    ) -> Result<DurableReceiptArchiveBinding> {
        let seed = serde_json::to_vec(data)?;
        binding.verify_seed(&seed)?;
        binding.prepare_bootstrap_anchor(lease)?;
        DurableReceiptArchive::initialize(&self.directory, &binding, &seed)?;
        fail_at("seed_committed")?;
        self.publish_archive_disk(&Disk::Sqlite {
            binding: binding.clone(),
        })?;
        fail_at("manifest_published")?;
        binding.finish_commit_anchor(lease)?;
        Ok(binding)
    }
    fn start_archive_bootstrap(
        &self,
        data: &Data,
        lease: &VerifiedPrivateLease,
    ) -> Result<DurableReceiptArchiveBinding> {
        let seed = serde_json::to_vec(data)?;
        ensure!(
            seed.len() as u64 <= MAX_DATA_BYTES,
            "peer_router_data_limit"
        );
        let scope = serde_json::to_string(&(
            "kcoder.native-source-receipts.v1",
            &self.header.directory,
            &self.header.target_id,
            &self.header.identity_epoch,
            &self.header.principal,
        ))?;
        let binding = DurableReceiptArchiveBinding::reserve(&self.directory, &scope, &seed)?;
        fail_at("reserved")?;
        self.publish_archive_disk(&Disk::Bootstrap {
            binding: binding.clone(),
            data: serde_json::from_slice(&seed)?,
        })?;
        fail_at("bootstrap_published")?;
        self.complete_archive_bootstrap(binding, data, lease)
    }
    pub(super) fn access_with_archive<R>(
        &self,
        write: bool,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<R> {
        self.access_archive(write, false, action)
    }
    pub(super) fn access_requiring_archive<R>(
        &self,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<R> {
        self.access_archive(true, true, action)
    }
    fn access_archive<R>(
        &self,
        write: bool,
        required: bool,
        action: impl FnOnce(
            &mut Data,
            Option<&mut DurableReceiptArchiveTransaction<'_>>,
        ) -> Result<(R, bool)>,
    ) -> Result<R> {
        // The parent helper preserves its 50 ms kernel-lock wait and executes
        // this action once. SQLite locks do not replace Native owner fencing.
        let lease = self.acquire_namespace_lease(write)?;
        let bytes = read(&self.directory, DATA, MAX_DISK_BYTES)?;
        let json: serde_json::Value = serde_json::from_slice(&bytes)?;
        let mut legacy = None;
        let binding = if json.get("format").is_some() {
            match serde_json::from_value::<Disk>(json)? {
                Disk::Sqlite { binding } => {
                    binding.verify_committed_anchor(&lease)?;
                    if write {
                        binding.finish_commit_anchor(&lease)?;
                    }
                    Some(binding)
                }
                Disk::Bootstrap { binding, data } => {
                    self.validate_data(&data)?;
                    binding.verify_seed(&serde_json::to_vec(&data)?)?;
                    if write {
                        Some(self.complete_archive_bootstrap(binding, &data, &lease)?)
                    } else {
                        binding.verify_bootstrap_anchor(&lease)?;
                        legacy = Some(data);
                        None
                    }
                }
            }
        } else {
            DurableReceiptArchiveBinding::verify_unbound_anchor(&lease)?;
            legacy = Some(serde_json::from_value::<Data>(json)?);
            self.validate_data(legacy.as_ref().context("peer_router_bootstrap_invalid")?)?;
            if write && (required || self.needs_archive(legacy.as_ref().unwrap())) {
                Some(self.start_archive_bootstrap(legacy.as_ref().unwrap(), &lease)?)
            } else {
                None
            }
        };
        let result = if let Some(binding) = binding {
            let mut archive = DurableReceiptArchive::open(&self.directory, &binding, write)?;
            archive.access(|tx| {
                let mut data: Data = serde_json::from_slice(&tx.checkpoint()?)?;
                self.validate_data(&data)?;
                let (result, changed) = action(&mut data, Some(tx))?;
                let compacted = if write {
                    self.archive_source_facts(&mut data, tx)?
                } else {
                    false
                };
                if changed || compacted {
                    ensure!(write, "peer_router_read_only");
                    self.validate_data(&data)?;
                    let checkpoint = serde_json::to_vec(&data)?;
                    ensure!(
                        checkpoint.len() as u64 <= MAX_DATA_BYTES,
                        "peer_router_data_limit"
                    );
                    tx.set_checkpoint(&checkpoint)?;
                    fail_at("before_sql_commit")?;
                }
                Ok(result)
            })?
        } else {
            let data = legacy.as_mut().context("peer_router_bootstrap_invalid")?;
            let (result, changed) = action(data, None)?;
            if changed {
                ensure!(write, "peer_router_read_only");
                self.validate_data(data)?;
                if self.needs_archive(data) {
                    let binding = self.start_archive_bootstrap(data, &lease)?;
                    let mut archive = DurableReceiptArchive::open(&self.directory, &binding, true)?;
                    archive.access(|tx| {
                        let mut data: Data = serde_json::from_slice(&tx.checkpoint()?)?;
                        self.validate_data(&data)?;
                        self.archive_source_facts(&mut data, tx)?;
                        self.validate_data(&data)?;
                        let checkpoint = serde_json::to_vec(&data)?;
                        ensure!(
                            checkpoint.len() as u64 <= MAX_DATA_BYTES,
                            "peer_router_data_limit"
                        );
                        tx.set_checkpoint(&checkpoint)?;
                        fail_at("before_sql_commit")?;
                        Ok(())
                    })?;
                } else {
                    let bytes = serde_json::to_vec(data)?;
                    ensure!(
                        bytes.len() as u64 <= MAX_DATA_BYTES,
                        "peer_router_data_limit"
                    );
                    self.verify()?;
                    self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
                }
            }
            result
        };
        self.verify()?;
        Ok(result)
    }
    fn needs_archive(&self, data: &Data) -> bool {
        !data.incoming.is_empty() || data.operations.values().any(terminal)
    }
    fn archive_source_facts(
        &self,
        data: &mut Data,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
    ) -> Result<bool> {
        let operations = data
            .operations
            .values()
            .filter(|operation| terminal(operation))
            .cloned()
            .collect::<Vec<_>>();
        let incoming = data
            .incoming
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        if operations.is_empty() && incoming.is_empty() {
            return Ok(false);
        }
        if data.source_prepare_rate.is_none() {
            let now = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
            data.source_prepare_rate = Some(rate::State::from_legacy(data, now));
        }
        for operation in operations {
            self.validate_operation(&operation.operation_id, &operation)?;
            let key = source_request_key(
                &operation.source_address,
                &operation.attestation.claims.client_message_id,
            )?;
            let reference = data.source_history.get(&operation.operation_id).cloned();
            if let Some(reference) = &reference {
                reference.validate()?;
                ensure!(
                    reference.thread_id() == operation.source_address.thread_id,
                    "peer_router_source_history_thread_changed"
                );
            }
            ensure!(
                tx.insert(&DurableReceiptArchiveRow {
                    request_key: key,
                    message_id: format!("operation/{}", operation.operation_id),
                    body: serde_json::to_vec(&ArchivedOperation {
                        version: 1,
                        operation: operation.clone(),
                        source_history: reference
                    })?
                })?,
                "peer_router_archive_checkpoint_conflict"
            );
            let receipt = operation
                .receipt
                .as_ref()
                .context("peer_router_terminal_receipt_missing")?;
            self.insert_receipt_alias(tx, &operation, receipt)?;
            data.source_history.remove(&operation.operation_id);
            data.operations.remove(&operation.operation_id);
        }
        for (key, value) in incoming {
            self.validate_incoming(&key, &value)?;
            let request_key = format!("incoming/{key}");
            tx.insert(&DurableReceiptArchiveRow {
                request_key: request_key.clone(),
                message_id: request_key,
                body: serde_json::to_vec(&value)?,
            })?;
            data.incoming.remove(&key);
        }
        Ok(true)
    }
    pub(super) fn parse_archived_operation(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        row: DurableReceiptArchiveRow,
    ) -> Result<ArchivedOperation> {
        let mut group: ArchivedOperation = serde_json::from_slice(&row.body)?;
        ensure!(
            group.version == 1
                && terminal(&group.operation)
                && row.message_id == format!("operation/{}", group.operation.operation_id)
                && row.request_key
                    == source_request_key(
                        &group.operation.source_address,
                        &group.operation.attestation.claims.client_message_id
                    )?,
            "peer_router_archived_operation_invalid"
        );
        self.validate_operation(&group.operation.operation_id, &group.operation)?;
        if let Some(reference) = &group.source_history {
            reference.validate()?;
            ensure!(
                reference.thread_id() == group.operation.source_address.thread_id,
                "peer_router_source_history_thread_changed"
            );
        }
        if let Some(row) = tx
            .prefix_rows(&version_prefix(&group.operation.operation_id), 1, true)?
            .into_iter()
            .next()
        {
            let version: ReceiptVersion = serde_json::from_slice(&row.body)?;
            ensure!(
                version.operation_id == group.operation.operation_id
                    && row.request_key
                        == format!(
                            "{}{:020}",
                            version_prefix(&version.operation_id),
                            version.receipt.revision
                        )
                    && row.message_id == row.request_key,
                "peer_router_receipt_version_invalid"
            );
            validate_receipt(&group.operation, &version.receipt)?;
            let original = group.operation.receipt.as_ref().unwrap();
            ensure!(
                version.receipt.message_id == original.message_id
                    && version.receipt.revision >= original.revision
                    && version.receipt.status == original.status,
                "peer_router_terminal_receipt_conflict"
            );
            group.operation.receipt = Some(version.receipt);
        }
        Ok(group)
    }
    pub(super) fn archived_by_id(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        operation_id: &str,
    ) -> Result<
        Option<(
            PeerRouterOperationV1,
            Option<kcoder_state::PeerSourceHistoryReference>,
        )>,
    > {
        tx.get_by_message_id(&format!("operation/{operation_id}"))?
            .map(|row| {
                let group = self.parse_archived_operation(tx, row)?;
                ensure!(
                    group.operation.operation_id == operation_id,
                    "peer_router_archived_operation_invalid"
                );
                Ok((group.operation, group.source_history))
            })
            .transpose()
    }
    pub(super) fn archived_by_client(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        source: &SessionAddressV1,
        client_id: &str,
    ) -> Result<Option<PeerRouterOperationV1>> {
        tx.get(&source_request_key(source, client_id)?)?
            .map(|row| {
                let group = self.parse_archived_operation(tx, row)?;
                ensure!(
                    &group.operation.source_address == source
                        && group.operation.attestation.claims.client_message_id == client_id,
                    "peer_router_archived_operation_invalid"
                );
                Ok(group.operation)
            })
            .transpose()
    }
    pub(super) fn archived_incoming(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        key: &str,
    ) -> Result<Option<IncomingPeerOperation>> {
        tx.get(&format!("incoming/{key}"))?
            .map(|row| {
                let incoming: IncomingPeerOperation = serde_json::from_slice(&row.body)?;
                self.validate_incoming(key, &incoming)?;
                ensure!(
                    row.message_id == row.request_key,
                    "peer_router_incoming_binding_changed"
                );
                Ok(incoming)
            })
            .transpose()
    }
    fn insert_receipt_alias(
        &self,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
        operation: &PeerRouterOperationV1,
        receipt: &AgentMessageReceipt,
    ) -> Result<()> {
        let key = format!(
            "{}{}",
            receipt_alias_prefix(&operation.source_address, &receipt.message_id)?,
            operation.operation_id
        );
        tx.insert(&DurableReceiptArchiveRow {
            request_key: key.clone(),
            message_id: key,
            body: alias_body(&operation.operation_id)?,
        })?;
        Ok(())
    }
    pub(super) fn archived_by_receipt(
        &self,
        tx: &DurableReceiptArchiveTransaction<'_>,
        source: &SessionAddressV1,
        message_id: &str,
    ) -> Result<Option<PeerRouterOperationV1>> {
        let rows = tx.prefix_rows(&receipt_alias_prefix(source, message_id)?, 2, false)?;
        ensure!(rows.len() <= 1, "peer_message_original_operation_ambiguous");
        rows.into_iter()
            .next()
            .map(|row| {
                let id: String = serde_json::from_slice(&row.body)?;
                ensure!(
                    row.request_key
                        == format!("{}{}", receipt_alias_prefix(source, message_id)?, id)
                        && row.message_id == row.request_key,
                    "peer_router_receipt_alias_changed"
                );
                let (operation, _) = self
                    .archived_by_id(tx, &id)?
                    .context("peer_router_receipt_alias_missing")?;
                ensure!(
                    &operation.source_address == source
                        && operation
                            .receipt
                            .as_ref()
                            .is_some_and(|receipt| receipt.message_id == message_id),
                    "peer_router_receipt_alias_changed"
                );
                Ok(operation)
            })
            .transpose()
    }
    pub(super) fn record_archived_receipt(
        &self,
        tx: &mut DurableReceiptArchiveTransaction<'_>,
        operation: &PeerRouterOperationV1,
        receipt: AgentMessageReceipt,
    ) -> Result<PeerRouterOperationV1> {
        validate_receipt(operation, &receipt)?;
        let old = operation
            .receipt
            .as_ref()
            .context("peer_router_terminal_receipt_missing")?;
        ensure!(
            old.message_id == receipt.message_id
                && old.status == receipt.status
                && receipt.revision >= old.revision,
            "peer_router_terminal_receipt_conflict"
        );
        if old == &receipt {
            return Ok(operation.clone());
        }
        ensure!(
            receipt.revision > old.revision,
            "peer_router_receipt_conflict"
        );
        let key = format!(
            "{}{:020}",
            version_prefix(&operation.operation_id),
            receipt.revision
        );
        tx.insert(&DurableReceiptArchiveRow {
            request_key: key.clone(),
            message_id: key,
            body: serde_json::to_vec(&ReceiptVersion {
                operation_id: operation.operation_id.clone(),
                receipt: receipt.clone(),
            })?,
        })?;
        let mut operation = operation.clone();
        operation.receipt = Some(receipt);
        Ok(operation)
    }
}
