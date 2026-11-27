//! Destination offer/key and ciphertext custody, independent of ordinary received IR.
use super::super::{
    IncomingTransfers,
    model::{TransferAuthority, TransferContent, TransferReceipt},
    storage as ordinary,
};
use super::{
    crypto::{self, PrivateKey, Values},
    model::*,
    storage,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use kcoder_config::{CredentialBackend, CredentialStoreMode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct KeyIntent {
    pub public_key: String,
    pub fingerprint: String,
    pub account: Option<String>,
}

mod publication;
pub use publication::ReceivedPrivateCredentialLease;
pub(crate) use publication::{PublicationClaim, private_credential_bundle_digest};

/// Native-only offer intent. Authenticated peer identity comes from the host, not RPC data.
pub struct PrivateCredentialOfferInput<'a> {
    pub request: &'a str,
    pub authenticated_source: &'a TransferAuthority,
    pub receipt: &'a TransferReceipt,
    pub entry: &'a str,
    pub offer_id: &'a str,
    pub selections: Vec<PrivateCredentialSelection>,
    pub consent: PrivateCredentialConsent,
    pub policy: CredentialStoreMode,
}

pub fn prepare_private_credential_offer(
    target: &IncomingTransfers,
    input: PrivateCredentialOfferInput<'_>,
    backend: &dyn CredentialBackend,
) -> Result<PrivateCredentialOffer> {
    let PrivateCredentialOfferInput {
        request,
        authenticated_source,
        receipt,
        entry,
        offer_id,
        selections,
        consent,
        policy,
    } = input;
    consent.require(&selections)?;
    let (store, binding, manifest) =
        target.private_credential_scope(request, authenticated_source, receipt, entry)?;
    store.require_creation()?;
    ensure!(
        !binding.source_scope()?.starts_with("project"),
        "private_credentials_project_scope_unsupported"
    );
    ensure!(
        policy == read_policy(&store.profile)?,
        "private_credentials_policy_changed"
    );
    let selected = manifest
        .entries
        .iter()
        .find(|v| v.id == entry)
        .context("private_credentials_source_not_selected")?;
    let TransferContent::ConfigurationInventory {
        source_identity,
        source_binding_revision,
        ..
    } = &selected.content
    else {
        anyhow::bail!("private_credentials_source_not_selected")
    };
    let context = PrivateCredentialContext {
        version: 1,
        request_id: request.into(),
        offer_id: offer_id.into(),
        source: authenticated_source.clone(),
        destination: manifest.destination.clone(),
        manifest_sha256: manifest.digest()?,
        entry_id: entry.into(),
        source_identity: source_identity.clone(),
        source_binding_revision: source_binding_revision.clone(),
        target_profile_identity: store.identity.clone(),
        target_policy: policy,
        selections,
    };
    context.validate()?;
    validate_selections(&context, &binding.inventory()?)?;
    // Admit the exact encoded metadata bound before a namespace or recipient
    // key is born. Every real X25519 public key has the same base64 width;
    // this placeholder is never used by HPKE or persisted as an offer.
    crypto::offer_bytes(&PrivateCredentialOffer {
        context: context.clone(),
        suite: PRIVATE_SUITE.into(),
        public_key: STANDARD.encode([0_u8; 32]),
    })?;
    let digest = ordinary_context_digest(&context)?;
    let operation = storage::operation(&store, "target", &context, &digest, true)?;
    ordinary::active(&operation.directory)?;
    if !operation.fresh {
        let offer: PrivateCredentialOffer = storage::json(&operation.directory, "offer.json")?;
        ensure!(
            offer.context == context,
            "private_credentials_binding_changed"
        );
        read_key(&operation.directory, &offer, backend)?;
        return Ok(offer);
    }
    let use_keyring = match policy {
        CredentialStoreMode::File => false,
        CredentialStoreMode::Keyring => {
            ensure!(
                backend.available(),
                "private_credentials_keyring_unavailable"
            );
            true
        }
        CredentialStoreMode::Auto => backend.available(),
    };
    operation.mark("key_started")?;
    let (public_key, key) = PrivateKey::generate()?;
    let account = use_keyring.then(|| {
        format!(
            "migration-private-{}",
            uuid::Uuid::parse_str(offer_id).unwrap().simple()
        )
    });
    let key_bytes = key.bytes();
    let intent = KeyIntent {
        public_key: public_key.clone(),
        fingerprint: crypto::digest(&key_bytes),
        account,
    };
    storage::publish_json(&operation.directory, "key-intent.json", &intent)?;
    if let Some(account) = &intent.account {
        ensure!(
            backend
                .get(account)
                .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?
                .is_none(),
            "private_credentials_key_unknown"
        );
        let encoded = Zeroizing::new(STANDARD.encode(&*key_bytes));
        // A backend may have committed before returning an error. Never repeat set.
        let result = backend.set(account, &encoded);
        let observed = backend
            .get(account)
            .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?
            .map(Zeroizing::new)
            .context("private_credentials_key_unknown")?;
        ensure!(
            observed.as_str() == encoded.as_str(),
            "private_credentials_key_unknown"
        );
        drop(result);
    } else {
        storage::publish(&operation.directory, "private-key.bin", &key_bytes)?;
    }
    let offer = PrivateCredentialOffer {
        context,
        suite: PRIVATE_SUITE.into(),
        public_key,
    };
    storage::publish_json(&operation.directory, "offer.json", &offer)?;
    Ok(offer)
}

pub(super) fn ordinary_context_digest(context: &PrivateCredentialContext) -> Result<String> {
    super::super::model::digest(&("private-credential.context/1", context))
}

pub(super) fn existing_offer_store(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    receipt: &TransferReceipt,
    offer: &PrivateCredentialOffer,
) -> Result<ordinary::Store> {
    crypto::offer_bytes(offer)?;
    let (store, binding, manifest) = target.private_credential_scope(
        &offer.context.request_id,
        authenticated_source,
        receipt,
        &offer.context.entry_id,
    )?;
    binding.private_credential_matches(&offer.context)?;
    ensure!(
        store.authority == offer.context.destination.authority
            && store.identity == offer.context.target_profile_identity
            && manifest.digest()? == offer.context.manifest_sha256,
        "private_credentials_authority_changed"
    );
    Ok(store)
}

pub(super) fn read_key(
    directory: &kcoder_config::PrivateDirectory,
    offer: &PrivateCredentialOffer,
    backend: &dyn CredentialBackend,
) -> Result<PrivateKey> {
    let intent: KeyIntent = storage::json(directory, "key-intent.json")?;
    ensure!(
        intent.public_key == offer.public_key,
        "private_credentials_key_unknown"
    );
    let bytes = if let Some(account) = &intent.account {
        ensure!(
            *account
                == format!(
                    "migration-private-{}",
                    uuid::Uuid::parse_str(&offer.context.offer_id)
                        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_offer"))?
                        .simple()
                ),
            "private_credentials_key_unknown"
        );
        let text = backend
            .get(account)
            .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?
            .map(Zeroizing::new)
            .context("private_credentials_key_unknown")?;
        ensure!(text.len() == 44, "private_credentials_key_unknown");
        Zeroizing::new(
            STANDARD
                .decode(text.as_bytes())
                .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?,
        )
    } else {
        ensure!(
            offer.context.target_policy != CredentialStoreMode::Keyring,
            "private_credentials_file_fallback_forbidden"
        );
        storage::read(directory, "private-key.bin")?
    };
    ensure!(
        crypto::digest(&bytes) == intent.fingerprint,
        "private_credentials_key_unknown"
    );
    PrivateKey::restore(bytes.to_vec())
}

/// Private journal binding only. It cannot be deserialized as an RPC source grant.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedPrivateCredentialBinding {
    profile: PathBuf,
    profile_identity: String,
    target: TransferAuthority,
    context: PrivateCredentialContext,
    receipt: TransferReceipt,
    offer_sha256: String,
    envelope_sha256: String,
}
impl std::fmt::Debug for ReceivedPrivateCredentialBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceivedPrivateCredentialBinding")
            .field("offer_id", &self.context.offer_id)
            .finish_non_exhaustive()
    }
}

