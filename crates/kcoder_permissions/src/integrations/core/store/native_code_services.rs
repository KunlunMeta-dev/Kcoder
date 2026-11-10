//! One fixed saved-code service purpose, using the original native issuer and journal.
use super::*;
use kcoder_types::integrations::core::{NativeCodeServiceGrantView, NativeCodeServiceIntent};

const CONTEXT_BYTES: &[u8] = b"kcoder-native-code-service-v1\0";

/// Native source observations, not a remotely deserializable policy or grant.
/// The host must read the actual saved definition, configuration and loaded image.
pub struct AuthenticatedNativeCodeServiceSource {
    scope: IntegrationScope,
    definition_id: String,
    version: u64,
    definition_sha256: String,
    task_sha256: String,
    configuration_sha256: String,
    native_image_sha256: String,
}
impl AuthenticatedNativeCodeServiceSource {
    pub fn from_native_source(
        scope: &IntegrationScope,
        definition_id: &str,
        version: u64,
        definition_sha256: &str,
        task_sha256: &str,
        configuration_sha256: &str,
        native_image_sha256: &str,
    ) -> Result<Self> {
        scope.validate()?;
        label(definition_id)?;
        ensure!(
            version > 0
                && [
                    definition_sha256,
                    task_sha256,
                    configuration_sha256,
                    native_image_sha256
                ]
                .iter()
                .all(|hash| hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))),
            "NATIVE_CODE_SOURCE_INVALID"
        );
        Ok(Self {
            scope: scope.clone(),
            definition_id: definition_id.into(),
            version,
            definition_sha256: definition_sha256.into(),
            task_sha256: task_sha256.into(),
            configuration_sha256: configuration_sha256.into(),
            native_image_sha256: native_image_sha256.into(),
        })
    }
    fn matches(&self, intent: &NativeCodeServiceIntent) -> bool {
        self.scope == intent.scope
            && self.definition_id == intent.definition_id
            && self.version == intent.definition_version
            && self.definition_sha256 == intent.definition_sha256
            && self.task_sha256 == intent.task_sha256
            && self.configuration_sha256 == intent.configuration_sha256
            && self.native_image_sha256 == intent.native_image_sha256
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CodeClaims {
    version: u32,
    issuer_id: String,
    grant_id: String,
    nonce: String,
    identity_epoch: String,
    issued_at_ms: u64,
    intent: NativeCodeServiceIntent,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SignedNativeCodeService {
    claims: CodeClaims,
    signature: Vec<u8>,
}
impl SignedNativeCodeService {
    fn bytes(claims: &CodeClaims) -> Result<Vec<u8>> {
        let mut bytes = CONTEXT_BYTES.to_vec();
        bytes.extend(serde_json::to_vec(claims)?);
        ensure!(bytes.len() <= 32 * 1024, "NATIVE_CODE_PROOF_TOO_LARGE");
        Ok(bytes)
    }
    fn sign(claims: CodeClaims, key: &Ed25519KeyPair) -> Result<Self> {
        let signature = key.sign(&Self::bytes(&claims)?).as_ref().to_vec();
        Ok(Self { claims, signature })
    }
    fn verify(&self, key: &Ed25519KeyPair) -> Result<()> {
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ED25519,
            key.public_key().as_ref(),
        )
        .verify(&Self::bytes(&self.claims)?, &self.signature)
        .map_err(|_| anyhow::anyhow!("NATIVE_CODE_SIGNATURE_INVALID"))
    }
}
#[derive(Clone)]
pub(super) struct NativeCodeGrant {
    pub(super) proof: SignedNativeCodeService,
    pub(super) revision: u64,
    pub(super) revoked: bool,
}

/// Original fixed code permission; no Deserialize/JSON constructor and no tool,
/// model, SDK or general account-management authority is exposed here.
pub struct NativeCodeServicePermit {
    proof: SignedNativeCodeService,
    reference: IntegrationRevisionRef,
}
impl NativeCodeServicePermit {
    pub fn intent(&self) -> &NativeCodeServiceIntent {
        &self.proof.claims.intent
    }
}
impl std::fmt::Debug for NativeCodeServicePermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeCodeServicePermit { original_issuer: verified }")
    }
}

