//! Final-request reservation estimates shared by Native model admission adapters.
use crate::token_counter::TokenCounter;
use anyhow::{Context, Result, ensure};
use kcoder_types::{MessagesRequest, ModelConfigurationSummary};

pub fn effective_output_limit(
    configuration: &kcoder_types::ModelConfigurationSummary,
    request: &MessagesRequest,
) -> Result<u32> {
    ensure!(
        request.model == configuration.model_id && request.max_tokens > 0,
        "AUTOMATION_MODEL_OUTPUT_POLICY_UNAVAILABLE"
    );
    let mut effective = request.max_tokens;
    // The settings default is a ceiling, not a minimum for smaller auxiliary
    // requests. Only actual Provider extra-body overrides can replace the final
    // request's limit; reserve their conservative maximum without rewriting it.
    for field in &configuration.request_override_fields {
        if ["max_tokens", "max_completion_tokens", "max_output_tokens"].contains(&field.as_str()) {
            let limit = configuration
                .request_output_limits
                .get(field)
                .copied()
                .flatten()
                .filter(|limit| *limit > 0)
                .context("AUTOMATION_MODEL_OUTPUT_POLICY_UNAVAILABLE")?;
            effective = effective.max(limit);
        }
    }
    ensure!(
        configuration
            .max_output_tokens
            .is_some_and(|maximum| effective <= maximum),
        "AUTOMATION_MODEL_OUTPUT_POLICY_UNAVAILABLE"
    );
    Ok(effective)
}
pub fn reservation_input(request: &MessagesRequest) -> Result<u64> {
    let estimate = u64::try_from(TokenCounter::count_request(request, true).tokens)?;
    let mut input = estimate
        .checked_add(estimate / 2)
        .and_then(|value| value.checked_add(128))
        .context("AUTOMATION_BUDGET_OVERFLOW")?;
    // These final request fields are skipped by the base serialization and
    // static-prefix counter, but compatible transports add them to the wire.
    // Count their full UTF-8 bytes plus framing; this remains a reservation,
    // never reported usage or a request/body transformation.
    if let Some(schema) = &request.response_json_schema {
        let bytes = u64::try_from(
            serde_json::to_vec(&(
                &schema.name,
                &schema.description,
                &schema.schema,
                schema.strict,
            ))?
            .len(),
        )?;
        input = input
            .checked_add(bytes)
            .and_then(|value| value.checked_add(128))
            .context("AUTOMATION_BUDGET_OVERFLOW")?;
    }
    if let Some(effort) = &request.reasoning_effort {
        let bytes = u64::try_from(serde_json::to_vec(effort)?.len())?;
        input = input
            .checked_add(bytes)
            .and_then(|value| value.checked_add(64))
            .context("AUTOMATION_BUDGET_OVERFLOW")?;
    }
    if request.recovery_disable_reasoning {
        input = input
            .checked_add(64)
            .context("AUTOMATION_BUDGET_OVERFLOW")?;
    }
    Ok(input)
}

pub fn validate_model_input(configuration: &ModelConfigurationSummary) -> Result<()> {
    ensure!(
        !configuration.request_override_fields.iter().any(|field| [
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "input",
            "instructions",
            "response_format"
        ]
        .contains(&field.as_str())),
        "ORGANIZATION_MODEL_INPUT_OVERRIDE_UNAVAILABLE"
    );
    Ok(())
}