pub fn accept_private_credential_envelope(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    receipt: &TransferReceipt,
    offer: &PrivateCredentialOffer,
    envelope: &PrivateCredentialEnvelope,
    consent: PrivateCredentialConsent,
    backend: &dyn CredentialBackend,
) -> Result<ReceivedPrivateCredentialBinding> {
    consent.require(&offer.context.selections)?;
    let (store, _, manifest) = target.private_credential_scope(
        &offer.context.request_id,
        authenticated_source,
        receipt,
        &offer.context.entry_id,
    )?;
    ensure!(
        store.authority == offer.context.destination.authority
            && store.identity == offer.context.target_profile_identity
            && manifest.digest()? == offer.context.manifest_sha256,
        "private_credentials_authority_changed"
    );
    let operation = storage::operation(
        &store,
        "target",
        &offer.context,
        &ordinary_context_digest(&offer.context)?,
        false,
    )?;
    ordinary::active(&operation.directory)?;
    let original: PrivateCredentialOffer = storage::json(&operation.directory, "offer.json")?;
    ensure!(&original == offer, "private_credentials_binding_changed");
    let envelope_bytes = serde_json::to_vec(envelope)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_envelope"))?;
    if operation.started("receive_started")? {
        let previous: PrivateCredentialEnvelope =
            storage::json(&operation.directory, "received.json")?;
        ensure!(
            &previous == envelope,
            "private_credentials_envelope_changed"
        );
    } else {
        operation.mark("receive_started")?;
        storage::publish(&operation.directory, "received.json", &envelope_bytes)?;
    }
    let key = read_key(&operation.directory, offer, backend)?;
    let values = crypto::open(offer, envelope, &key)?;
    validate_values(offer, &values)?;
    let binding = ReceivedPrivateCredentialBinding {
        profile: store.profile,
        profile_identity: store.identity,
        target: store.authority,
        context: offer.context.clone(),
        receipt: receipt.clone(),
        offer_sha256: crypto::digest(&crypto::offer_bytes(offer)?),
        envelope_sha256: crypto::digest(&envelope_bytes),
    };
    if operation.started("receive_verified")? {
        let original: ReceivedPrivateCredentialBinding =
            storage::json(&operation.directory, "received-binding.json")?;
        ensure!(original == binding, "private_credentials_binding_changed");
    } else {
        // Persist intent before the immutable receipt; an ambiguous publication
        // is reconciled through its original proof, never by another binding.
        operation.mark("receive_verified")?;
        storage::publish_json(&operation.directory, "received-binding.json", &binding)?;
    }
    Ok(binding)
}