impl NativeDelegationAuthority {
    pub fn issue_native_code_service(
        &self,
        intent: &NativeCodeServiceIntent,
        source: &AuthenticatedNativeCodeServiceSource,
        now_ms: u64,
    ) -> Result<NativeCodeServiceGrantView> {
        intent.validate()?;
        ensure!(
            source.matches(intent) && IntegrationOwner::from(&source.scope) == self.binding.owner,
            "NATIVE_CODE_CURRENT_SOURCE_CHANGED"
        );
        ensure!(
            intent.expires_at_ms > now_ms
                && intent.expires_at_ms - now_ms
                    <= kcoder_types::integrations::core::MAX_INTEGRATION_DELEGATION_TTL_MS,
            "NATIVE_CODE_SERVICE_DEADLINE_INVALID"
        );
        let wanted = digest(&serde_json::to_vec(&(
            "native-code-service-issue-v1",
            intent,
        ))?);
        let _writer = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        if let Some((prior, id)) = journal.operations.get(&intent.operation_id) {
            ensure!(prior == &wanted, "NATIVE_CODE_SERVICE_INTENT_CONFLICT");
            let grant = journal
                .code_services
                .get(id)
                .context("NATIVE_CODE_ORIGINAL_OPERATION_INVALID")?;
            return Ok(code_view(grant, &journal.epoch, now_ms));
        }
        ensure!(journal.identity_enabled, "DELEGATION_IDENTITY_DISABLED");
        let claims = CodeClaims {
            version: 1,
            issuer_id: self.binding.issuer_id.clone(),
            grant_id: Uuid::new_v4().to_string(),
            nonce: Uuid::new_v4().to_string(),
            identity_epoch: journal.epoch.clone(),
            issued_at_ms: now_ms,
            intent: intent.clone(),
        };
        let proof = SignedNativeCodeService::sign(claims, &self.key)?;
        let result = code_view(
            &NativeCodeGrant {
                proof: proof.clone(),
                revision: 1,
                revoked: false,
            },
            &journal.epoch,
            now_ms,
        );
        self.commit(
            &mut journal,
            Event::NativeCodeIssued {
                operation_id: intent.operation_id.clone(),
                intent: wanted,
                proof: Box::new(proof),
            },
        )?;
        Ok(result)
    }

