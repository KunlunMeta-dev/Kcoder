//! Only the native factory supplies current context; request text cannot create an authority.
use super::*;
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_tools::ToolSource;
use kcoder_types::integrations::{core::*, office::*};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub type OfficeProjectionScopeResolver =
    Arc<dyn Fn(&str) -> Result<IntegrationScope> + Send + Sync>;
pub struct OfficeNativeProjectionAuthority {
    service: Arc<OfficeService>,
    resolve_scope: OfficeProjectionScopeResolver,
}
impl OfficeNativeProjectionAuthority {
    pub fn new(service: Arc<OfficeService>, resolve_scope: OfficeProjectionScopeResolver) -> Self {
        Self {
            service,
            resolve_scope,
        }
    }
}
#[async_trait]
impl NativeOfficeToolProjectionAuthority for OfficeNativeProjectionAuthority {
    async fn resolve(
        &self,
        request: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>> {
        if request.tool_name != "OfficeDocument" {
            return Ok(None);
        }
        let scope = (self.resolve_scope)(request.session_id)?;
        self.service.host.validate_scope(&scope)?;
        let Some((receipt, descriptor)) = self.service.store.canonical_tool_source(
            request.session_id,
            request.tool_call_id,
            request.tool_name,
            request.input_sha256,
        )?
        else {
            return Ok(None);
        };
        ensure!(
            descriptor.owner == self.service.store.owner().clone()
                && receipt.operation_id == descriptor.operation_id,
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        let native = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("office-projection-{}", uuid::Uuid::new_v4()),
            scope,
            operation_id: None,
            expected_revision: None,
            timeout_ms: 60_000,
            cancellation_ref: None,
            payload: json!({"reference":descriptor.artifact,"metadataOnly":true})
                .as_object()
                .context("OFFICE_INVALID_INPUT")?
                .clone(),
        };
        let read = self
            .service
            .dispatch(
                "integrations/artifact/source",
                &native,
                "office.artifact.source.read",
                &CancellationToken::new(),
            )
            .await?;
        let read: OfficeCanonicalSourceReadResult = serde_json::from_value(read)?;
        ensure!(
            read.availability == OfficeCanonicalSourceAvailability::Available
                && read.source.as_ref() == Some(&descriptor),
            "OFFICE_CANONICAL_SOURCE_REVISION_MISMATCH"
        );
        Ok(Some(NativeOfficeToolProjection {
            session_id: receipt.session_id,
            tool_call_id: receipt.tool_call_id,
            tool_name: receipt.tool_name.clone(),
            original_source: ToolSource::NativeFeature {
                feature: receipt.feature,
                tool: receipt.tool_name,
                revision: receipt.source_revision,
            },
            input_sha256: receipt.original_input_sha256,
            operation_id: receipt.operation_id,
            canonical_source: descriptor,
        }))
    }
}