impl ReceivedPrivateCredentialBinding {
    pub(super) fn verify_observation(
        &self,
        store: &ordinary::Store,
        offer: &PrivateCredentialOffer,
    ) -> Result<()> {
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&self.profile)?.directory_identity()?
                == store.identity
                && self.profile_identity == store.identity
                && self.target == store.authority
                && self.context == offer.context
                && self.receipt.request_id == self.context.request_id
                && self.receipt.manifest_sha256 == self.context.manifest_sha256
                && self.offer_sha256 == crypto::digest(&crypto::offer_bytes(offer)?),
            "private_credentials_binding_changed"
        );
        let operation = storage::controller(
            store,
            "target",
            &self.context,
            &ordinary_context_digest(&self.context)?,
        )?;
        let envelope = storage::read(&operation.directory, "received.json")?;
        ensure!(
            crypto::digest(&envelope) == self.envelope_sha256,
            "private_credentials_binding_changed"
        );
        Ok(())
    }
    pub(super) fn context(&self) -> &PrivateCredentialContext {
        &self.context
    }
    pub(super) fn reopen_secret(&self, profile: &std::path::Path) -> Result<ordinary::Store> {
        let directory = kcoder_config::PrivateDirectory::open_existing(profile)?;
        ensure!(
            directory.directory_identity()? == self.profile_identity,
            "private_credentials_wrong_consumer"
        );
        ordinary::Store::reopen_private_credentials(
            &self.profile,
            &self.profile_identity,
            &self.target,
        )
    }
    pub fn control(
        &self,
        profile: &std::path::Path,
    ) -> Result<super::control::PrivateCredentialControl> {
        super::control::PrivateCredentialControl::target(self, profile)
    }
    /// Read-only verification against the original native profile and key. No
    /// plaintext, key fingerprint or authority can be returned to a caller.
    pub fn verify_material(
        &self,
        profile: &std::path::Path,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        self.values(profile, backend).map(drop)
    }
    pub(crate) fn selections(&self) -> &[PrivateCredentialSelection] {
        &self.context.selections
    }
    pub(crate) fn policy(&self) -> CredentialStoreMode {
        self.context.target_policy
    }
    pub fn configuration_binding(&self) -> Result<super::super::TransferredConfigurationBinding> {
        let receiver = IncomingTransfers::open_existing_private_credentials(
            &self.profile,
            &self.profile_identity,
            &self.target,
        )?;
        receiver.configuration_binding(
            &self.context.request_id,
            &self.context.source,
            &self.context.entry_id,
            &self.receipt,
        )
    }
    pub(crate) fn validate_source(
        &self,
        source: &super::super::TransferredConfigurationBinding,
        item: &crate::NormalizedItem,
    ) -> Result<()> {
        source.private_credential_matches(&self.context)?;
        source.validate_item(item)
    }
    pub(super) fn values(
        &self,
        profile: &std::path::Path,
        backend: &dyn CredentialBackend,
    ) -> Result<Values> {
        let directory = kcoder_config::PrivateDirectory::open_existing(profile)?;
        ensure!(
            directory.directory_identity()? == self.profile_identity,
            "private_credentials_wrong_consumer"
        );
        self.values_for_identity(&directory.directory_identity()?, backend)
    }
    pub(super) fn values_for_identity(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<Values> {
        ensure!(
            profile_identity == self.profile_identity,
            "private_credentials_wrong_consumer"
        );
        let profile = &self.profile;
        ensure!(
            read_policy(profile)? == self.context.target_policy,
            "private_credentials_policy_changed"
        );
        let receiver = IncomingTransfers::open_existing_private_credentials(
            &self.profile,
            &self.profile_identity,
            &self.target,
        )?;
        let (store, _, manifest) = receiver.private_credential_scope(
            &self.context.request_id,
            &self.context.source,
            &self.receipt,
            &self.context.entry_id,
        )?;
        ensure!(
            manifest.digest()? == self.context.manifest_sha256,
            "private_credentials_binding_changed"
        );
        let operation = storage::operation(
            &store,
            "target",
            &self.context,
            &ordinary_context_digest(&self.context)?,
            false,
        )?;
        self.values_at_operation(profile_identity, backend, &operation)
    }
    pub(super) fn values_at_operation(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
        operation: &storage::Operation,
    ) -> Result<Values> {
        ensure!(
            profile_identity == self.profile_identity,
            "private_credentials_wrong_consumer"
        );
        ensure!(
            read_policy(&self.profile)? == self.context.target_policy,
            "private_credentials_policy_changed"
        );
        let receiver = IncomingTransfers::open_existing_private_credentials(
            &self.profile,
            &self.profile_identity,
            &self.target,
        )?;
        let (_, _, manifest) = receiver.private_credential_scope(
            &self.context.request_id,
            &self.context.source,
            &self.receipt,
            &self.context.entry_id,
        )?;
        ensure!(
            manifest.digest()? == self.context.manifest_sha256,
            "private_credentials_binding_changed"
        );
        ordinary::active(&operation.directory)?;
        let offer: PrivateCredentialOffer = storage::json(&operation.directory, "offer.json")?;
        let envelope: PrivateCredentialEnvelope =
            storage::json(&operation.directory, "received.json")?;
        ensure!(
            offer.context == self.context
                && crypto::digest(&crypto::offer_bytes(&offer)?) == self.offer_sha256
                && crypto::digest(&serde_json::to_vec(&envelope)?) == self.envelope_sha256,
            "private_credentials_binding_changed"
        );
        let key = read_key(&operation.directory, &offer, backend)?;
        let values = crypto::open(&offer, &envelope, &key)?;
        validate_values(&offer, &values)?;
        Ok(values)
    }
    pub fn offer_id(&self) -> &str {
        &self.context.offer_id
    }
}

