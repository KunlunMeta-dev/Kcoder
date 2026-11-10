//! Verify actual application receipts and retain their original bytes in OfficeStore.
use super::*;
pub(crate) use kcoder_application_receipts::{VerifiedBusinessResult, verify_document_readback};
pub(super) use kcoder_application_receipts::{lookup, verify, verify_input};
use kcoder_cli_storage::private_files::hex_sha256 as hash;
use kcoder_tools::ToolContext;
use kcoder_types::{McpApplicationAction, McpApplicationActionRule, integrations::office::*};
pub(super) fn ensure_output_ready(
    native: &NativeIntegrationContext,
    origin: &QueryEngine,
    ctx: &ToolContext,
    operation: &str,
) -> Result<()> {
    use crate::app_server::integrations::office::native_host::{
        NativeOfficeAcceptedTurnAuthority, NativeOfficeComposition, NativeOfficeTaskAuthority,
    };
    ensure!(!ctx.is_aborted(), "APPLICATION_BUSINESS_CANCELLED");
    let attempt = ctx
        .state
        .current_history_attempt_identity()
        .context("APPLICATION_BUSINESS_ACCEPTED_ATTEMPT_REQUIRED")?;
    let mut engine = origin.clone();
    engine.state = ctx.state.clone();
    let task = OfficeTaskRef {
        thread_id: attempt.thread_id,
        turn_id: attempt.turn_id,
        run_id: None,
    };
    NativeOfficeAcceptedTurnAuthority.validate(native, &engine, &task)?;
    let preparation = format!(
        "application-output-{:x}",
        Sha256::digest(operation.as_bytes())
    );
    NativeOfficeComposition::initialize_metadata(native, &engine, Default::default(), &preparation)
        .context("APPLICATION_OFFICE_OUTPUT_UNAVAILABLE")?
        .verify(native)
}
#[expect(
    clippy::too_many_arguments,
    reason = "Retain the original approved native call/source and authoritative effect identity before IO"
)]
pub(super) fn save_effect_intent(
    native: &NativeIntegrationContext,
    origin: &QueryEngine,
    ctx: &ToolContext,
    caller: &NativeConnectivityPublicCall,
    tool: &dyn kcoder_tools::Tool,
    source: &IntegrationTaskCapabilitySourceChoice,
    uris: &[String],
    rule: &McpApplicationActionRule,
    input: &Value,
    effect_operation: &str,
) -> Result<()> {
    ensure_output_ready(
        native,
        origin,
        ctx,
        caller
            .call()
            .request
            .operation_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?,
    )?;
    let attempt = ctx
        .state
        .current_history_attempt_identity()
        .context("APPLICATION_BUSINESS_ACCEPTED_ATTEMPT_REQUIRED")?;
    let (server, plugin_id, raw_tool_name) = match tool.source() {
        kcoder_tools::ToolSource::Mcp { server, tool } => (server, None, tool),
        kcoder_tools::ToolSource::Plugin {
            server,
            plugin,
            tool,
        } => (server, Some(plugin), tool),
        _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
    };
    let intent = kcoder_state::integrations::office::OfficeApplicationEffectIntent {
        version: 1,
        owner: IntegrationOwner::from(native.scope()),
        task: OfficeTaskRef {
            thread_id: attempt.thread_id,
            turn_id: attempt.turn_id,
            run_id: None,
        },
        root_operation_id: caller
            .call()
            .request
            .operation_id
            .clone()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?,
        effect_operation_id: effect_operation.into(),
        native_call_id: ctx
            .tool_call_id
            .clone()
            .context("APPLICATION_BUSINESS_FINAL_NATIVE_APPROVAL_REQUIRED")?,
        business_action: caller
            .call()
            .request
            .payload
            .get("businessAction")
            .and_then(Value::as_str)
            .context("APPLICATION_BUSINESS_ACTION_REQUIRED")?
            .into(),
        tool_name: tool.name(),
        raw_tool_name,
        server,
        plugin_id,
        source: source.clone(),
        connection: IntegrationRevisionRef {
            id: caller
                .call()
                .request
                .payload
                .get("connectionId")
                .and_then(Value::as_str)
                .context("APPLICATION_ORIGINAL_CONNECTION_REQUIRED")?
                .into(),
            revision: caller
                .call()
                .request
                .expected_revision
                .clone()
                .context("APPLICATION_ORIGINAL_REVISION_REQUIRED")?,
        },
        resources: serde_json::from_value(
            caller
                .call()
                .request
                .payload
                .get("resourceRefs")
                .cloned()
                .context("APPLICATION_ORIGINAL_RESOURCE_REQUIRED")?,
        )?,
        resource_uris: uris.to_vec(),
        rule: rule.clone(),
        approved_input: input.clone(),
        input_sha256: hash(&serde_json::to_vec(input)?),
    };
    let mut engine = origin.clone();
    engine.state = ctx.state.clone();
    let operation = format!(
        "application-effect-intent-{:x}",
        Sha256::digest(effect_operation.as_bytes())
    );
    let office=crate::app_server::integrations::office::native_host::NativeOfficeComposition::initialize_metadata(native,&engine,Default::default(),&operation)?;
    office.save_native_application_effect_intent(native, &operation, intent)
}

