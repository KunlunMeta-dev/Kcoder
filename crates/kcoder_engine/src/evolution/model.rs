//! Model selection and one-shot structured calls for evolution jobs
//! (plan section 15.1).
//!
//! `evolution.model` / `stage_models.*` reference an already configured
//! provider and model by exact, case-preserving identifiers; `None` follows
//! the triggering session's current model. An unknown or unbuildable
//! reference pauses model jobs with `model_unavailable`: there is no fallback
//! to the first catalog entry and no silent switch to another model.

use crate::{QueryEngine, recover_read_lock};
use futures::StreamExt;
use kcoder_api::{Provider, ProviderFactory, ProviderKind};
use kcoder_config::{EvolutionStage, Settings};
use kcoder_types::{
    ContentDelta, Message, MessagesRequest, ResponseJsonSchema, StreamEvent, Usage,
};
use std::sync::Arc;

/// A configured evolution model could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvolutionModelUnavailable(pub String);

impl std::fmt::Display for EvolutionModelUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "evolution model unavailable: {}", self.0)
    }
}

impl std::error::Error for EvolutionModelUnavailable {}

/// The model one evolution stage runs on.
#[derive(Clone)]
pub(crate) struct ResolvedModel {
    pub(crate) provider: Arc<dyn Provider>,
    pub(crate) model: String,
    pub(crate) settings: Settings,
    pub(crate) follows_session: bool,
}

/// Token usage of one evolution call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CallUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
}

impl QueryEngine {
    /// Resolve the model for `stage` without any fallback.
    pub(crate) fn resolve_evolution_model(
        &self,
        stage: EvolutionStage,
    ) -> Result<ResolvedModel, EvolutionModelUnavailable> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let Some(reference) = settings.evolution.stage_model(stage).cloned() else {
            let model = self.model_name();
            if model.trim().is_empty() {
                return Err(EvolutionModelUnavailable(
                    "the session has no current model".into(),
                ));
            }
            return Ok(ResolvedModel {
                provider: self.current_provider(),
                model,
                settings,
                follows_session: true,
            });
        };
        let profile = settings.providers.get(&reference.provider).ok_or_else(|| {
            EvolutionModelUnavailable(format!(
                "provider `{}` is not configured",
                reference.provider
            ))
        })?;
        if !profile.model_profiles().contains_key(&reference.model) {
            return Err(EvolutionModelUnavailable(format!(
                "model `{}` is not configured for provider `{}`",
                reference.model, reference.provider
            )));
        }
        let mut selected = settings.clone();
        selected
            .apply_discovered_model(&reference.provider, &reference.model)
            .map_err(|error| EvolutionModelUnavailable(error.to_string()))?;
        let provider = match &self.client_model_configuration {
            Some(source) => source.provider(&selected),
            None => ProviderKind::from_settings(&selected).and_then(|kind| {
                let kind = kind.ok_or_else(|| anyhow::anyhow!("missing provider transport"))?;
                ProviderFactory::new(&selected).build(kind, &reference.model)
            }),
        }
        .map_err(|error| EvolutionModelUnavailable(error.to_string()))?;
        Ok(ResolvedModel {
            provider,
            model: reference.model.clone(),
            settings: selected,
            follows_session: false,
        })
    }

    /// One structured, tool-free request with `RequestClass::Evolution`.
    /// Returns the response text and the provider-reported usage.
    pub(crate) async fn evolution_structured_call(
        &self,
        model: &ResolvedModel,
        system: &str,
        user: String,
        schema_name: &str,
        schema: serde_json::Value,
    ) -> anyhow::Result<(String, CallUsage)> {
        let structured = model.settings.model_capabilities.structured_output;
        let mut request = MessagesRequest::new(model.model.clone(), vec![Message::user_text(user)])
            .with_system(system.to_string())
            .with_tools(Vec::new())
            .with_max_tokens(4096)
            .with_debug_session_id(self.state.session_id());
        if structured {
            request =
                request.with_response_json_schema(ResponseJsonSchema::new(schema_name, schema));
        }
        let permit = crate::request_admission::acquire(
            &model.provider,
            crate::request_admission::RequestClass::Evolution,
        )
        .await?;
        let stream = model.provider.stream_messages(request)?;
        let mut stream = permit.wrap(crate::stream::default_timed_stream(stream));
        let mut text = String::new();
        let mut usage: Option<Usage> = None;
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::MessageStart { message } => {
                    if let Some(incoming) = message.usage {
                        crate::usage::merge_stream_usage(&mut usage, incoming);
                    }
                }
                StreamEvent::MessageDelta { delta } => {
                    if let Some(incoming) = delta.usage {
                        crate::usage::merge_stream_usage(&mut usage, incoming);
                    }
                }
                StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text: chunk },
                    ..
                } => text.push_str(&chunk),
                StreamEvent::MessageStop => break,
                StreamEvent::Error { error } => {
                    anyhow::bail!("evolution model call failed: {}", error.safe_summary())
                }
                _ => {}
            }
        }
        let usage = usage
            .map(|usage| CallUsage {
                input_tokens: u64::from(usage.input_tokens),
                output_tokens: u64::from(usage.output_tokens),
            })
            .unwrap_or_default();
        Ok((text, usage))
    }
}

/// Extract the first JSON object of a model reply (bare or fenced).
pub(crate) fn json_from_reply(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    serde_json::from_str(trimmed.get(start..=end)?).ok()
}
