use anyhow::{Result, ensure};
use kcoder_types::integrations::core::{
    IntegrationDelegationAction, IntegrationDelegationPrepareParams, IntegrationDelegationPurpose,
    IntegrationEntityRef, IntegrationOwner, IntegrationRevisionRef, IntegrationScope,
};
use ring::signature::{self, Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const SIGNATURE_CONTEXT: &[u8] = b"kcoder-native-service-delegation-v1\0";
pub(super) const MAX_PROOF_BYTES: usize = 64 * 1024;

/// Constructed by the native host from its trusted SDK observation reader.
/// Deliberately not Deserialize: a public request cannot manufacture these facts.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedDelegationSubject {
    pub connection_ref: IntegrationRevisionRef,
    pub observed_subject_ref: IntegrationRevisionRef,
    pub source_revision: String,
    pub channel_instance_id: String,
}

impl AuthenticatedDelegationSubject {
    pub(super) fn validate(&self) -> Result<()> {
        self.connection_ref.validate()?;
        self.observed_subject_ref.validate()?;
        label(&self.source_revision)?;
        label(&self.channel_instance_id)
    }
}

/// Native policy facts are re-read for every use, including existing connections.
/// They are not a remotely deserializable grant or a tool allow-all policy.
pub struct AuthenticatedDelegationPolicy {
    pub scope: IntegrationScope,
    pub revision: String,
    pub allowed_actions: BTreeSet<IntegrationDelegationAction>,
    pub resource_refs: Vec<IntegrationEntityRef>,
}

impl AuthenticatedDelegationPolicy {
    pub fn authorize_issue(
        &self,
        params: &IntegrationDelegationPrepareParams,
        subject: &AuthenticatedDelegationSubject,
    ) -> Result<()> {
        params.validate()?;
        subject.validate()?;
        ensure!(
            subject.connection_ref.id == params.connection_id
                && subject.observed_subject_ref == params.observed_subject_ref,
            "DELEGATION_OBSERVATION_MISMATCH"
        );
        self.check(&params.actions, &params.resource_refs)
    }

    pub(super) fn check(
        &self,
        actions: &BTreeSet<IntegrationDelegationAction>,
        resources: &[IntegrationEntityRef],
    ) -> Result<()> {
        self.scope.validate()?;
        label(&self.revision)?;
        ensure!(
            actions.is_subset(&self.allowed_actions)
                && resources
                    .iter()
                    .all(|item| self.resource_refs.contains(item)),
            "DELEGATION_POLICY_DENIED"
        );
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubjectBinding {
    pub connection_ref: IntegrationRevisionRef,
    pub observed_subject_ref: IntegrationRevisionRef,
    pub source_revision: String,
    pub channel_instance_id: String,
}

impl From<&AuthenticatedDelegationSubject> for SubjectBinding {
    fn from(subject: &AuthenticatedDelegationSubject) -> Self {
        Self {
            connection_ref: subject.connection_ref.clone(),
            observed_subject_ref: subject.observed_subject_ref.clone(),
            source_revision: subject.source_revision.clone(),
            channel_instance_id: subject.channel_instance_id.clone(),
        }
    }
}

impl SubjectBinding {
    /// Socket/CAS revisions are issuance observations. Stable security source and
    /// principal revisions must still match after a legitimate service reconnect.
    pub(super) fn same_principal(&self, subject: &AuthenticatedDelegationSubject) -> bool {
        self.connection_ref.id == subject.connection_ref.id
            && self.observed_subject_ref == subject.observed_subject_ref
            && self.source_revision == subject.source_revision
    }
}

/// Decode-only history for the shared issuer journal. New grants never contain a service lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetiredServiceLease {
    pub template: String,
    pub lease_id: String,
    pub operation_id: String,
    pub scope: IntegrationScope,
    pub source_binding_ref: IntegrationRevisionRef,
    pub source_connection_id: String,
    pub observed_subject_ref: IntegrationRevisionRef,
    pub source_revision: String,
    pub configuration_sha256: String,
    pub native_image_sha256: String,
    pub actions: BTreeSet<IntegrationDelegationAction>,
    pub expires_at_ms: kcoder_types::integrations::core::IntegrationAuthorizationTime,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DelegationClaims {
    pub version: u32,
    pub issuer_id: String,
    pub delegation_id: String,
    pub nonce: String,
    pub owner: IntegrationOwner,
    pub purpose: IntegrationDelegationPurpose,
    pub audience: String,
    pub identity_epoch: String,
    pub identity_generation: String,
    pub target_revision: String,
    pub policy_revision: String,
    pub subject: SubjectBinding,
    pub actions: BTreeSet<IntegrationDelegationAction>,
    pub resource_refs: Vec<IntegrationEntityRef>,
    pub issued_at_ms: u64,
    pub expires_at_ms: kcoder_types::integrations::core::IntegrationAuthorizationTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_lease: Option<RetiredServiceLease>,
}

/// Private IPC proof. It contains no caller-selectable verification key.
/// Keep it out of model context, public replies, logs, and diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedDelegation {
    pub(super) claims: DelegationClaims,
    pub(super) signature: Vec<u8>,
}

impl std::fmt::Debug for SignedDelegation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SignedDelegation { proof: redacted }")
    }
}

