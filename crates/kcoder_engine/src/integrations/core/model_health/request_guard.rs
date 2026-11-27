//! Final request compatibility is checked against the actual bound AUTO model,
//! never against client preview labels. This object can only add a restriction.
use crate::{QueryEngine, context::TokenCounter};
use anyhow::{Result, ensure};
use kcoder_types::{ContentBlock, Message, MessagesRequest, integrations::core::*};

pub(super) struct AutoRequestGuard {
    pub(super) engine: QueryEngine,
    pub(super) resolution: IntegrationModelResolutionResult,
}
impl AutoRequestGuard {
    pub(super) fn validate(&self, request: &MessagesRequest) -> Result<()> {
        super::super::model_policies::validate_integration_auto_model(
            &self.engine,
            &self.resolution,
        )?;
        let model = &self.resolution.model;
        ensure!(
            request.model == model.model_id,
            "MODEL_AUTO_REQUEST_IDENTITY_CHANGED"
        );
        ensure!(request.max_tokens > 0, "MODEL_AUTO_REQUEST_OUTPUT_INVALID");
        let mut requirements = transition_requirements(request)?;
        requirements.output_tokens = Some(
            model
                .request_output_limits
                .values()
                .flatten()
                .copied()
                .max()
                .unwrap_or(0)
                .max(request.max_tokens)
                .into(),
        );
        super::super::model_selection::validate_requirements(model, &requirements)?;
        if request.response_json_schema.is_some() {
            ensure!(
                self.engine
                    .current_raw_provider()
                    .supports_response_json_schema(),
                "MODEL_AUTO_STRUCTURED_TRANSPORT_UNSUPPORTED"
            );
        }
        Ok(())
    }
}
fn has_image(request: &MessagesRequest) -> bool {
    let mut pending: Vec<&[ContentBlock]> = request
        .messages
        .iter()
        .map(|message| match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => {
                content.as_slice()
            }
        })
        .collect();
    while let Some(blocks) = pending.pop() {
        for block in blocks {
            match block {
                ContentBlock::Image { .. } => return true,
                ContentBlock::ToolResult { content, .. } => pending.push(content),
                _ => {}
            }
        }
    }
    false
}

pub(crate) fn transition_requirements(
    request: &MessagesRequest,
) -> Result<IntegrationModelRequirements> {
    let base_input = TokenCounter::count_request(request, true).tokens;
    // The provider maps this skipped local field into its actual wire
    // format, so it is absent from the generic request JSON/token count.
    let schema_input = request
            .response_json_schema
            .as_ref()
            .map(|schema| {
                serde_json::to_string(&serde_json::json!({"name":schema.name,"description":schema.description,"schema":schema.schema,"strict":schema.strict})).map(|value| {
                    TokenCounter::rough_char_estimate(&value)
                        .saturating_mul(4)
                        .div_ceil(3)
                })
            })
            .transpose()?
            .unwrap_or(0);
    let input = base_input
        .checked_add(schema_input)
        .ok_or_else(|| anyhow::anyhow!("MODEL_CONTEXT_CAPACITY_EXCEEDED"))?;
    Ok(IntegrationModelRequirements {
        input_tokens: Some(u64::try_from(input)?),
        output_tokens: Some(request.max_tokens.into()),
        vision: has_image(request),
        tools: !request.tools.is_empty(),
        structured_output: request.response_json_schema.is_some(),
    })
}