fn read_policy(profile: &std::path::Path) -> Result<CredentialStoreMode> {
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(profile)?,
    )?
    .read()?;
    settings
        .get("credential_store")
        .map(|v| {
            serde_json::from_value(v.clone())
                .map_err(|_| anyhow::anyhow!("private_credentials_policy_changed"))
        })
        .unwrap_or(Ok(CredentialStoreMode::Auto))
}

fn validate_values(offer: &PrivateCredentialOffer, values: &Values) -> Result<()> {
    ensure!(
        offer.context.selections.len() == values.0.len(),
        "private_credentials_invalid_payload"
    );
    for (selection, value) in offer.context.selections.iter().zip(&values.0) {
        match selection {
            PrivateCredentialSelection::Provider { .. } => ensure!(
                !value.is_empty()
                    && value.len() <= 16 * 1024
                    && value.trim() == value.as_str()
                    && !value.chars().any(char::is_control),
                "migration_credential_invalid_api_key"
            ),
            PrivateCredentialSelection::Mcp { fields, .. } => {
                let values: kcoder_config::imported_credentials::mcp::McpSecretValues =
                    serde_json::from_str(value)
                        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_payload"))?;
                values
                    .encode()
                    .map_err(crate::mcp_credentials::safe_error)?;
                let actual = values
                    .env
                    .keys()
                    .cloned()
                    .map(kcoder_types::migration::MigrationMcpPrivateField::Environment)
                    .chain(values.headers.keys().map(|name| {
                        kcoder_types::migration::MigrationMcpPrivateField::Header(
                            name.to_ascii_lowercase(),
                        )
                    }))
                    .collect::<std::collections::BTreeSet<_>>();
                ensure!(
                    actual == fields.iter().cloned().collect(),
                    "private_credentials_field_set_changed"
                );
            }
        }
    }
    Ok(())
}

