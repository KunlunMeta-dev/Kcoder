//! Finite reviewed application calls reuse the actual registered MCP object.
use super::*;
use crate::app_server::integrations::core::NativeOperations;
use kcoder_engine::integrations::core::{
    NativeToolAuthorizationPhase, NativeToolAuthorizationRequest,
};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolRegistry, ToolSource};
use kcoder_types::{ContentBlock, McpApplicationActionRule};
use std::sync::Mutex;
mod reconciliation;

pub(super) struct NativeApplicationBusiness {
    shared: Arc<Shared>,
    tools: ToolRegistry,
}
struct Shared {
    context: NativeIntegrationContext,
    caller: Arc<NativeConnectivityPublicCall>,
    grant: Arc<NativeApplicationTaskGrant>,
    connection: Arc<NativeApplicationResourceConnection>,
    origin: QueryEngine,
    uris: Vec<String>,
    state: OnceLock<kcoder_state::AppState>,
    operations: NativeOperations,
    effects: Mutex<()>,
}
fn unknown_effect_error() -> IntegrationError {
    IntegrationError {
        code: "APPLICATION_BUSINESS_OUTCOME_UNKNOWN".into(),
        recovery: IntegrationRecovery::ReconcileOriginal,
        message_key: "connectivity.reconcileOriginal".into(),
    }
}
fn operations_for_task(
    native: &NativeIntegrationContext,
    operation: &str,
) -> Result<NativeOperations> {
    match NativeOperations::load(native)? {
        Some(existing) => Ok(existing),
        None => NativeOperations::initialize(native, operation),
    }
}
fn original_tool_error_code(error: &ToolError) -> &'static str {
    match error {
        ToolError::Aborted => "TOOL_ABORTED",
        ToolError::SandboxDenied { .. } => "SANDBOX_DENIED",
        ToolError::InvalidInput(_) => "TOOL_INPUT_INVALID",
        ToolError::Execution(message) if message.contains("NATIVE_TASK_AUTHORITY_DENIED") => {
            "NATIVE_TASK_AUTHORITY_DENIED"
        }
        ToolError::Execution(message) if message.contains("NATIVE_TASK_AUTHORITY_UNAVAILABLE") => {
            "NATIVE_TASK_AUTHORITY_UNAVAILABLE"
        }
        ToolError::Execution(_) => "ORIGINAL_MCP_EXECUTION_ERROR",
    }
}
pub(super) struct ApplicationBusinessTool {
    original: Arc<dyn Tool>,
    rule: McpApplicationActionRule,
    shared: Arc<Shared>,
}
impl NativeApplicationBusiness {
    pub(super) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        caller: Arc<NativeConnectivityPublicCall>,
        grant: Arc<NativeApplicationTaskGrant>,
        connection: Arc<NativeApplicationResourceConnection>,
        uris: Vec<String>,
    ) -> Result<Option<Arc<Self>>> {
        caller.verify(native.scope())?;
        connection.verify_current(native)?;
        let task = caller
            .call()
            .request
            .payload
            .get("businessAction")
            .and_then(Value::as_str)
            .context("APPLICATION_BUSINESS_ACTION_REQUIRED")?;
        let required_effect = matches!(task, "document.create" | "mail.send" | "table.export");
        let mut reviewed = Vec::new();
        let mut effect = false;
        for original in engine.active_tool_registry().all() {
            if !original.is_model_visible() {
                continue;
            }
            let object: &dyn std::any::Any = original.as_ref();
            let Some(actual) = object.downcast_ref::<kcoder_mcp::McpTool>() else {
                continue;
            };
            if !connection.matches_registered_tool(actual) {
                continue;
            }
            let raw = match original.source() {
                ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
                _ => continue,
            };
            let origin = actual
                .native_origin()
                .context("APPLICATION_BUSINESS_NATIVE_SOURCE_REQUIRED")?;
            let Some(rule) = origin
                .private_config()
                .policy
                .application_actions
                .get(&raw)
                .cloned()
            else {
                continue;
            };
            if !rule.action.permits_task(task) {
                continue;
            }
            ensure!(
                rule.schema_sha256
                    == format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(&original.input_schema())?)
                    ),
                "APPLICATION_BUSINESS_SCHEMA_CHANGED"
            );
            effect |= rule.action.is_effect();
            reviewed.push((original, rule));
        }
        if reviewed.is_empty() && !required_effect {
            return Ok(None);
        }
        ensure!(
            !reviewed.is_empty() && reviewed.len() <= 16 && (!required_effect || effect),
            "APPLICATION_BUSINESS_REVIEWED_ACTION_REQUIRED"
        );
        let operation = caller
            .call()
            .request
            .operation_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?;
        let shared = Arc::new(Shared {
            context: native.recapture_for_owned_service()?,
            caller: caller.clone(),
            grant,
            connection,
            origin: engine.clone(),
            uris,
            state: OnceLock::new(),
            operations: operations_for_task(native, operation)?,
            effects: Mutex::new(()),
        });
        let mut tools = ToolRegistry::new();
        for (original, rule) in reviewed {
            tools = tools.register_arc(Arc::new(ApplicationBusinessTool {
                original,
                rule,
                shared: shared.clone(),
            }));
        }
        Ok(Some(Arc::new(Self { shared, tools })))
    }
    pub(super) fn uris(&self) -> &[String] {
        &self.shared.uris
    }
    pub(super) fn registry(&self) -> ToolRegistry {
        self.tools.clone()
    }
    pub(super) fn bind_state(&self, state: &kcoder_state::AppState) -> Result<()> {
        if let Some(original) = self.shared.state.get() {
            ensure!(
                original.inspection_lifecycle_identity().matches(state),
                "APPLICATION_BUSINESS_STATE_CHANGED"
            );
        } else {
            self.shared
                .state
                .set(state.clone())
                .map_err(|_| anyhow::anyhow!("APPLICATION_BUSINESS_STATE_CHANGED"))?;
        }
        Ok(())
    }
    pub(super) fn authorize(&self, request: &NativeToolAuthorizationRequest<'_>) -> Result<()> {
        let execution = request
            .execution
            .context("APPLICATION_BUSINESS_ACTOR_REQUIRED")?;
        let state = self
            .shared
            .state
            .get()
            .context("APPLICATION_BUSINESS_STATE_REQUIRED")?;
        ensure!(
            execution.matches_state(state)
                && execution.parent().is_none()
                && execution.attempt().is_some()
                && state.matches_current_history_attempt(execution.attempt())
                && !request.without_sandbox,
            "APPLICATION_BUSINESS_ACTOR_CHANGED"
        );
        let emitter = request
            .emitter
            .context("APPLICATION_BUSINESS_EMITTER_REQUIRED")?;
        let wrapper = emitter
            .downcast_tool::<ApplicationBusinessTool>()
            .context("APPLICATION_BUSINESS_ACTUAL_WRAPPER_REQUIRED")?;
        ensure!(
            Arc::ptr_eq(&wrapper.shared, &self.shared)
                && self
                    .tools
                    .get(request.tool_name)
                    .is_some_and(|tool| emitter.matches_tool(&tool))
                && request.source == wrapper.original.source(),
            "APPLICATION_BUSINESS_ACTUAL_TOOL_CHANGED"
        );
        wrapper.verify(request.input)?;
        if request.phase == NativeToolAuthorizationPhase::Dispatch {
            self.shared.verify()?;
        }
        Ok(())
    }
}
impl Shared {
    fn verify(&self) -> Result<()> {
        self.context.verify()?;
        self.context
            .validate_scope(&self.caller.call().request.scope)?;
        self.grant.verify(&self.context)?;
        self.connection.verify_current(&self.context)?;
        self.operations.verify(&self.context)
    }
    fn operation(&self) -> Result<&str> {
        self.caller
            .call()
            .request
            .operation_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")
    }
}
impl ApplicationBusinessTool {
    pub(super) fn original_source_tool(
        &self,
        native: &NativeIntegrationContext,
    ) -> Result<Arc<dyn Tool>> {
        native.validate_scope(self.shared.context.scope())?;
        self.shared.verify()?;
        ensure!(
            self.original.is_model_visible()
                && self
                    .shared
                    .origin
                    .active_tool_registry()
                    .all()
                    .iter()
                    .any(|tool| Arc::ptr_eq(tool, &self.original)),
            "APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED"
        );
        let object: &dyn std::any::Any = self.original.as_ref();
        let actual = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED")?;
        ensure!(
            self.shared.connection.matches_registered_tool(actual)
                && actual.app_authority_current()
                && self.rule.schema_sha256
                    == format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(&actual.input_schema())?)
                    ),
            "APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED"
        );
        let raw = match self.original.source() {
            ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
            _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
        };
        ensure!(
            actual.native_origin().is_some_and(|origin| origin
                .private_config()
                .policy
                .application_actions
                .get(&raw)
                == Some(&self.rule)),
            "APPLICATION_BUSINESS_POLICY_CHANGED"
        );
        Ok(self.original.clone())
    }
    fn verify(&self, input: &Value) -> Result<()> {
        self.shared.verify()?;
        ensure!(
            self.shared
                .origin
                .active_tool_registry()
                .all()
                .iter()
                .any(|tool| Arc::ptr_eq(tool, &self.original)),
            "APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED"
        );
        let object: &dyn std::any::Any = self.original.as_ref();
        let actual = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED")?;
        ensure!(
            self.shared.connection.matches_registered_tool(actual)
                && actual.app_authority_current(),
            "APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED"
        );
        let raw = match self.original.source() {
            ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
            _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
        };
        ensure!(
            actual.native_origin().is_some_and(|origin| origin
                .private_config()
                .policy
                .application_actions
                .get(&raw)
                == Some(&self.rule)),
            "APPLICATION_BUSINESS_POLICY_CHANGED"
        );
        let schema = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.original.input_schema())?)
        );
        let task = self
            .shared
            .caller
            .call()
            .request
            .payload
            .get("businessAction")
            .and_then(Value::as_str)
            .context("APPLICATION_BUSINESS_ACTION_REQUIRED")?;
        let uri = self
            .rule
            .resource_uri(&schema, task, self.shared.operation()?, input)
            .context("APPLICATION_BUSINESS_INPUT_DENIED")?;
        ensure!(
            self.shared.uris.iter().any(|selected| selected == uri),
            "APPLICATION_BUSINESS_RESOURCE_DENIED"
        );
        super::business_result::verify_input(self.rule.action, self.shared.operation()?, input)?;
        Ok(())
    }
    fn effect_request(&self, input: &Value) -> Result<IntegrationRequest> {
        let mut request = self.shared.caller.call().request.clone();
        request.request_id = "application-native-business-effect".into();
        request.operation_id = Some(format!(
            "application-effect-{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                self.shared.operation()?,
                self.rule.action
            ]))?)
        ));
        let source = match self.original.source() {
            ToolSource::Mcp { server, tool } => {
                json!({"server":server,"pluginId":null,"tool":tool})
            }
            ToolSource::Plugin {
                server,
                plugin,
                tool,
            } => json!({"server":server,"pluginId":plugin,"tool":tool}),
            _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
        };
        request.payload=json!({"rootOperationId":self.shared.operation()?,"source":source,"choice":self.shared.connection.choice(),
            "connectionId":self.shared.caller.call().request.payload.get("connectionId"),"connectionRevision":self.shared.caller.call().request.expected_revision,
            "resourceRefs":self.shared.caller.call().request.payload.get("resourceRefs"),"rule":self.rule,
            "inputSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(input)?))}).as_object().unwrap().clone();
        Ok(request)
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl Tool for ApplicationBusinessTool {
    fn is_model_visible(&self) -> bool {
        self.original.is_model_visible()
    }
    fn name(&self) -> String {
        self.original.name()
    }
    fn source(&self) -> ToolSource {
        self.original.source()
    }
    fn description(&self) -> String {
        let boundary = if self.rule.action == kcoder_types::McpApplicationAction::DocumentCreate {
            " Creation confirms the object only. Read its original documentId back with document.read; persisted title/body and original creation identity must be verified before content is complete."
        } else {
            ""
        };
        format!(
            "{}\nUse the task's original operationId. Never repeat an unknown effect.{boundary}",
            self.original.description()
        )
    }
    fn input_schema(&self) -> Value {
        self.original.input_schema()
    }
    fn input_schema_is_stable(&self) -> bool {
        self.original.input_schema_is_stable()
    }
    fn requires_explicit_approval(&self) -> bool {
        self.rule.action.is_effect()
    }
    async fn call(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> std::result::Result<ToolOutput, ToolError> {
        let work = async {
            if self.rule.action.is_effect() {
                ensure!(
                    ctx.authorizes_native_tool_invocation(self, &input),
                    "APPLICATION_BUSINESS_FINAL_NATIVE_APPROVAL_REQUIRED"
                );
            }
            let state = self
                .shared
                .state
                .get()
                .context("APPLICATION_BUSINESS_STATE_REQUIRED")?;
            ensure!(
                state.inspection_lifecycle_identity().matches(&ctx.state) && !ctx.is_aborted(),
                "APPLICATION_BUSINESS_ACTOR_CHANGED"
            );
            ctx.verify_native_transport_authorization().await?;
            self.verify(&input)?;
            if self.rule.action.reconciles_effect().is_some() {
                return self.reconcile_original(input.clone(), ctx).await;
            }
            if self.rule.action.is_effect() {
                super::business_result::ensure_output_ready(
                    &self.shared.context,
                    &self.shared.origin,
                    ctx,
                    self.shared.operation()?,
                )?;
                self.verify(&input)?;
            }
            let receipt = if self.rule.action.is_effect() {
                let _lock = self
                    .shared
                    .effects
                    .lock()
                    .map_err(|_| anyhow::anyhow!("APPLICATION_BUSINESS_EFFECT_UNAVAILABLE"))?;
                let request = self.effect_request(&input)?;
                let (receipt, fresh) = self.shared.operations.begin(
                    &self.shared.context,
                    &request,
                    "P-CONNECTION",
                    "application.businessEffect",
                )?;
                if !fresh {
                    return Ok(ToolOutput::error(json!({"code":"APPLICATION_BUSINESS_RECONCILE_ORIGINAL","operationReceipt":receipt,"recovery":"reconcile_original","replayed":false}).to_string()));
                }
                // Persist uncertainty before IO; source revocation cannot erase it.
                Some(self.shared.operations.transition(
                    &self.shared.context,
                    &receipt,
                    IntegrationOperationPhase::Unknown,
                    Some(unknown_effect_error()),
                )?)
            } else {
                None
            };
            if let Some(effect) = &receipt {
                super::business_result::save_effect_intent(
                    &self.shared.context,
                    &self.shared.origin,
                    ctx,
                    &self.shared.caller,
                    self.original.as_ref(),
                    self.shared.connection.choice(),
                    &self.shared.uris,
                    &self.rule,
                    &input,
                    &effect.operation_id,
                )?;
                self.verify(&input)?;
            }
            let result = self.original.call(input.clone(), ctx).await;
            if let Err(error) = &result {
                tracing::warn!(stage="original_mcp_call",error_code=original_tool_error_code(error),
                    error_sha256=%format!("{:x}",Sha256::digest(error.to_string().as_bytes())),
                    "Original native application MCP call returned an error");
            }
            let output = match result {
                Ok(output) if !output.is_error => output,
                Ok(_) => anyhow::bail!("APPLICATION_BUSINESS_ORIGINAL_MCP_RESULT_UNCONFIRMED"),
                result => {
                    return result
                        .map_err(anyhow::Error::from)
                        .context("APPLICATION_BUSINESS_ORIGINAL_MCP_CALL_FAILED");
                }
            };
            self.verify(&input)?;
            let value = output
                .content
                .iter()
                .find_map(|block| match block {
                    ContentBlock::Text { text } => serde_json::from_str::<Value>(text).ok(),
                    _ => None,
                })
                .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
            let verified = super::business_result::verify(
                self.rule.action,
                self.shared.operation()?,
                &input,
                &value,
            )?;
            let mut public_result = value.clone();
            if matches!(
                self.rule.action,
                kcoder_types::McpApplicationAction::MailAttachment
                    | kcoder_types::McpApplicationAction::TableExport
            ) {
                public_result
                    .as_object_mut()
                    .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?
                    .remove("base64");
                if self.rule.action == kcoder_types::McpApplicationAction::MailAttachment
                    && matches!(
                        verified.format(),
                        kcoder_types::integrations::office::OfficeFileFormat::Csv
                            | kcoder_types::integrations::office::OfficeFileFormat::Json
                    )
                {
                    public_result["preview"] = json!(std::str::from_utf8(verified.bytes())?);
                }
            }
            let manifest = super::business_result::publish(
                &self.shared.context,
                &self.shared.origin,
                ctx,
                &self.shared.caller,
                self.original.as_ref(),
                self.shared.connection.choice(),
                &self.rule,
                &input,
                &value,
                verified,
                receipt.as_ref().map(|receipt| receipt.operation_id.clone()),
                None,
            )?;
            self.verify(&input)?;
            let completed = if let Some(receipt) = receipt {
                Some(self.shared.operations.transition_with_entity(
                    &self.shared.context,
                    &receipt,
                    IntegrationOperationPhase::Completed,
                    Some(IntegrationEntityRef {
                        kind: IntegrationEntityKind::Artifact,
                        id: manifest.id.clone(),
                        revision: Some(manifest.revision.to_string()),
                    }),
                    None,
                )?)
            } else {
                None
            };
            let business_complete =
                self.rule.action != kcoder_types::McpApplicationAction::DocumentCreate;
            Ok(ToolOutput::text(json!({"applicationResult":public_result,"manifest":manifest,"operationReceipt":completed,"businessComplete":business_complete,"contentVerified":business_complete}).to_string()))
        };
        work.await.map_err(|error:anyhow::Error|{
            let code=error.chain().map(ToString::to_string).find(|text|text.starts_with("APPLICATION_") && text.len()<=128).unwrap_or_else(||"APPLICATION_BUSINESS_UNCONFIRMED".into());
            let effect=self.rule.action.is_effect().then(||self.effect_request(&input).ok()).flatten().and_then(|request|request.operation_id);
            let receipt=effect.as_ref().and_then(|operation|self.shared.operations.read(&self.shared.context,operation).ok().flatten());
            ToolError::Execution(json!({"code":code,"rootOperationId":self.shared.operation().ok(),"effectOperationId":effect,"operationReceipt":receipt,"recovery":"reconcile_original","replayed":false}).to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn different_original_tasks_reuse_the_same_verified_operations_namespace() -> Result<()> {
        use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let first = operations_for_task(&fixture.context, "first-original-task")?;
        let before = NativeDomainGuard::observe(
            fixture.context.profile()?,
            fixture.context.scope(),
            NativeDomain::Operations,
        )?
        .unwrap();
        let identity = before
            .directory(fixture.context.profile()?)?
            .directory_identity()?;
        let (original, _) = first.begin(
            &fixture.context,
            &fixture.request("first-original-effect"),
            "P-CONNECTION",
            "application.businessEffect",
        )?;
        let second = operations_for_task(&fixture.context, "second-original-task")?;
        let after = NativeDomainGuard::observe(
            fixture.context.profile()?,
            fixture.context.scope(),
            NativeDomain::Operations,
        )?
        .unwrap();
        assert_eq!(
            identity,
            after
                .directory(fixture.context.profile()?)?
                .directory_identity()?
        );
        assert_eq!(
            second.read(&fixture.context, &original.operation_id)?,
            Some(original)
        );
        let (next, fresh) = second.begin(
            &fixture.context,
            &fixture.request("second-original-effect"),
            "P-CONNECTION",
            "application.businessEffect",
        )?;
        assert!(fresh);
        assert!(first.read(&fixture.context, &next.operation_id)?.is_some());
        Ok(())
    }
    #[test]
    fn dispatched_effect_is_durably_unknown_and_a_new_call_identity_never_dispatches_it_again()
    -> Result<()> {
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let operations = NativeOperations::initialize(&fixture.context, "original-effect")?;
        let mut request = fixture.request("original-effect");
        request.payload =
            json!({"rootOperationId":"original","action":"mail.send","inputSha256":"a".repeat(64)})
                .as_object()
                .unwrap()
                .clone();
        let (executing, fresh) = operations.begin(
            &fixture.context,
            &request,
            "P-CONNECTION",
            "application.businessEffect",
        )?;
        assert!(fresh);
        let unknown = operations.transition(
            &fixture.context,
            &executing,
            IntegrationOperationPhase::Unknown,
            Some(unknown_effect_error()),
        )?;
        drop(operations);
        let reopened = NativeOperations::load(&fixture.context)?.unwrap();
        request.request_id = "different-model-tool-call-id".into();
        let (existing, fresh) = reopened.begin(
            &fixture.context,
            &request,
            "P-CONNECTION",
            "application.businessEffect",
        )?;
        assert!(!fresh);
        assert_eq!(existing, unknown);
        assert_eq!(existing.phase, IntegrationOperationPhase::Unknown);
        request
            .payload
            .insert("inputSha256".into(), json!("b".repeat(64)));
        assert!(
            reopened
                .begin(
                    &fixture.context,
                    &request,
                    "P-CONNECTION",
                    "application.businessEffect"
                )
                .is_err()
        );
        Ok(())
    }
}
