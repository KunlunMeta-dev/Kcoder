//! Management reads recheck private application receipts against the current owned Main.
use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use kcoder_state::integrations::office::OfficeStore;
use kcoder_types::integrations::office::{
    OfficeArtifactRef, OfficeCanonicalInputIdentity, OfficeResourceRef,
};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

impl NativeConnectivityMainProvider {
    pub(in crate::app_server::integrations::connectivity) async fn validate_office_application_sources(
        &self,
        native: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        self.verify(native, parent)?;
        ensure!(
            !cancel.is_cancelled() && sources.len() <= 102,
            "APPLICATION_BUSINESS_SOURCE_UNAVAILABLE"
        );
        let locators = sources
            .iter()
            .filter(|source| source.kind == "application_receipt")
            .collect::<Vec<_>>();
        ensure!(
            locators.len() == 1,
            "APPLICATION_BUSINESS_ORIGINAL_RECEIPT_REQUIRED"
        );
        let guard =
            NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
                .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        let store = OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(native.scope()),
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        let receipt = store
            .read_application_receipt(&OfficeArtifactRef {
                id: locators[0].id.clone(),
                revision: 1,
            })?
            .context("APPLICATION_BUSINESS_ORIGINAL_RECEIPT_REQUIRED")?;
        receipt.validate()?;
        ensure!(
            receipt.owner == IntegrationOwner::from(native.scope())
                && receipt.source_references()? == sources,
            "APPLICATION_BUSINESS_SOURCE_CHANGED"
        );
        let connection =
            super::super::application_resources::NativeApplicationResourceConnection::capture(
                native,
                &self.origin,
                &self.factory,
                self.vault.clone(),
                receipt.source.clone(),
            )?;
        let host = self.application_resource_host(native, parent)?;
        let selected=host.pipe.read_owned(parent,"connectivity.resolveApplicationResources",
            json!({"scope":native.scope(),"connectionId":receipt.connection.id,"resourceRefs":receipt.resources})).await?;
        ensure!(
            selected["nativeNamespaceId"].as_str() == Some(host.facade.namespace_id(native)?)
                && selected["connectionRevision"].as_str()
                    == Some(receipt.connection.revision.as_str()),
            "APPLICATION_BUSINESS_SOURCE_CHANGED"
        );
        let resolved = selected["resources"]
            .as_array()
            .context("APPLICATION_BUSINESS_SOURCE_CHANGED")?;
        ensure!(
            resolved.len() == receipt.resources.len(),
            "APPLICATION_BUSINESS_SOURCE_CHANGED"
        );
        for (actual, expected) in resolved.iter().zip(&receipt.resources) {
            ensure!(
                actual["reference"] == serde_json::to_value(expected)?
                    && actual["sourceResourceRef"]["kind"] == expected.kind,
                "APPLICATION_BUSINESS_SOURCE_CHANGED"
            );
            super::super::application_task::verify_resource_revision(
                &receipt.source,
                actual["sourceResourceRef"]["revision"]
                    .as_str()
                    .context("APPLICATION_BUSINESS_SOURCE_CHANGED")?,
            )?;
        }
        let actual = self
            .origin
            .active_tool_registry()
            .get(&receipt.tool_name)
            .context("APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED")?;
        let selector = super::super::NativeMcpSourceSelector {
            server: receipt.server.clone(),
            plugin: receipt.plugin_id.clone(),
        };
        ensure!(
            selector.matches_tool_source(&actual.source()),
            "APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED"
        );
        let raw = match actual.source() {
            kcoder_tools::ToolSource::Mcp { tool, .. }
            | kcoder_tools::ToolSource::Plugin { tool, .. } => tool,
            _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED"),
        };
        let object: &dyn std::any::Any = actual.as_ref();
        let mcp = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED")?;
        ensure!(
            raw == receipt.raw_tool_name
                && connection.matches_registered_tool(mcp)
                && mcp.native_origin().is_some_and(|origin| origin
                    .private_config()
                    .policy
                    .application_actions
                    .get(&raw)
                    == Some(&receipt.rule))
                && format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&actual.input_schema())?)
                ) == receipt.rule.schema_sha256,
            "APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED"
        );
        connection.verify_current(native)?;
        self.verify(native, parent)?;
        ensure!(
            !cancel.is_cancelled(),
            "APPLICATION_BUSINESS_SOURCE_UNAVAILABLE"
        );
        Ok(sources
            .iter()
            .map(|source| OfficeCanonicalInputIdentity {
                reference: source.clone(),
                sha256: receipt.result_sha256.clone(),
            })
            .collect())
    }
}