    pub fn read_native_code_service_issue(
        &self,
        intent: &NativeCodeServiceIntent,
        now_ms: u64,
    ) -> Result<Option<NativeCodeServiceGrantView>> {
        intent.validate()?;
        let _reader = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let Some((_, id)) = journal.operations.get(&intent.operation_id) else {
            return Ok(None);
        };
        let grant = journal
            .code_services
            .get(id)
            .context("NATIVE_CODE_ORIGINAL_OPERATION_INVALID")?;
        ensure!(
            grant.proof.claims.intent == *intent,
            "NATIVE_CODE_SERVICE_INTENT_CONFLICT"
        );
        Ok(Some(code_view(grant, &journal.epoch, now_ms)))
    }
    pub fn authorize_native_code_service(
        &self,
        reference: &IntegrationRevisionRef,
        intent: &NativeCodeServiceIntent,
        source: &AuthenticatedNativeCodeServiceSource,
        now_ms: u64,
    ) -> Result<NativeCodeServicePermit> {
        reference.validate()?;
        intent.validate()?;
        ensure!(
            source.matches(intent) && IntegrationOwner::from(&source.scope) == self.binding.owner,
            "NATIVE_CODE_CURRENT_SOURCE_CHANGED"
        );
        let _reader = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let grant = journal
            .code_services
            .get(&reference.id)
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        grant.proof.verify(&self.key)?;
        ensure!(
            grant.revision.to_string() == reference.revision
                && grant.proof.claims.intent == *intent
                && code_view(grant, &journal.epoch, now_ms).status
                    == IntegrationDelegationStatus::Active
                && journal.identity_enabled,
            "NATIVE_CODE_SERVICE_UNAVAILABLE"
        );
        Ok(NativeCodeServicePermit {
            proof: grant.proof.clone(),
            reference: reference.clone(),
        })
    }
    pub fn revalidate_native_code_service(
        &self,
        permit: &NativeCodeServicePermit,
        source: &AuthenticatedNativeCodeServiceSource,
        now_ms: u64,
    ) -> Result<()> {
        self.authorize_native_code_service(
            &permit.reference,
            &permit.proof.claims.intent,
            source,
            now_ms,
        )
        .map(|_| ())
    }
    pub fn revoke_native_code_service(
        &self,
        operation_id: &str,
        reference: &IntegrationRevisionRef,
        now_ms: u64,
    ) -> Result<NativeCodeServiceGrantView> {
        label(operation_id)?;
        reference.validate()?;
        let wanted = digest(&serde_json::to_vec(&(
            "native-code-service-revoke-v1",
            reference,
        ))?);
        let _writer = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        if let Some((prior, id)) = journal.operations.get(operation_id) {
            ensure!(
                prior == &wanted && id == &reference.id,
                "NATIVE_CODE_SERVICE_INTENT_CONFLICT"
            );
            return Ok(code_view(
                journal
                    .code_services
                    .get(id)
                    .context("NATIVE_CODE_SERVICE_NOT_FOUND")?,
                &journal.epoch,
                now_ms,
            ));
        }
        let grant = journal
            .code_services
            .get(&reference.id)
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            !grant.revoked && grant.revision.to_string() == reference.revision,
            "NATIVE_CODE_SERVICE_REVISION_CONFLICT"
        );
        let expected_revision = grant.revision;
        self.commit(
            &mut journal,
            Event::NativeCodeRevoked {
                operation_id: operation_id.into(),
                intent: wanted,
                grant_id: reference.id.clone(),
                expected_revision,
                revoked_at_ms: now_ms,
            },
        )?;
        let journal = self.read_journal()?;
        Ok(code_view(
            journal
                .code_services
                .get(&reference.id)
                .context("NATIVE_CODE_SERVICE_NOT_FOUND")?,
            &journal.epoch,
            now_ms,
        ))
    }

    pub(super) fn apply_native_code_issue(
        &self,
        journal: &mut Journal,
        operation_id: String,
        intent: String,
        proof: SignedNativeCodeService,
    ) -> Result<(String, String, String)> {
        proof.verify(&self.key)?;
        proof.claims.intent.validate()?;
        let claims = &proof.claims;
        ensure!(
            claims.version == 1
                && claims.issuer_id == self.binding.issuer_id
                && claims.identity_epoch == journal.epoch
                && IntegrationOwner::from(&claims.intent.scope) == self.binding.owner
                && claims.intent.operation_id == operation_id
                && claims.issued_at_ms < claims.intent.expires_at_ms
                && claims.intent.expires_at_ms - claims.issued_at_ms
                    <= kcoder_types::integrations::core::MAX_INTEGRATION_DELEGATION_TTL_MS
                && !journal.code_services.contains_key(&claims.grant_id),
            "NATIVE_CODE_SERVICE_CLAIMS_INVALID"
        );
        let id = claims.grant_id.clone();
        journal.code_services.insert(
            id.clone(),
            NativeCodeGrant {
                proof,
                revision: 1,
                revoked: false,
            },
        );
        Ok((operation_id, intent, id))
    }
    pub(super) fn apply_native_code_revoke(
        &self,
        journal: &mut Journal,
        operation_id: String,
        intent: String,
        id: String,
        expected: u64,
    ) -> Result<(String, String, String)> {
        let grant = journal
            .code_services
            .get_mut(&id)
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            !grant.revoked && grant.revision == expected,
            "NATIVE_CODE_SERVICE_REVISION_CONFLICT"
        );
        grant.revoked = true;
        grant.revision = grant
            .revision
            .checked_add(1)
            .context("NATIVE_CODE_SERVICE_REVISION_LIMIT")?;
        Ok((operation_id, intent, id))
    }
}
fn code_view(grant: &NativeCodeGrant, epoch: &str, now: u64) -> NativeCodeServiceGrantView {
    let claims = &grant.proof.claims;
    NativeCodeServiceGrantView {
        reference: IntegrationRevisionRef {
            id: claims.grant_id.clone(),
            revision: grant.revision.to_string(),
        },
        expires_at_ms: claims.intent.expires_at_ms,
        status: if grant.revoked || claims.identity_epoch != epoch {
            IntegrationDelegationStatus::Revoked
        } else if now < claims.issued_at_ms || now >= claims.intent.expires_at_ms {
            IntegrationDelegationStatus::Expired
        } else {
            IntegrationDelegationStatus::Active
        },
    }
}

#[cfg(test)]
mod tests;
