//! Read only original selected adapters, after consent; the relay sees only the persisted envelope.
use super::super::{SourceTransfers, model::TransferContent, storage as ordinary};
use super::{
    crypto::{self, Values},
    model::*,
    storage,
};
use anyhow::{Context, Result, ensure};

pub fn seal_private_credentials(
    source: &SourceTransfers,
    authenticated_target: &super::super::TransferAuthority,
    offer: &PrivateCredentialOffer,
    consent: PrivateCredentialConsent,
) -> Result<PrivateCredentialEnvelope> {
    consent.require(&offer.context.selections)?;
    ensure!(
        &offer.context.destination.authority == authenticated_target,
        "private_credentials_authority_changed"
    );
    let aad = crypto::offer_bytes(offer)?;
    let (store, binding, manifest, original_transfer) = source.private_credential_scope(
        &offer.context.request_id,
        &offer.context.destination,
        &offer.context.entry_id,
    )?;
    ensure!(
        store.authority == offer.context.source
            && manifest.digest()? == offer.context.manifest_sha256,
        "private_credentials_authority_changed"
    );
    let entry = manifest
        .entries
        .iter()
        .find(|entry| entry.id == offer.context.entry_id)
        .context("private_credentials_source_not_selected")?;
    let TransferContent::ConfigurationInventory {
        source_identity,
        source_binding_revision,
        ..
    } = &entry.content
    else {
        anyhow::bail!("private_credentials_source_not_selected")
    };
    ensure!(
        *source_identity == offer.context.source_identity
            && *source_binding_revision == offer.context.source_binding_revision,
        "private_credentials_binding_changed"
    );
    ordinary::active(&original_transfer)?;
    let operation = storage::operation(
        &store,
        "source",
        &offer.context,
        &crypto::digest(&aad),
        true,
    )?;
    ordinary::active(&operation.directory)?;
    if !operation.fresh {
        // A lost reply retrieves exactly the old ciphertext, never another HPKE encapsulation.
        let previous: PrivateCredentialEnvelope =
            storage::json(&operation.directory, "envelope.json")?;
        ensure!(
            previous.offer_id == offer.context.offer_id
                && previous.offer_sha256 == crypto::digest(&aad),
            "private_credentials_envelope_changed"
        );
        return Ok(previous);
    }
    operation.mark("seal_started")?;
    storage::publish_json(&operation.directory, "offer.json", offer)?;
    let inventory = binding.inventory()?;
    let mut values = Vec::new();
    for selection in &offer.context.selections {
        ordinary::active(&operation.directory)?;
        ordinary::active(&original_transfer)?;
        match selection {
            PrivateCredentialSelection::Provider {
                source_name,
                selector,
                endpoint,
                api_format,
                ..
            } => {
                let item = inventory
                    .items
                    .iter()
                    .find(|v| v.provider.is_some() && v.preview.source_name == *source_name)
                    .context("private_credentials_source_not_selected")?;
                binding.validate_provider_item(item)?;
                let candidate = item.provider.as_ref().unwrap();
                let declared = candidate.endpoint.as_deref().or_else(|| {
                    (binding.kind == kcoder_types::migration::MigrationSourceKind::ClaudeCode)
                        .then_some("https://api.anthropic.com")
                });
                ensure!(
                    declared
                        .is_some_and(|v| v.trim_end_matches('/') == endpoint.trim_end_matches('/'))
                        && candidate.api_format == *api_format,
                    "private_credentials_destination_mismatch"
                );
                if let crate::credentials::ApiKeySelector::Environment(variable) = selector {
                    ensure!(
                        candidate.credential_environment.as_deref() == Some(variable)
                            || binding.kind
                                == kcoder_types::migration::MigrationSourceKind::ClaudeCode
                                && variable == "ANTHROPIC_API_KEY",
                        "migration_credential_source_not_declared"
                    );
                }
                values.push(crate::credentials::read_key(
                    &binding,
                    selector,
                    source_name,
                )?);
            }
            PrivateCredentialSelection::Mcp {
                source_name,
                fields,
                definition_sha256,
                ..
            } => {
                let item = inventory
                    .items
                    .iter()
                    .find(|v| v.mcp.is_some() && v.preview.source_name == *source_name)
                    .context("private_credentials_source_not_selected")?;
                let config = &item.mcp.as_ref().unwrap().config;
                ensure!(
                    super::super::model::digest(config)? == *definition_sha256,
                    "private_credentials_destination_mismatch"
                );
                for field in fields {
                    match field {
                        kcoder_types::migration::MigrationMcpPrivateField::Environment(name) => {
                            ensure!(
                                config.env.contains_key(name)
                                    || config.policy.required_env.contains(name),
                                "private_credentials_field_not_declared"
                            )
                        }
                        kcoder_types::migration::MigrationMcpPrivateField::Header(name) => ensure!(
                            config
                                .headers
                                .keys()
                                .chain(&config.policy.required_headers)
                                .any(|v| v.eq_ignore_ascii_case(name)),
                            "private_credentials_field_not_declared"
                        ),
                    }
                }
                values.push(crate::mcp_credentials::read_private_literals(
                    &binding,
                    source_name,
                    fields,
                )?);
            }
        }
    }
    // Revalidate the pinned source after extraction; no refreshed or home fallback is permitted.
    binding.read()?;
    let values = Values(values);
    let envelope = crypto::seal(offer, &values)?;
    ordinary::active(&operation.directory)?;
    ordinary::active(&original_transfer)?;
    storage::publish_json(&operation.directory, "envelope.json", &envelope)?;
    Ok(envelope)
}
