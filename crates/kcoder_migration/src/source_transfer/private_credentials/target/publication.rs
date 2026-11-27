//! Original private writer ownership spans all bundle preparation and its job checkpoint.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicationClaim {
    pub job_id: String,
    pub original_plan_id: String,
    pub action_id: String,
    pub plan_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
}

/// Native-only execution authority. It cannot be deserialized, cloned or logged.
pub struct ReceivedPrivateCredentialLease {
    binding: ReceivedPrivateCredentialBinding,
    operation: storage::Operation,
}
impl ReceivedPrivateCredentialBinding {
    pub(crate) fn publication_lease(
        &self,
        profile: &std::path::Path,
    ) -> Result<ReceivedPrivateCredentialLease> {
        let store = self.reopen_secret(profile)?;
        let operation = storage::operation(
            &store,
            "target",
            &self.context,
            &ordinary_context_digest(&self.context)?,
            false,
        )?;
        ordinary::active(&operation.directory)?;
        Ok(ReceivedPrivateCredentialLease {
            binding: self.clone(),
            operation,
        })
    }
}
impl ReceivedPrivateCredentialLease {
    pub(crate) fn ensure_active(&self) -> Result<()> {
        ordinary::active(&self.operation.directory)
    }
    pub(in crate::source_transfer::private_credentials) fn values(
        &self,
        expected: &ReceivedPrivateCredentialBinding,
        identity: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<Values> {
        ensure!(
            expected == &self.binding && identity == self.binding.profile_identity,
            "private_credentials_wrong_consumer"
        );
        self.binding
            .values_at_operation(identity, backend, &self.operation)
    }
    pub(crate) fn existing_claim(&self) -> Result<Option<PublicationClaim>> {
        self.ensure_active()?;
        if self.operation.started("publication_started")? {
            return storage::json(&self.operation.directory, "publication.json").map(Some);
        }
        // An unexplained object does not authorize completing another actor's birth.
        ensure!(
            ordinary::load::<storage::BlobProof>(
                &self.operation.directory,
                "publication.json.proof.json"
            )?
            .is_none()
                && ordinary::load::<PublicationClaim>(
                    &self.operation.directory,
                    "publication.json"
                )?
                .is_none(),
            "private_credentials_publication_unknown"
        );
        Ok(None)
    }
    pub(crate) fn claim(
        &self,
        expected: &PublicationClaim,
        allow_legacy_single: bool,
    ) -> Result<()> {
        self.ensure_active()?;
        if let Some(saved) = self.existing_claim()? {
            ensure!(
                saved.job_id == expected.job_id
                    && saved.original_plan_id == expected.original_plan_id
                    && saved.action_id == expected.action_id
                    && saved.plan_id == expected.plan_id
                    && (saved.bundle_sha256 == expected.bundle_sha256
                        || allow_legacy_single && saved.bundle_sha256.is_none()),
                "private_credentials_publication_binding_changed"
            );
            return Ok(());
        }
        self.operation.mark("publication_started")?;
        storage::publish_json(&self.operation.directory, "publication.json", expected)
    }
}

/// Stable native binding of the complete set; no secret values or transient sessions.
pub(crate) fn private_credential_bundle_digest(
    job_id: &str,
    original_plan_id: &str,
    action_id: &str,
    offers: &[&ReceivedPrivateCredentialBinding],
) -> Result<String> {
    super::super::super::model::digest(&(
        "private-credential-publication-bundle/v1",
        job_id,
        original_plan_id,
        action_id,
        offers,
    ))
}

impl ReceivedPrivateCredentialLease {
    pub(crate) fn existing_preparation(
        &self,
        job: &str,
    ) -> Result<Option<super::super::preparation::PreparationIntent>> {
        self.operation.preparation(job)
    }
    pub(crate) fn reserve_preparation(
        &self,
        intent: &super::super::preparation::PreparationIntent,
    ) -> Result<()> {
        self.operation.reserve_preparation(intent)
    }
}
impl ReceivedPrivateCredentialBinding {
    pub(crate) fn received_request_id(&self) -> &str {
        &self.context.request_id
    }
    pub(crate) fn observed_publication_claim(
        &self,
        profile: &std::path::Path,
    ) -> Result<Option<PublicationClaim>> {
        let store = self.reopen_secret(profile)?;
        let operation = storage::controller(
            &store,
            "target",
            &self.context,
            &ordinary_context_digest(&self.context)?,
        )?;
        if operation.started("publication_started")? {
            storage::json(&operation.directory, "publication.json").map(Some)
        } else {
            Ok(None)
        }
    }
}
