//! Reconcile one original unknown effect through its actual registered lookup.
use super::*;
use crate::app_server::integrations::office::native_host::NativeOfficeComposition;
use kcoder_state::integrations::office::OfficeApplicationEffectIntent;

impl ApplicationBusinessTool {
    fn original_effect_tool(
        &self,
        intent: &OfficeApplicationEffectIntent,
        ctx: &ToolContext,
    ) -> Result<ApplicationBusinessTool> {
        intent.validate()?;
        let attempt = ctx
            .state
            .current_history_attempt_identity()
            .context("APPLICATION_BUSINESS_ACCEPTED_ATTEMPT_REQUIRED")?;
        ensure!(
            intent.owner == IntegrationOwner::from(self.shared.context.scope())
                && intent.task.thread_id == attempt.thread_id
                && intent.task.turn_id == attempt.turn_id
                && intent.root_operation_id == self.shared.operation()?
                && intent.source == *self.shared.connection.choice()
                && intent.resource_uris == self.shared.uris
                && self.rule.action.reconciles_effect() == Some(intent.rule.action),
            "APPLICATION_BUSINESS_LOOKUP_INTENT_CHANGED"
        );
        let original_connection = self
            .shared
            .caller
            .call()
            .request
            .payload
            .get("connectionId")
            .and_then(Value::as_str)
            .context("APPLICATION_ORIGINAL_CONNECTION_REQUIRED")?;
        let original_resources: Vec<IntegrationTaskResourceRef> = serde_json::from_value(
            self.shared
                .caller
                .call()
                .request
                .payload
                .get("resourceRefs")
                .cloned()
                .context("APPLICATION_ORIGINAL_RESOURCE_REQUIRED")?,
        )?;
        ensure!(
            intent.connection.id == original_connection
                && Some(intent.connection.revision.as_str())
                    == self
                        .shared
                        .caller
                        .call()
                        .request
                        .expected_revision
                        .as_deref()
                && intent.resources == original_resources,
            "APPLICATION_BUSINESS_LOOKUP_INTENT_CHANGED"
        );
        let original = self
            .shared
            .origin
            .active_tool_registry()
            .get(&intent.tool_name)
            .context("APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED")?;
        let (server, plugin, raw) = match original.source() {
            ToolSource::Mcp { server, tool } => (server, None, tool),
            ToolSource::Plugin {
                server,
                plugin,
                tool,
            } => (server, Some(plugin), tool),
            _ => anyhow::bail!("APPLICATION_BUSINESS_ACTUAL_MCP_REQUIRED"),
        };
        ensure!(
            original.is_model_visible()
                && server == intent.server
                && plugin == intent.plugin_id
                && raw == intent.raw_tool_name,
            "APPLICATION_BUSINESS_ORIGINAL_TOOL_CHANGED"
        );
        let tool = ApplicationBusinessTool {
            original,
            rule: intent.rule.clone(),
            shared: self.shared.clone(),
        };
        // This checks the saved intent only. It never dispatches the earlier tool.
        tool.verify(&intent.approved_input)?;
        let request = tool.effect_request(&intent.approved_input)?;
        ensure!(
            request.operation_id.as_deref() == Some(intent.effect_operation_id.as_str()),
            "APPLICATION_BUSINESS_LOOKUP_INTENT_CHANGED"
        );
        let (receipt, fresh) = self.shared.operations.begin(
            &self.shared.context,
            &request,
            "P-CONNECTION",
            "application.businessEffect",
        )?;
        ensure!(
            !fresh && receipt.phase == IntegrationOperationPhase::Unknown,
            "APPLICATION_BUSINESS_LOOKUP_ORIGINAL_UNKNOWN_REQUIRED"
        );
        Ok(tool)
    }
    pub(super) async fn reconcile_original(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput> {
        let action = self
            .rule
            .action
            .reconciles_effect()
            .context("APPLICATION_BUSINESS_LOOKUP_ACTION_REQUIRED")?;
        let operation = format!(
            "application-effect-{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                self.shared.operation()?,
                action
            ]))?)
        );
        let receipt = self
            .shared
            .operations
            .read(&self.shared.context, &operation)?
            .context("APPLICATION_BUSINESS_LOOKUP_ORIGINAL_UNKNOWN_REQUIRED")?;
        if receipt.phase == IntegrationOperationPhase::Completed {
            return Ok(ToolOutput::text(json!({"operationReceipt":receipt,"alreadyKnown":true,"reconciled":false,"replayed":false}).to_string()));
        }
        ensure!(
            receipt.phase == IntegrationOperationPhase::Unknown,
            "APPLICATION_BUSINESS_LOOKUP_ORIGINAL_UNKNOWN_REQUIRED"
        );
        let mut engine = self.shared.origin.clone();
        engine.state = ctx.state.clone();
        let office = NativeOfficeComposition::observe_metadata(
            &self.shared.context,
            &engine,
            Default::default(),
        )?
        .context("APPLICATION_BUSINESS_LOOKUP_INTENT_REQUIRED")?;
        let intent = office
            .read_native_application_effect_intent(&self.shared.context, &operation)?
            .context("APPLICATION_BUSINESS_LOOKUP_INTENT_REQUIRED")?;
        let original = self.original_effect_tool(&intent, ctx)?;
        self.verify(&input)?;
        let output = self.original.call(input.clone(), ctx).await?;
        ensure!(!output.is_error, "APPLICATION_BUSINESS_LOOKUP_UNCONFIRMED");
        self.verify(&input)?;
        self.original_effect_tool(&intent, ctx)?;
        let value = output
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => serde_json::from_str::<Value>(text).ok(),
                _ => None,
            })
            .context("APPLICATION_BUSINESS_LOOKUP_UNCONFIRMED")?;
        let (verified, proof) =
            super::super::business_result::lookup::verify(self.rule.action, &intent, &value)?;
        let manifest = super::super::business_result::publish(
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
            None,
            Some(proof),
        )?;
        original.verify(&intent.approved_input)?;
        self.verify(&input)?;
        let completed = self.shared.operations.transition_with_entity(
            &self.shared.context,
            &receipt,
            IntegrationOperationPhase::Completed,
            Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Artifact,
                id: manifest.id.clone(),
                revision: Some(manifest.revision.to_string()),
            }),
            None,
        )?;
        let mut public_result = value;
        if let Some(object) = public_result
            .get_mut("object")
            .and_then(Value::as_object_mut)
        {
            object.remove("base64");
        }
        Ok(ToolOutput::text(json!({"applicationLookup":public_result,"manifest":manifest,
            "operationReceipt":completed,"reconciled":true,"replayed":false,"businessComplete":true,"contentVerified":true}).to_string()))
    }
}
