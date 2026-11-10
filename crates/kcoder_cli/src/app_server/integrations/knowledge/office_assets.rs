//! Fixed knowledge identities under the actual Native source authority.
use super::{
    NativeKnowledgeHost, NativeKnowledgeRpc, rpc::configuration::EngineSnapshot,
    turn_memory::AcceptedAttempt,
};
use crate::app_server::integrations::{
    core::NativeIntegrationContext, office::native_host::NativeOfficeAssets,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_types::{
    TurnAttemptIdentity,
    integrations::{core::*, knowledge::*, office::*},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const WIKI_PAGE: &str = "wiki_page";
const PUBLICATION: &str = "publication";

fn check_organization_source_authority(native: &NativeIntegrationContext) -> Result<()> {
    native.verify()?;
    if native.scope().organization_id.is_some() {
        ensure!(
            matches!(
                native.scope().organization_id,
                Some(IntegrationNullable::Value(_))
            ) && native.organization_policy_revision()?.is_some(),
            "OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE"
        );
    }
    Ok(())
}

/// Bound only inside an actual Accepted turn. The existing connection cache
/// supplies current policy; this object never installs a default grant/store.
pub(crate) struct NativeKnowledgeOfficeAssets {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    identity: TurnAttemptIdentity,
    proof: AcceptedAttempt,
    settings_path: PathBuf,
    cache: Arc<Mutex<NativeKnowledgeRpc>>,
}
impl NativeKnowledgeOfficeAssets {
    // d04a835a5 removed the accepted-turn Office preparation that captured
    // these assets; the authority checks stay covered by unit tests.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "no production caller since bundled Office removal"
        )
    )]
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
        cache: Arc<Mutex<NativeKnowledgeRpc>>,
    ) -> Result<Self> {
        let settings = EngineSnapshot::capture(engine)?;
        settings.verify_binding(engine, native)?;
        check_organization_source_authority(native)?;
        let proof = AcceptedAttempt::capture(engine, identity)?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            identity: identity.clone(),
            proof,
            settings_path: settings.path()?.to_path_buf(),
            cache,
        })
    }
    pub(crate) fn supports_kind(kind: &str) -> bool {
        matches!(kind, WIKI_PAGE | PUBLICATION)
    }
    fn check(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()> {
        request.validate(false)?;
        native.validate_scope(&request.scope)?;
        self.native.validate_scope(&request.scope)?;
        check_organization_source_authority(native)?;
        let settings = EngineSnapshot::capture(&self.engine)?;
        settings.verify_binding(&self.engine, native)?;
        ensure!(
            settings.path()? == self.settings_path,
            "OFFICE_SCOPE_CHANGED"
        );
        self.proof.verify(&self.engine, &self.identity)?;
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        if let Some(task) = request.payload.get("task") {
            let task: OfficeTaskRef = rpc_codec::decode(task.clone())?;
            ensure!(
                task.thread_id == self.identity.thread_id
                    && task.turn_id == self.identity.turn_id
                    && task.run_id.is_none(),
                "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            );
        }
        ensure!(sources.len() <= 128, "OFFICE_INVALID_INPUT");
        for source in sources {
            source.validate()?;
            ensure!(
                Self::supports_kind(&source.kind),
                "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
            );
        }
        if sources.iter().any(|source| source.kind == WIKI_PAGE) {
            ensure!(
                self.engine
                    .settings
                    .read()
                    .map_err(|_| anyhow::anyhow!("OFFICE_SCOPE_CHANGED"))?
                    .knowledge
                    .enabled,
                "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
            );
        }
        Ok(())
    }
    async fn current_host(&self) -> Result<Arc<NativeKnowledgeHost>> {
        self.cache
            .lock()
            .await
            .host_for_engine(&self.native, &self.engine)
    }
    fn inner_request(request: &IntegrationRequest, payload: Value) -> IntegrationRequest {
        IntegrationRequest {
            operation_id: None,
            expected_revision: None,
            payload: payload.as_object().unwrap().clone(),
            ..request.clone()
        }
    }
    fn read(
        host: &NativeKnowledgeHost,
        method: &str,
        request: &IntegrationRequest,
        payload: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let request = Self::inner_request(request, payload);
        let reply = host.knowledge(
            method,
            &request,
            false,
            u64::try_from(chrono::Utc::now().timestamp_millis())?,
            cancel,
        );
        ensure!(
            reply.request_id == request.request_id,
            "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"
        );
        if reply.status != IntegrationStatus::Completed {
            let code = reply
                .error
                .as_ref()
                .map(|error| error.code.as_str())
                .unwrap_or_default();
            if reply.status == IntegrationStatus::Rejected
                || code.contains("DENIED")
                || code.contains("REVOKED")
                || code.contains("POLICY")
            {
                anyhow::bail!("OFFICE_ACCESS_DENIED");
            }
            anyhow::bail!("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE");
        }
        Ok(Value::Object(
            reply
                .result
                .as_ref()
                .context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?
                .clone(),
        ))
    }
    pub(in crate::app_server::integrations::knowledge) fn publication(
        host: &NativeKnowledgeHost,
        request: &IntegrationRequest,
        reference: &OfficeResourceRef,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let version = reference
            .revision
            .parse::<u64>()
            .context("OFFICE_INPUT_REVISION_MISMATCH")?;
        ensure!(
            version > 0 && version.to_string() == reference.revision,
            "OFFICE_INPUT_REVISION_MISMATCH"
        );
        let mut after = None::<String>;
        let mut selected = None;
        for _ in 0..7 {
            let result = Self::read(
                host,
                "listAdoptions",
                request,
                json!({"after":after}),
                cancel,
            )?;
            let page: KnowledgePage<KnowledgeAdoption> =
                serde_json::from_value(result["page"].clone())?;
            for adoption in page.items {
                if adoption.publication_id == reference.id
                    && adoption.enabled
                    && adoption.owner == KnowledgeOwner::from(&request.scope)
                    && host.has_recorded_publication_adoption(&adoption, version, cancel)?
                {
                    ensure!(selected.is_none(), "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE");
                    selected = Some(adoption);
                }
            }
            match page.next_cursor {
                Some(cursor) if after.as_ref() != Some(&cursor) => after = Some(cursor),
                None => break,
                _ => anyhow::bail!("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"),
            }
        }
        let adoption = selected.context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?;
        let publication: KnowledgePublication =
            if adoption.publication_owner == KnowledgeOwner::from(&request.scope) {
                let value = Self::read(
                    host,
                    "resolvePublication",
                    request,
                    json!({"owner":adoption.publication_owner,
                "publicationId":reference.id,"version":version}),
                    cancel,
                )?;
                let publication: KnowledgePublication =
                    rpc_codec::decode(value["publication"].clone())?;
                publication
            } else {
                host.resolve_reference_for_use(
                    request,
                    &adoption.publication_owner,
                    &reference.id,
                    version,
                    cancel,
                )?
            };
        ensure!(
            publication.owner == adoption.publication_owner
                && publication.draft.publication_id == reference.id
                && publication.version == version
                && !publication.revoked,
            "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"
        );
        ensure!(
            (request.scope.organization_id.is_none()
                && publication.draft.visibility == KnowledgeVisibility::Personal
                && publication.draft.audience_id.is_none())
                || (request.scope.organization_id.is_some()
                    && (publication.owner.account_id == request.scope.account_id
                        || (publication.draft.visibility != KnowledgeVisibility::Personal
                            && publication.draft.audience_id.is_some()))),
            "OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE"
        );
        Ok(json!({"schemaVersion":1,"kind":PUBLICATION,"publication":publication}))
    }
    fn identities(
        settings_path: &std::path::Path,
        host: &NativeKnowledgeHost,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        sources
            .iter()
            .map(|reference| {
                ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
                let value = match reference.kind.as_str() {
                    PUBLICATION => Self::publication(host, request, reference, cancel)?,
                    WIKI_PAGE => {
                        let (library_id, page_id): (String, String) =
                            serde_json::from_str(&reference.id)
                                .context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?;
                        let source = PublicationSource {
                            library_id,
                            page_id,
                            page_revision: reference.revision.clone(),
                        };
                        let page =
                            host.office_wiki_material(request, settings_path, &source, cancel)?;
                        // human_edited belongs to the current page and must not alter a historical hash.
                        json!({"schemaVersion":1,"kind":WIKI_PAGE,"source":source,"page":page.draft,
                        "revision":page.revision_id})
                    }
                    _ => anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE"),
                };
                let identity = OfficeCanonicalInputIdentity {
                    reference: reference.clone(),
                    sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?)),
                };
                identity.validate()?;
                Ok(identity)
            })
            .collect()
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeAssets for NativeKnowledgeOfficeAssets {
    async fn validate_sources(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        let result = async {
            self.check(native, request, sources, cancel)?;
            let host = self.current_host().await?;
            let first =
                Self::identities(&self.settings_path, host.as_ref(), request, sources, cancel)?;
            self.check(native, request, sources, cancel)?;
            let host = self.current_host().await?;
            let current =
                Self::identities(&self.settings_path, host.as_ref(), request, sources, cancel)?;
            ensure!(first == current, "OFFICE_INPUT_REVISION_MISMATCH");
            self.check(native, request, sources, cancel)?;
            Ok(first)
        }
        .await;
        result.map_err(|error: anyhow::Error| match error.to_string().as_str() {
            "OFFICE_CANCELLED"
            | "OFFICE_ACCESS_DENIED"
            | "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            | "OFFICE_INPUT_REVISION_MISMATCH"
            | "OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE"
            | "OFFICE_INPUT_PROVIDER_UNAVAILABLE" => error,
            _ => anyhow::anyhow!("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"),
        })
    }
}

/// The ID is a locator only. Resolution reads the real same-profile catalog.
#[cfg(test)]
pub(crate) fn office_wiki_page_reference(source: &PublicationSource) -> Result<OfficeResourceRef> {
    let reference = OfficeResourceRef {
        kind: WIKI_PAGE.into(),
        id: serde_json::to_string(&(&source.library_id, &source.page_id))?,
        revision: source.page_revision.clone(),
    };
    reference.validate()?;
    Ok(reference)
}

/// Management/transfer callers must supply sourceRefs loaded from their real
/// server-owned artifact manifest. This function grants no turn authority and
/// cannot be installed as NativeOfficeAssets for a model task.
pub(crate) async fn validate_management_office_knowledge_sources(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    cache: &Arc<Mutex<NativeKnowledgeRpc>>,
    request: &IntegrationRequest,
    stored_manifest_sources: &[OfficeResourceRef],
    cancel: &CancellationToken,
) -> Result<Vec<OfficeCanonicalInputIdentity>> {
    let result = async {
        let binding = EngineSnapshot::capture(engine)?;
        let check = || -> Result<()> {
            request.validate(false)?;
            native.validate_scope(&request.scope)?;
            check_organization_source_authority(native)?;
            let current = EngineSnapshot::capture(engine)?;
            current.verify_binding(engine, native)?;
            ensure!(current.path()? == binding.path()?, "OFFICE_SCOPE_CHANGED");
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            ensure!(stored_manifest_sources.len() <= 128, "OFFICE_INVALID_INPUT");
            for source in stored_manifest_sources {
                source.validate()?;
                ensure!(
                    NativeKnowledgeOfficeAssets::supports_kind(&source.kind),
                    "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
                );
            }
            if stored_manifest_sources
                .iter()
                .any(|source| source.kind == WIKI_PAGE)
            {
                ensure!(
                    engine
                        .settings
                        .read()
                        .map_err(|_| anyhow::anyhow!("OFFICE_SCOPE_CHANGED"))?
                        .knowledge
                        .enabled,
                    "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
                );
            }
            Ok(())
        };
        check()?;
        let host = cache.lock().await.host_for_engine(native, engine)?;
        let first = NativeKnowledgeOfficeAssets::identities(
            binding.path()?,
            host.as_ref(),
            request,
            stored_manifest_sources,
            cancel,
        )?;
        check()?;
        let host = cache.lock().await.host_for_engine(native, engine)?;
        let current = NativeKnowledgeOfficeAssets::identities(
            binding.path()?,
            host.as_ref(),
            request,
            stored_manifest_sources,
            cancel,
        )?;
        ensure!(first == current, "OFFICE_INPUT_REVISION_MISMATCH");
        check()?;
        Ok(first)
    }
    .await;
    result.map_err(|error: anyhow::Error| match error.to_string().as_str() {
        "OFFICE_CANCELLED"
        | "OFFICE_ACCESS_DENIED"
        | "OFFICE_INPUT_REVISION_MISMATCH"
        | "OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE"
        | "OFFICE_INPUT_PROVIDER_UNAVAILABLE" => error,
        _ => anyhow::anyhow!("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"),
    })
}

#[cfg(test)]
mod tests;
