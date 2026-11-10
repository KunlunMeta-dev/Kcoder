//! Recover only an original source grant; neither a peer nor a namespace is created.
use super::*;
use anyhow::{Context, Result};
use std::path::Path;

/// Native host-only authority derives the destination from the original saved
/// offer and revalidates the original source request, manifest and private birth.
pub fn observe_existing_source_private_credentials(
    profile: &Path,
    request: &str,
    offer_id: &str,
) -> Result<PrivateCredentialObservation> {
    let source = super::super::SourceTransfers::open_existing(profile)?;
    let store = source.private_credential_existing_store()?;
    let offer = storage::recover_offer(&store, "source", request, offer_id)?;
    source
        .prepared_destination(request, &offer.context.destination.authority)?
        .context("private_credentials_binding_changed")?;
    read_source_private_credentials(
        &source,
        &offer.context.destination.authority,
        request,
        offer_id,
    )
}
