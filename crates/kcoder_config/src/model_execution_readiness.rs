//! Explicit model parameters are required only at the execution boundary.
use crate::Settings;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelConfigurationField {
    ApiFormat,
    Model,
    ContextWindowTokens,
    OutputHeadroomTokens,
    MaxOutputTokens,
    HardInputTokens,
    AutoCompactThresholdTokens,
    PrefireThresholdTokens,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelExecutionConfigurationError {
    pub kind: ModelExecutionConfigurationKind,
    pub fields: Vec<ModelConfigurationField>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ModelExecutionConfigurationKind {
    Unconfigured,
    MissingLimits,
    InvalidLimits,
}

impl ModelExecutionConfigurationError {
    pub fn code(&self) -> &'static str {
        match self.kind {
            ModelExecutionConfigurationKind::Unconfigured => "provider_unconfigured",
            ModelExecutionConfigurationKind::MissingLimits => "model_limits_missing",
            ModelExecutionConfigurationKind::InvalidLimits => "settings_schema_invalid",
        }
    }
}

impl std::fmt::Display for ModelExecutionConfigurationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind {
            ModelExecutionConfigurationKind::Unconfigured => out.write_str("Select an explicit Provider and model in settings before running a task."),
            ModelExecutionConfigurationKind::MissingLimits => out.write_str("Configure this model's context window, output headroom and output limit before running a task."),
            ModelExecutionConfigurationKind::InvalidLimits => out.write_str("Correct this model's explicit token limits in settings before running a task."),
        }
    }
}
impl std::error::Error for ModelExecutionConfigurationError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExplicitModelLimits {
    pub context_window_tokens: usize,
    pub output_headroom_tokens: usize,
    pub max_output_tokens: u32,
    pub hard_input_limit: usize,
}

/// This function performs no I/O, catalog selection, credential resolution or
/// mutation. An offline transport does not make settings unavailable.
pub fn validate_model_execution_settings(
    settings: &Settings,
) -> Result<ExplicitModelLimits, ModelExecutionConfigurationError> {
    let mut fields = Vec::new();
    if settings.api_format.is_none() {
        fields.push(ModelConfigurationField::ApiFormat);
    }
    if settings.model.trim().is_empty() {
        fields.push(ModelConfigurationField::Model);
    }
    if !fields.is_empty() {
        return Err(ModelExecutionConfigurationError {
            kind: ModelExecutionConfigurationKind::Unconfigured,
            fields,
        });
    }
    validate_explicit_model_limits(settings)
}

/// A budget reader can report unavailable without inventing a model context.
pub fn validate_explicit_model_limits(
    settings: &Settings,
) -> Result<ExplicitModelLimits, ModelExecutionConfigurationError> {
    let mut fields = Vec::new();
    let context = settings.context_window_tokens.filter(|value| *value > 0);
    let headroom = settings.context_output_headroom.filter(|value| *value > 0);
    let output = settings.max_tokens.filter(|value| *value > 0);
    if context.is_none() {
        fields.push(ModelConfigurationField::ContextWindowTokens);
    }
    if headroom.is_none() {
        fields.push(ModelConfigurationField::OutputHeadroomTokens);
    }
    if output.is_none() {
        fields.push(ModelConfigurationField::MaxOutputTokens);
    }
    if !fields.is_empty() {
        return Err(ModelExecutionConfigurationError {
            kind: ModelExecutionConfigurationKind::MissingLimits,
            fields,
        });
    }
    let (Some(context), Some(headroom), Some(output)) = (context, headroom, output) else {
        return Err(ModelExecutionConfigurationError {
            kind: ModelExecutionConfigurationKind::MissingLimits,
            fields,
        });
    };
    if headroom >= context {
        fields.push(ModelConfigurationField::OutputHeadroomTokens);
    }
    if output as usize > context {
        fields.push(ModelConfigurationField::MaxOutputTokens);
    }
    let hard = settings
        .context_hard_input_tokens
        .unwrap_or_else(|| context.saturating_sub(headroom));
    if hard == 0 || hard >= context {
        fields.push(ModelConfigurationField::HardInputTokens);
    }
    let soft = settings.auto_compact_threshold_tokens.unwrap_or_else(|| {
        hard.saturating_mul(
            settings
                .context_compaction
                .auto_threshold
                .percentage_for(context),
        ) / 100
    });
    if soft == 0 || soft >= hard {
        fields.push(ModelConfigurationField::AutoCompactThresholdTokens);
    }
    if settings
        .prefire_threshold_tokens
        .is_some_and(|value| value == 0 || value >= soft)
    {
        fields.push(ModelConfigurationField::PrefireThresholdTokens);
    }
    if !fields.is_empty() {
        return Err(ModelExecutionConfigurationError {
            kind: ModelExecutionConfigurationKind::InvalidLimits,
            fields,
        });
    }
    Ok(ExplicitModelLimits {
        context_window_tokens: context,
        output_headroom_tokens: headroom,
        max_output_tokens: output,
        hard_input_limit: hard,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_configuration_remains_unconfigured_without_selecting_a_catalog_entry() {
        let settings = Settings::default();
        assert_eq!(
            validate_model_execution_settings(&settings)
                .unwrap_err()
                .code(),
            "provider_unconfigured"
        );
        assert!(settings.providers.is_empty());
        assert!(settings.model.is_empty());
        assert_eq!(settings.context_window_tokens, None);
    }
    #[test]
    fn missing_limits_are_a_recoverable_error_and_never_a_default_context() {
        let settings = Settings {
            api_format: Some(crate::ApiFormat::OpenaiChatCompletions),
            model: "explicit-model".into(),
            ..Settings::default()
        };
        let error = validate_model_execution_settings(&settings).unwrap_err();
        assert_eq!(error.code(), "model_limits_missing");
        assert!(
            error
                .fields
                .contains(&ModelConfigurationField::ContextWindowTokens)
        );
        assert_eq!(settings.context_window_tokens, None);
    }
    #[test]
    fn valid_explicit_limits_do_not_require_an_online_service_or_change_permissions() {
        let mut settings = Settings {
            api_format: Some(crate::ApiFormat::OpenaiChatCompletions),
            base_url: Some("http://127.0.0.1:1/v1".into()),
            model: "explicit-model".into(),
            context_window_tokens: Some(32768),
            context_output_headroom: Some(1024),
            max_tokens: Some(2048),
            ..Settings::default()
        };
        let original = serde_json::to_value(&settings).unwrap();
        let limits = validate_model_execution_settings(&settings).unwrap();
        assert_eq!(limits.hard_input_limit, 31744);
        assert_eq!(serde_json::to_value(&settings).unwrap(), original);
        settings.context_output_headroom = Some(32768);
        assert_eq!(
            validate_model_execution_settings(&settings)
                .unwrap_err()
                .code(),
            "settings_schema_invalid"
        );
    }
}
