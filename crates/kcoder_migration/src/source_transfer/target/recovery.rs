//! Read-only restoration of the target's original authenticated destination grant.
use super::*;

/// Constructed only from a private target grant. It is never deserialized from RPC input.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveredTargetTransfer {
    destination: TransferDestination,
    source: TransferAuthority,
}
impl RecoveredTargetTransfer {
    pub fn destination(&self) -> &TransferDestination {
        &self.destination
    }
    pub fn source_authority(&self) -> &TransferAuthority {
        &self.source
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTargetProgress {
    pub manifest_sha256: String,
    pub entries: u32,
    pub total_bytes: u64,
    pub accepted_bytes: u64,
    /// Confirmed parts only; finish still verifies every payload's complete digest.
    pub parts_complete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTargetSummary {
    pub state: Option<TransferState>,
    pub worker_running: bool,
    pub receipt: Option<TransferReceipt>,
    pub progress: Option<TransferTargetProgress>,
    pub admission_control: Option<TransferState>,
}

impl IncomingTransfers {
    /// Never bootstraps a namespace, native identity, role directory, grant or operation.
    pub fn open_existing(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open_existing(profile, "incoming")?,
        })
    }

    pub fn recover_target(&self, request: &str) -> Result<RecoveredTargetTransfer> {
        valid_uuid(request)?;
        let root = self.store.root()?;
        let grant: DestinationGrant = load(&root, &format!("grant-{request}.json"))?
            .context("source_transfer_destination_unavailable")?;
        grant.source.validate()?;
        ensure!(
            grant.destination.grant_id == request
                && grant.destination.authority == self.store.authority
                && grant.destination.scope == self.scope()?,
            "source_transfer_authority_changed"
        );
        self.admission_state(request)?;
        // Missing original operation metadata is unknown, not an empty new transfer.
        if self.store.has_operation(request)? {
            let (directory, manifest) = self.existing(request, &grant.source)?;
            drop(try_operation_lease(&directory, "writer.lock")?);
            drop(try_operation_lease(&directory, "control.lock")?);
            ensure!(
                manifest.destination == grant.destination,
                "source_transfer_authority_changed"
            );
        }
        Ok(RecoveredTargetTransfer {
            destination: grant.destination,
            source: grant.source,
        })
    }

    pub fn target_summary(
        &self,
        request: &str,
        source: &TransferAuthority,
    ) -> Result<TransferTargetSummary> {
        let grant = self.recover_target(request)?;
        ensure!(
            grant.source_authority() == source,
            "source_transfer_authority_changed"
        );
        if !self.store.has_operation(request)? {
            return Ok(TransferTargetSummary {
                state: None,
                worker_running: self.admission_busy(request)?,
                receipt: None,
                progress: None,
                admission_control: self.admission_state(request)?,
            });
        }
        let (directory, manifest) = self.existing(request, source)?;
        let busy_before = try_operation_lease(&directory, "writer.lock")?.is_none();
        let mut accepted = 0u64;
        for entry in &manifest.entries {
            let parts = read_parts(&directory, entry)?;
            let bytes = accepted_bytes(&parts, entry);
            let length = directory
                .open_single_link_regular_file(OsStr::new(&payload_name(entry)))?
                .metadata()?
                .len();
            ensure!(
                length >= bytes && length <= entry.bytes,
                "source_transfer_payload_changed"
            );
            accepted += bytes;
        }
        let receipt: Option<TransferReceipt> = load(&directory, "receipt.json")?;
        if let Some(receipt) = &receipt {
            ensure!(
                receipt == &expected_receipt(&manifest)?,
                "source_transfer_receipt_changed"
            );
        }
        let state = control(&directory)?.state(receipt.is_some());
        let busy_after = try_operation_lease(&directory, "writer.lock")?.is_none();
        Ok(TransferTargetSummary {
            state: Some(state),
            worker_running: busy_before || busy_after || self.admission_busy(request)?,
            receipt,
            admission_control: self.admission_state(request)?,
            progress: Some(TransferTargetProgress {
                manifest_sha256: manifest.digest()?,
                entries: manifest.entries.len() as u32,
                total_bytes: manifest.total_bytes(),
                accepted_bytes: accepted,
                parts_complete: accepted == manifest.total_bytes(),
            }),
        })
    }
}
