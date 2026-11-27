//! Consume a fixed shared publication through the original supervisor's publisher-UID reader.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;

impl NativeKnowledgeHost {
    pub(super) fn check_shared_permission(
        &self,
        owner: &KnowledgeOwner,
        id: &str,
        action: &str,
    ) -> Result<()> {
        let own_legacy = legacy::same_profile_owner(owner, self.scope());
        if own_legacy {
            let store = legacy::observe_directory(self)?
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?;
            ensure!(
                store.allows_legacy_read(&self.native, owner)?,
                "KNOWLEDGE_RESOURCE_DENIED"
            );
        }
        ensure!(
            matches!(action, "knowledge.read" | "knowledge.adopt")
                && (own_legacy
                    || owner.account_id != self.scope().account_id
                    || legacy::same_account_other_workspace(owner, self.scope()))
                && matches!(
                    &self.scope().organization_id,
                    Some(IntegrationNullable::Value(_))
                )
                && (own_legacy || owner.organization_id == self.scope().organization_id),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        let resource = KnowledgeResource {
            kind: "publication",
            id: id.into(),
            owner: owner.clone(),
        };
        match organization_policy::current_revision(&self.native, action, &resource) {
            Ok(Some(_)) => {}
            Err(error) if error.to_string() == "ORGANIZATION_RESOURCE_DENIED" => {
                anyhow::bail!("KNOWLEDGE_RESOURCE_DENIED")
            }
            _ => anyhow::bail!("KNOWLEDGE_POLICY_UNAVAILABLE"),
        }
        if let Some(delegate) = &self.policy {
            let evaluation = delegate.evaluate_action(self.scope(), action, &resource)?;
            ensure!(
                evaluation.decision != IntegrationPolicyDecision::Unknown,
                "KNOWLEDGE_POLICY_UNAVAILABLE"
            );
            ensure!(
                evaluation.decision == IntegrationPolicyDecision::Allow,
                "KNOWLEDGE_RESOURCE_DENIED"
            );
        }
        Ok(())
    }

    pub(in crate::app_server::integrations::knowledge) fn resolve_reference_for_use(
        &self,
        request: &IntegrationRequest,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        cancel: &CancellationToken,
    ) -> Result<KnowledgePublication> {
        if !legacy::same_profile_owner(owner, self.scope()) {
            return self.shared_publication(request, owner, id, version, "use", cancel);
        }
        for action in ["knowledge.read", "knowledge.adopt"] {
            self.check_shared_permission(owner, id, action)?;
        }
        let mut read = request.clone();
        read.operation_id = None;
        read.expected_revision = None;
        read.payload = json!({"owner":owner,"publicationId":id,"version":version})
            .as_object()
            .unwrap()
            .clone();
        let reply = self.knowledge(
            "resolvePublication",
            &read,
            false,
            u64::try_from(chrono::Utc::now().timestamp_millis())?,
            cancel,
        );
        ensure!(
            reply.status == IntegrationStatus::Completed,
            "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"
        );
        let publication: KnowledgePublication = rpc_codec::decode(
            reply
                .result
                .as_ref()
                .and_then(|value| value.get("publication"))
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?,
        )?;
        ensure!(
            publication.owner == *owner
                && publication.draft.publication_id == id
                && publication.version == version
                && !publication.revoked,
            "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
        );
        for action in ["knowledge.read", "knowledge.adopt"] {
            self.check_shared_permission(owner, id, action)?;
        }
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        Ok(publication)
    }

    pub(in crate::app_server::integrations::knowledge) fn shared_publication(
        &self,
        request: &IntegrationRequest,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        usage: &str,
        cancel: &CancellationToken,
    ) -> Result<KnowledgePublication> {
        self.native.validate_scope(&request.scope)?;
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
        for action in if usage == "use" {
            vec!["knowledge.read", "knowledge.adopt"]
        } else {
            vec!["knowledge.read"]
        } {
            self.check_shared_permission(owner, id, action)?;
        }
        let (before, body) = self.native.shared_publication_request(
            owner,
            id,
            version,
            usage,
            &request.request_id,
            None,
            None,
        )?;
        let body = body.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
        let raw = read_sealed_body(body, &before, self.scope(), cancel)?;
        let publication: KnowledgePublication = serde_json::from_slice(&raw)?;
        ensure!(
            &publication.owner == owner
                && publication.draft.publication_id == id
                && publication.version == version
                && !publication.revoked
                && publication.draft.visibility != KnowledgeVisibility::Personal
                && publication.draft.audience_id.is_some(),
            "KNOWLEDGE_SHARED_REFERENCE_DENIED"
        );
        let sha256 = before["bodySha256"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
        let (after, extra) = self.native.shared_publication_request(
            owner,
            id,
            version,
            usage,
            &request.request_id,
            Some(sha256),
            None,
        )?;
        ensure!(
            extra.is_none() && before == after,
            "KNOWLEDGE_SHARED_SOURCE_CHANGED"
        );
        let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
        ensure!(
            publication
                .draft
                .valid_from_ms
                .is_none_or(|time| now >= time)
                && publication
                    .draft
                    .valid_until_ms
                    .is_none_or(|time| now < time),
            "KNOWLEDGE_SHARED_SOURCE_CHANGED"
        );
        self.native.validate_scope(&request.scope)?;
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
        Ok(publication)
    }

    pub(super) fn shared_read_dispatch(
        &self,
        method: &str,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Option<IntegrationReply> {
        let owner: KnowledgeOwner =
            rpc_codec::decode(request.payload.get("owner")?.clone()).ok()?;
        if owner.account_id == self.scope().account_id
            && !legacy::same_account_other_workspace(&owner, self.scope())
        {
            return None;
        }
        let policy = self.publication_policy(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        Some(super::super::super::api::dispatch(
            request,
            &context,
            false,
            "knowledge.read",
            KnowledgeResource {
                kind: "knowledge",
                id: "current-target".into(),
                owner: self.scope().into(),
            },
            || {
                let publication = match method {
                    "resolvePublication" => {
                        let parameters: kcoder_app_protocol::integrations::knowledge::PublicationReadParams = super::super::super::api::parse(request)?;
                        self.shared_publication(
                            request,
                            &owner,
                            &parameters.publication_id,
                            parameters.version.ok_or_else(|| {
                                anyhow::anyhow!("KNOWLEDGE_SHARED_FIXED_VERSION_REQUIRED")
                            })?,
                            "read",
                            cancel,
                        )?
                    }
                    "readCitation" => {
                        let parameters: kcoder_app_protocol::integrations::knowledge::CitationReadParams = super::super::super::api::parse(request)?;
                        let publication = self.shared_publication(
                            request,
                            &owner,
                            &parameters.publication_id,
                            parameters.version,
                            "read",
                            cancel,
                        )?;
                        let page = publication
                            .pages
                            .into_iter()
                            .find(|page| page.source == parameters.source)
                            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_CITATION_NOT_FOUND"))?;
                        return Ok((
                            json!({"citation":page}),
                            Some(parameters.version.to_string()),
                        ));
                    }
                    _ => anyhow::bail!("KNOWLEDGE_SHARED_METHOD_UNAVAILABLE"),
                };
                let version = publication.version.to_string();
                Ok((json!({"publication":publication}), Some(version)))
            },
        ))
    }
}

#[cfg(target_os = "linux")]
pub(super) fn read_sealed_body(
    mut body: File,
    metadata: &Value,
    reader_scope: &IntegrationScope,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    use sha2::{Digest, Sha256};
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let bytes = metadata["bodyBytes"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
    let publisher = metadata["publisherUid"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
    let actual = body.metadata()?;
    let owner: KnowledgeOwner = rpc_codec::decode(metadata["owner"].clone())?;
    let required = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    let seals = unsafe { libc::fcntl(body.as_raw_fd(), libc::F_GET_SEALS) };
    ensure!(
        (1..=512 * 1024).contains(&bytes)
            && actual.is_file()
            && actual.len() == bytes
            && actual.nlink() == 0
            && u64::from(actual.uid()) == publisher
            && publisher >= 1000
            && (publisher != u64::from(unsafe { libc::geteuid() })
                || legacy::same_account_other_workspace(&owner, reader_scope))
            && seals >= 0
            && seals & required == required,
        "KNOWLEDGE_SHARED_BUFFER_INVALID"
    );
    let mut raw = Vec::with_capacity(bytes as usize);
    let mut chunk = [0u8; 32 * 1024];
    loop {
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
        let length = body.read(&mut chunk)?;
        if length == 0 {
            break;
        }
        ensure!(
            raw.len().saturating_add(length) <= bytes as usize,
            "KNOWLEDGE_SHARED_BUFFER_INVALID"
        );
        raw.extend_from_slice(&chunk[..length]);
    }
    ensure!(
        raw.len() == bytes as usize
            && metadata["bodySha256"] == format!("{:x}", Sha256::digest(&raw)),
        "KNOWLEDGE_SHARED_BUFFER_INVALID"
    );
    Ok(raw)
}
#[cfg(not(target_os = "linux"))]
pub(super) fn read_sealed_body(
    _body: File,
    _metadata: &Value,
    _reader_scope: &IntegrationScope,
    _cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    anyhow::bail!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE")
}