fn validate_selections(
    context: &PrivateCredentialContext,
    inventory: &crate::MigrationInventory,
) -> Result<()> {
    for selection in &context.selections {
        match selection {
            PrivateCredentialSelection::Provider {
                source_name,
                endpoint,
                api_format,
                ..
            } => {
                let item = inventory
                    .items
                    .iter()
                    .find(|item| {
                        item.provider.is_some() && item.preview.source_name == *source_name
                    })
                    .context("private_credentials_source_not_selected")?;
                let candidate = item.provider.as_ref().unwrap();
                let declared = candidate.endpoint.as_deref().or_else(|| {
                    (inventory.source == kcoder_types::migration::MigrationSourceKind::ClaudeCode)
                        .then_some("https://api.anthropic.com")
                });
                ensure!(
                    candidate.api_format == *api_format
                        && declared.is_some_and(
                            |v| v.trim_end_matches('/') == endpoint.trim_end_matches('/')
                        ),
                    "private_credentials_destination_mismatch"
                );
            }
            PrivateCredentialSelection::Mcp {
                source_name,
                definition_sha256,
                ..
            } => {
                let item = inventory
                    .items
                    .iter()
                    .find(|item| item.mcp.is_some() && item.preview.source_name == *source_name)
                    .context("private_credentials_source_not_selected")?;
                ensure!(
                    super::super::model::digest(&item.mcp.as_ref().unwrap().config)?
                        == *definition_sha256,
                    "private_credentials_destination_mismatch"
                );
            }
        }
    }
    Ok(())
}
