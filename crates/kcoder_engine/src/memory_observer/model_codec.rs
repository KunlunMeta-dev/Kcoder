use kcoder_memory::{
    MemoryObserverDraft, MemoryObserverEventBundle, memory_observer_output_schema,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MemoryObserverModelFallbackKind {
    Provider,
    Parse,
    Validation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum MemoryObserverFailurePhase {
    Start,
    Stream,
    Parse,
    Validation,
}

#[derive(Debug, Clone)]
pub(super) struct MemoryObserverModelDraftError {
    pub(super) kind: MemoryObserverModelFallbackKind,
    pub(super) reason: String,
    pub(super) phase: MemoryObserverFailurePhase,
    pub(super) failure: Option<kcoder_types::ProviderFailureDetails>,
    pub(super) source: Option<std::sync::Arc<kcoder_api::ApiErrorKind>>,
}

impl std::fmt::Display for MemoryObserverModelDraftError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for MemoryObserverModelDraftError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_deref().map(|source| source as _)
    }
}

impl MemoryObserverModelDraftError {
    pub(super) fn provider(
        error: kcoder_api::ApiErrorKind,
        phase: MemoryObserverFailurePhase,
    ) -> Self {
        // Internal deterministic fallback never advertises safe replay of the request.
        let failure = crate::retry_policy::provider_failure_details(&error, true);
        let context = match phase {
            MemoryObserverFailurePhase::Start => "failed to start provider stream",
            _ => "provider stream error",
        };
        Self {
            kind: MemoryObserverModelFallbackKind::Provider,
            reason: format!("{context}: {error}"),
            phase,
            failure: Some(failure),
            source: Some(std::sync::Arc::new(error)),
        }
    }

    pub(super) fn parse(reason: impl Into<String>) -> Self {
        Self {
            kind: MemoryObserverModelFallbackKind::Parse,
            reason: reason.into(),
            phase: MemoryObserverFailurePhase::Parse,
            failure: None,
            source: None,
        }
    }
}

pub(super) fn memory_observer_model_system_prompt(observer_model: &str) -> String {
    let schema = serde_json::to_string_pretty(&memory_observer_output_schema())
        .unwrap_or_else(|_| "{}".to_string());
    let observer_model_json =
        serde_json::to_string(observer_model).unwrap_or_else(|_| "\"unknown\"".to_string());
    format!(
        "You are KCoder's private memory observer. Review sanitized tool/session events and return only one JSON object. Do not include Markdown, prose, or tool calls. The JSON must conform to the schema below. Preserve source_event_ids exactly from the input bundle. Respect sanitization audit fields; never infer omitted private file paths, private verification targets, or omitted prompts. Set audit.model to {observer_model_json} unless a more specific observer model name is available, and set audit.generated_at_epoch to the current Unix epoch milliseconds if known.\n\nSchema:\n{schema}"
    )
}

pub(super) fn memory_observer_model_user_prompt(bundle: &MemoryObserverEventBundle) -> String {
    let bundle_json = serde_json::to_string_pretty(bundle).unwrap_or_else(|error| {
        format!(
            "{{\"serialization_error\":\"failed to serialize observer bundle: {}\"}}",
            error
        )
    });
    format!(
        "Create a memory observer draft for this sanitized event bundle. Return only the JSON draft object.\n\nEvent bundle:\n```json\n{bundle_json}\n```"
    )
}

pub(super) fn parse_memory_observer_model_draft(text: &str) -> Result<MemoryObserverDraft, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("observer draft text is empty".to_string());
    }
    if let Ok(draft) = serde_json::from_str::<MemoryObserverDraft>(trimmed) {
        return Ok(draft);
    }

    let json = extract_json_object(trimmed)?;
    serde_json::from_str::<MemoryObserverDraft>(json).map_err(|error| {
        format!(
            "failed to parse observer draft JSON at line {}, column {}; response details withheld",
            error.line(),
            error.column()
        )
    })
}

fn extract_json_object(text: &str) -> Result<&str, String> {
    let start = text
        .find('{')
        .ok_or_else(|| "observer draft output did not contain a JSON object".to_string())?;
    let end = text
        .rfind('}')
        .ok_or_else(|| "observer draft output did not contain a closing JSON brace".to_string())?;
    if end < start {
        return Err("observer draft output had an invalid JSON object range".to_string());
    }
    Ok(&text[start..=end])
}

pub(super) fn memory_observer_model_fallback_kind_name(
    kind: MemoryObserverModelFallbackKind,
) -> &'static str {
    match kind {
        MemoryObserverModelFallbackKind::Provider => "provider",
        MemoryObserverModelFallbackKind::Parse => "parse",
        MemoryObserverModelFallbackKind::Validation => "validation",
    }
}
