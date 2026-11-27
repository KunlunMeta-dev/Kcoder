//! Received keys retain their original ciphertext authority; no synthetic source file is created.
use super::*;
use crate::source_transfer::private_credentials::{
    CredentialSourceBinding, ReceivedCredentialInput,
};

impl CredentialTarget {
    pub(crate) fn prepare_received_prospective(
        &self,
        item: &NormalizedItem,
        input: ReceivedCredentialInput<'_>,
        destination: (&str, ProviderConfig),
        selector: ApiKeySelector,
        consent: bool,
    ) -> Result<CredentialPlan> {
        let ReceivedCredentialInput {
            source,
            material: received,
            execution,
            policy,
            backend,
        } = input;
        ensure!(consent, "migration_credential_consent_required");
        ensure!(
            received.policy() == policy,
            "private_credentials_policy_changed"
        );
        received.validate_source(source, item)?;
        let (target_name, provider) = destination;
        let inventory = source.inventory()?;
        let original = inventory
            .items
            .iter()
            .find(|v| v.provider.is_some() && v.preview.source_name == item.preview.source_name)
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
        let candidate = original.provider.as_ref().unwrap();
        let endpoint = candidate
            .endpoint
            .as_deref()
            .or_else(|| {
                (source.source().ok() == Some(MigrationSourceKind::ClaudeCode))
                    .then_some("https://api.anthropic.com")
            })
            .ok_or_else(|| anyhow::anyhow!("migration_credential_source_endpoint_unknown"))?;
        ensure!(
            same_endpoint(endpoint, &provider.endpoint)
                && provider.api_format.as_str() == candidate.api_format
                && provider.authentication.is_api_key(),
            "migration_credential_destination_mismatch"
        );
        let key = received.provider_key(
            &self.directory_identity()?,
            backend,
            &item.preview.source_name,
            target_name,
            &selector,
            execution,
        )?;
        let reference = self
            .store
            .prepare(target_name, policy, backend)
            .map_err(safe_error)?;
        Ok(CredentialPlan {
            plan_id: reference.operation_id.clone(),
            item_id: item.preview.id.clone(),
            target_name: target_name.into(),
            endpoint: provider.endpoint.clone(),
            selector,
            source: CredentialSourceBinding::Received(Box::new(received.clone())),
            reference,
            provider,
            policy,
            phase: CredentialPhase::Ready,
            undo_requested: false,
            error_code: None,
            atomic_group_id: None,
            fingerprint: hash(&key),
        })
    }
}
