//! Separate private-channel cancellation watermarks; a request is not worker termination.
use super::super::{SourceTransfers, TransferAuthority, TransferState, storage as ordinary};
use super::{crypto, model::*, storage, target::ReceivedPrivateCredentialBinding};
use anyhow::{Result, ensure};

/// Native-only controller captured from an existing, authenticated operation.
/// It never creates a key, offer, namespace or worker, and never clears ordinary cancellation.
pub struct PrivateCredentialControl {
    store: ordinary::Store,
    role: &'static str,
    context: PrivateCredentialContext,
    binding: String,
}
impl PrivateCredentialControl {
    pub(super) fn target(
        binding: &ReceivedPrivateCredentialBinding,
        profile: &std::path::Path,
    ) -> Result<Self> {
        let store = binding.reopen_secret(profile)?;
        let result = Self {
            binding: super::target::ordinary_context_digest(binding.context())?,
            context: binding.context().clone(),
            store,
            role: "target",
        };
        result.read()?;
        Ok(result)
    }
    pub(super) fn existing(
        store: &ordinary::Store,
        role: &'static str,
        offer: &PrivateCredentialOffer,
    ) -> Result<Self> {
        let control = Self {
            store: store.clone(),
            role,
            context: offer.context.clone(),
            binding: super::target::ordinary_context_digest(&offer.context)?,
        };
        control.read()?;
        Ok(control)
    }
    fn open(&self) -> Result<storage::Operation> {
        storage::controller(&self.store, self.role, &self.context, &self.binding)
    }
    fn state(&self, operation: &storage::Operation) -> Result<TransferState> {
        let (milestone, name) = match self.role {
            "source" => ("seal_started", "envelope.json"),
            "target" => ("receive_verified", "received-binding.json"),
            _ => unreachable!(),
        };
        // A writer may complete between the first milestone/proof observation
        // and its lease probe. Re-read after observing a free writer before
        // classifying an interrupted publication as unknown.
        for observation in 0..2 {
            let verified = operation.started(milestone)?;
            if verified
                && ordinary::load::<storage::BlobProof>(
                    &operation.directory,
                    &format!("{name}.proof.json"),
                )?
                .is_some()
            {
                if self.role == "source" {
                    storage::json::<PrivateCredentialEnvelope>(&operation.directory, name)?;
                } else {
                    storage::json::<ReceivedPrivateCredentialBinding>(&operation.directory, name)?;
                }
                return Ok(ordinary::control(&operation.directory)?.state(true));
            }
            let unverified_receive =
                self.role == "target" && operation.started("receive_started")?;
            if !verified && !unverified_receive || operation.writer_running()? {
                return Ok(ordinary::control(&operation.directory)?.state(false));
            }
            if observation == 1 {
                anyhow::bail!(if verified {
                    "private_credentials_publication_unknown"
                } else {
                    "private_credentials_receive_unconfirmed"
                });
            }
        }
        unreachable!()
    }
    pub fn read(&self) -> Result<TransferState> {
        self.state(&self.open()?)
    }
    pub fn cancel(&self, command_id: &str) -> Result<TransferState> {
        let operation = self.open()?;
        ordinary::cancel(&operation.directory, command_id)?;
        // cancelled only describes the persistent request; it does not mean a writer exited.
        self.state(&operation)
    }
    pub fn resume(&self, expected_sequence: u64, cancel_watermark: u64) -> Result<TransferState> {
        let operation = self.open()?;
        ordinary::resume(&operation.directory, expected_sequence, cancel_watermark)?;
        self.state(&operation)
    }
}

/// The authenticated target and original source receipt remain mandatory even for cancellation.
pub fn source_private_credential_control(
    source: &SourceTransfers,
    authenticated_target: &TransferAuthority,
    offer: &PrivateCredentialOffer,
) -> Result<PrivateCredentialControl> {
    let aad = crypto::offer_bytes(offer)?;
    ensure!(
        &offer.context.destination.authority == authenticated_target,
        "private_credentials_authority_changed"
    );
    let (store, _, manifest, _) = source.private_credential_scope(
        &offer.context.request_id,
        &offer.context.destination,
        &offer.context.entry_id,
    )?;
    ensure!(
        store.authority == offer.context.source
            && manifest.digest()? == offer.context.manifest_sha256,
        "private_credentials_authority_changed"
    );
    let result = PrivateCredentialControl {
        store,
        role: "source",
        context: offer.context.clone(),
        binding: crypto::digest(&aad),
    };
    result.read()?;
    Ok(result)
}

/// Cancel an already born target offer even before a source envelope was accepted.
pub fn target_private_credential_control(
    target: &super::super::IncomingTransfers,
    authenticated_source: &TransferAuthority,
    receipt: &super::super::TransferReceipt,
    offer: &PrivateCredentialOffer,
) -> Result<PrivateCredentialControl> {
    let store = super::target::existing_offer_store(target, authenticated_source, receipt, offer)?;
    let control = PrivateCredentialControl {
        store,
        role: "target",
        context: offer.context.clone(),
        binding: super::target::ordinary_context_digest(&offer.context)?,
    };
    let operation = control.open()?;
    let original: PrivateCredentialOffer = storage::json(&operation.directory, "offer.json")?;
    ensure!(&original == offer, "private_credentials_binding_changed");
    control.state(&operation)?;
    Ok(control)
}