impl SignedDelegation {
    pub fn to_private_bytes(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= MAX_PROOF_BYTES, "DELEGATION_PROOF_TOO_LARGE");
        Ok(bytes)
    }

    /// Parsing is not verification. Only NativeDelegationAuthority authorizes use.
    pub fn from_private_bytes(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= MAX_PROOF_BYTES, "DELEGATION_PROOF_TOO_LARGE");
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("DELEGATION_PROOF_INVALID"))
    }

    pub(super) fn sign(claims: DelegationClaims, key: &Ed25519KeyPair) -> Result<Self> {
        let signature = key.sign(&signing_bytes(&claims)?).as_ref().to_vec();
        Ok(Self { claims, signature })
    }

    pub(super) fn verify(&self, key: &Ed25519KeyPair) -> Result<()> {
        signature::UnparsedPublicKey::new(&signature::ED25519, key.public_key().as_ref())
            .verify(&signing_bytes(&self.claims)?, &self.signature)
            .map_err(|_| anyhow::anyhow!("DELEGATION_SIGNATURE_INVALID"))
    }
}

/// An exact, non-serializable permit. Hosts must revalidate before each effect.
pub struct DelegationPermit {
    pub(super) proof: SignedDelegation,
    pub(super) action: IntegrationDelegationAction,
    pub(super) resource_refs: Vec<IntegrationEntityRef>,
}

pub(super) fn label(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control),
        "DELEGATION_INVALID_REFERENCE"
    );
    Ok(())
}

pub(super) fn canonical_resources(
    resources: &[IntegrationEntityRef],
) -> Result<Vec<IntegrationEntityRef>> {
    let mut encoded = resources
        .iter()
        .map(|item| {
            label(&item.id)?;
            label(
                item.revision
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("DELEGATION_RESOURCE_REVISION_REQUIRED"))?,
            )?;
            Ok((serde_json::to_string(item)?, item.clone()))
        })
        .collect::<Result<Vec<_>>>()?;
    encoded.sort_by(|a, b| a.0.cmp(&b.0));
    ensure!(
        encoded.windows(2).all(|items| items[0].0 != items[1].0),
        "DELEGATION_DUPLICATE_RESOURCE"
    );
    Ok(encoded.into_iter().map(|(_, item)| item).collect())
}

pub(super) fn issue_intent(
    params: &IntegrationDelegationPrepareParams,
    subject: &AuthenticatedDelegationSubject,
    policy: &AuthenticatedDelegationPolicy,
) -> Result<String> {
    let bytes = serde_json::to_vec(&(
        "native-delegation-issue-v1",
        params.purpose,
        &params.connection_id,
        &params.observed_subject_ref,
        &params.actions,
        canonical_resources(&params.resource_refs)?,
        params.expires_in_ms,
        subject,
        IntegrationOwner::from(&policy.scope),
        &policy.scope.identity_generation,
        &policy.scope.target_revision,
        &policy.revision,
    ))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn signing_bytes(claims: &DelegationClaims) -> Result<Vec<u8>> {
    let mut bytes = SIGNATURE_CONTEXT.to_vec();
    serde_json::to_writer(&mut bytes, claims)?;
    ensure!(bytes.len() <= MAX_PROOF_BYTES, "DELEGATION_PROOF_TOO_LARGE");
    Ok(bytes)
}
