//! Pure custody observation. A missing acknowledged object never grants fresh creation.
use super::super::{IncomingTransfers, SourceTransfers, TransferAuthority, TransferState};
use super::{
    PrivateCredentialEnvelope, PrivateCredentialOffer, ReceivedPrivateCredentialBinding,
    control::PrivateCredentialControl, crypto, storage,
};
use anyhow::{Result, ensure};

/// Native-only result. The private relay may forward the original offer and
/// ciphertext; public clients receive only a separate metadata projection.
pub struct PrivateCredentialObservation {
    pub offer: PrivateCredentialOffer,
    pub envelope: Option<PrivateCredentialEnvelope>,
    pub received: Option<ReceivedPrivateCredentialBinding>,
    pub control: TransferState,
    pub writer_running: bool,
    pub key_released: bool,
    controller: PrivateCredentialControl,
}
impl PrivateCredentialObservation {
    pub fn controller(&self) -> &PrivateCredentialControl {
        &self.controller
    }
}

pub fn read_source_private_credentials(
    source: &SourceTransfers,
    authenticated_target: &TransferAuthority,
    request_id: &str,
    offer_id: &str,
) -> Result<PrivateCredentialObservation> {
    let store = source.private_credential_existing_store()?;
    let offer = storage::recover_offer(&store, "source", request_id, offer_id)?;
    ensure!(
        offer.context.source == *source.authority()
            && offer.context.destination.authority == *authenticated_target,
        "private_credentials_authority_changed"
    );
    // The original saved selection and destination remain mandatory; this does
    // not read the source's credential bytes or create a namespace.
    let control = super::source_private_credential_control(source, authenticated_target, &offer)?;
    observe(&store, "source", offer, control)
}

pub fn read_target_private_credentials(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    request_id: &str,
    offer_id: &str,
    backend: &dyn kcoder_config::CredentialBackend,
) -> Result<PrivateCredentialObservation> {
    let store = target.private_credential_existing_store()?;
    let offer = storage::recover_offer(&store, "target", request_id, offer_id)?;
    ensure!(
        offer.context.source == *authenticated_source
            && offer.context.destination.authority == *target.authority()
            && offer.context.target_profile_identity == store.identity,
        "private_credentials_authority_changed"
    );
    let operation = storage::controller(
        &store,
        "target",
        &offer.context,
        &super::target::ordinary_context_digest(&offer.context)?,
    )?;
    if !operation.started("key_deleted")? {
        super::target::read_key(&operation.directory, &offer, backend)?;
    }
    let control = PrivateCredentialControl::existing(&store, "target", &offer)?;
    observe(&store, "target", offer, control)
}

fn observe(
    store: &super::super::storage::Store,
    role: &'static str,
    offer: PrivateCredentialOffer,
    controller: PrivateCredentialControl,
) -> Result<PrivateCredentialObservation> {
    let operation = storage::controller(
        store,
        role,
        &offer.context,
        &storage::offer_binding(role, &offer)?,
    )?;
    let writer_running = operation.writer_running()?;
    let key_released = role == "target" && operation.started("key_deleted")?;
    let control = controller.read()?;
    let envelope = if role == "source" && control.ready {
        let envelope: PrivateCredentialEnvelope =
            storage::json(&operation.directory, "envelope.json")?;
        ensure!(
            envelope.offer_id == offer.context.offer_id
                && envelope.offer_sha256 == crypto::digest(&crypto::offer_bytes(&offer)?),
            "private_credentials_binding_changed"
        );
        Some(envelope)
    } else {
        None
    };
    let received = if role == "target" && control.ready {
        let binding: ReceivedPrivateCredentialBinding =
            storage::json(&operation.directory, "received-binding.json")?;
        binding.verify_observation(store, &offer)?;
        Some(binding)
    } else {
        None
    };
    Ok(PrivateCredentialObservation {
        offer,
        envelope,
        received,
        control,
        writer_running,
        key_released,
        controller,
    })
}
