//! Control remains usable when previously born secret material becomes unknown.
use super::super::{IncomingTransfers, SourceTransfers, TransferAuthority, storage as ordinary};
use super::storage;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

/// Watermarks say nothing about material validity or worker termination.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateCredentialWatermark {
    pub sequence: u64,
    pub cancel_watermark: u64,
    pub cancelled: bool,
}

/// Native-only capability, derived from an existing authenticated grant and catalog.
pub struct PrivateCredentialWatermarkControl {
    store: ordinary::Store,
    role: &'static str,
    request: String,
    offer: String,
}
impl PrivateCredentialWatermarkControl {
    fn open(&self) -> Result<storage::Operation> {
        storage::controller_by_id(&self.store, self.role, &self.request, &self.offer)
    }
    fn state(operation: &storage::Operation) -> Result<PrivateCredentialWatermark> {
        let state = ordinary::control(&operation.directory)?.state(false);
        Ok(PrivateCredentialWatermark {
            sequence: state.sequence,
            cancel_watermark: state.cancel_watermark,
            cancelled: state.cancelled,
        })
    }
    pub fn read(&self) -> Result<PrivateCredentialWatermark> {
        Self::state(&self.open()?)
    }
    pub fn writer_running(&self) -> Result<bool> {
        self.open()?.writer_running()
    }
    pub fn cancel(&self, command_id: &str) -> Result<PrivateCredentialWatermark> {
        let operation = self.open()?;
        ordinary::cancel(&operation.directory, command_id)?;
        Self::state(&operation)
    }
    pub fn resume(&self, sequence: u64, watermark: u64) -> Result<PrivateCredentialWatermark> {
        let operation = self.open()?;
        ordinary::resume(&operation.directory, sequence, watermark)?;
        Self::state(&operation)
    }
}

pub fn source_private_credential_watermark(
    source: &SourceTransfers,
    authenticated_target: &TransferAuthority,
    request: &str,
    offer: &str,
) -> Result<PrivateCredentialWatermarkControl> {
    source
        .prepared_destination(request, authenticated_target)?
        .context("private_credentials_authority_changed")?;
    make(
        source.private_credential_existing_store()?,
        "source",
        request,
        offer,
    )
}

pub fn target_private_credential_watermark(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    request: &str,
    offer: &str,
) -> Result<PrivateCredentialWatermarkControl> {
    let grant = target.recover_target(request)?;
    ensure!(
        grant.source_authority() == authenticated_source,
        "private_credentials_authority_changed"
    );
    make(
        target.private_credential_existing_store()?,
        "target",
        request,
        offer,
    )
}

fn make(
    store: ordinary::Store,
    role: &'static str,
    request: &str,
    offer: &str,
) -> Result<PrivateCredentialWatermarkControl> {
    let result = PrivateCredentialWatermarkControl {
        store,
        role,
        request: request.into(),
        offer: offer.into(),
    };
    result.read()?;
    Ok(result)
}