#[cfg(test)]
mod presentation_tests;

#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the actual tool, original owner/source and final verified content at publication"
)]
pub(super) fn publish(
    native: &NativeIntegrationContext,
    origin: &QueryEngine,
    ctx: &ToolContext,
    caller: &NativeConnectivityPublicCall,
    tool: &dyn kcoder_tools::Tool,
    source: &IntegrationTaskCapabilitySourceChoice,
    rule: &McpApplicationActionRule,
    input: &Value,
    result: &Value,
    verified: VerifiedBusinessResult,
    effect_operation_id: Option<String>,
    reconciliation: Option<
        kcoder_state::integrations::office::OfficeApplicationReconciliationProof,
    >,
) -> Result<OfficeArtifactManifest> {
    native.validate_scope(&caller.call().request.scope)?;
    ensure!(!ctx.is_aborted(), "APPLICATION_BUSINESS_CANCELLED");
    let attempt = ctx
        .state
        .current_history_attempt_identity()
        .context("APPLICATION_BUSINESS_ACCEPTED_ATTEMPT_REQUIRED")?;
    ensure!(
        attempt.thread_id == ctx.state.session_id(),
        "APPLICATION_BUSINESS_ACCEPTED_ATTEMPT_CHANGED"
    );
    let mut engine = origin.clone();
    engine.state = ctx.state.clone();
    let operation = format!(
        "application-result-{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            caller.call().request.operation_id,
            rule.action,
            input
        ]))?)
    );
    let task = OfficeTaskRef {
        thread_id: attempt.thread_id,
        turn_id: attempt.turn_id,
        run_id: None,
    };
    let (server, plugin_id, raw_tool_name) = match tool.source() {
        kcoder_tools::ToolSource::Mcp { server, tool } => (server, None, tool),
        kcoder_tools::ToolSource::Plugin {
            server,
            plugin,
            tool,
        } => (server, Some(plugin), tool),
        _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
    };
    let receipt = kcoder_state::integrations::office::OfficeApplicationToolReceipt {
        version: 1,
        owner: IntegrationOwner::from(native.scope()),
        task: task.clone(),
        artifact: OfficeArtifactRef {
            id: format!("application-{:x}", Sha256::digest(operation.as_bytes())),
            revision: 1,
        },
        root_operation_id: caller
            .call()
            .request
            .operation_id
            .clone()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?,
        effect_operation_id,
        reconciliation,
        native_call_id: ctx
            .tool_call_id
            .clone()
            .context("APPLICATION_BUSINESS_FINAL_NATIVE_APPROVAL_REQUIRED")?,
        tool_name: tool.name(),
        raw_tool_name,
        server,
        plugin_id,
        source: source.clone(),
        connection: IntegrationRevisionRef {
            id: caller
                .call()
                .request
                .payload
                .get("connectionId")
                .and_then(Value::as_str)
                .context("APPLICATION_ORIGINAL_CONNECTION_REQUIRED")?
                .into(),
            revision: caller
                .call()
                .request
                .expected_revision
                .clone()
                .context("APPLICATION_ORIGINAL_REVISION_REQUIRED")?,
        },
        resources: serde_json::from_value(
            caller
                .call()
                .request
                .payload
                .get("resourceRefs")
                .cloned()
                .context("APPLICATION_ORIGINAL_RESOURCE_REQUIRED")?,
        )?,
        rule: rule.clone(),
        approved_input: input.clone(),
        input_sha256: hash(&serde_json::to_vec(input)?),
        actual_result: result.clone(),
        result_sha256: hash(&serde_json::to_vec(result)?),
        content_sha256: hash(verified.bytes()),
        byte_content_sha256: result
            .get("sha256")
            .or_else(|| result.get("bodySha256"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let office = if rule.action.reconciles_effect().is_some() {
        crate::app_server::integrations::office::native_host::NativeOfficeComposition::observe_metadata(native, &engine, Default::default())?
            .context("APPLICATION_BUSINESS_LOOKUP_INTENT_REQUIRED")?
    } else {
        crate::app_server::integrations::office::native_host::NativeOfficeComposition::initialize_metadata(native, &engine, Default::default(), &operation)?
    };
    let readback_for = if rule.action == McpApplicationAction::DocumentRead
        && caller
            .call()
            .request
            .payload
            .get("businessAction")
            .and_then(Value::as_str)
            == Some("document.create")
    {
        let effect = format!(
            "application-effect-{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                caller
                    .call()
                    .request
                    .operation_id
                    .as_deref()
                    .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?,
                McpApplicationAction::DocumentCreate
            ]))?)
        );
        let operations = crate::app_server::integrations::core::NativeOperations::load(native)?
            .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?;
        let created = operations
            .read(native, &effect)?
            .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?;
        ensure!(
            created.phase == IntegrationOperationPhase::Completed,
            "APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED"
        );
        let reference = created
            .entity_ref
            .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?;
        ensure!(
            reference.kind == IntegrationEntityKind::Artifact,
            "APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED"
        );
        Some(OfficeArtifactRef {
            id: reference.id,
            revision: reference
                .revision
                .context("APPLICATION_DOCUMENT_CREATE_RECEIPT_REQUIRED")?
                .parse()?,
        })
    } else {
        None
    };
    office.publish_native_application_result(
        native,
        &task,
        &operation,
        receipt,
        verified,
        result,
        readback_for,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn disabled_office_output_blocks_an_accepted_effect_before_remote_io_or_namespace_creation()
    -> Result<()> {
        use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
        use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
        use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let engine = crate::app_server::tests::catalog_list_test_engine(&fixture.workspace)
            .with_settings_persistence_path(fixture.profile.join("settings.json"));
        engine.settings.write().unwrap().integrations.office.enabled = false;
        let attempt = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "output-owned-turn".into(),
            attempt_id: "output-owned-attempt".into(),
        };
        TurnAttemptStore::open(
            &engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )?
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: attempt.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        let effects = std::sync::atomic::AtomicUsize::new(0);
        engine
            .state
            .history_attempt_scope(attempt)?
            .run(async {
                let ctx = ToolContext::new(engine.state.clone());
                let outcome =
                    ensure_output_ready(&fixture.context, &engine, &ctx, "original-owned-effect");
                assert!(outcome.as_ref().is_err_and(|error| {
                    error
                        .chain()
                        .any(|error| error.to_string() == "OFFICE_DISABLED")
                }));
                if outcome.is_ok() {
                    effects.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 0);
                assert!(
                    NativeDomainGuard::observe(
                        fixture.context.profile()?,
                        fixture.context.scope(),
                        NativeDomain::Office
                    )?
                    .is_none()
                );
                Ok::<_, anyhow::Error>(())
            })
            .await?;
        Ok(())
    }
}
