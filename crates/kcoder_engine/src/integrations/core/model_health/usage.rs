//! Report only normalized values actually observed in provider events.
use super::*;
use kcoder_types::{StreamEvent, Usage};
#[derive(Default)]
pub(super) struct ReportedUsage {
    cumulative: Option<Usage>,
    pub(super) saw_stop: bool,
    pub(super) saw_eof: bool,
    pub(super) failed: bool,
}
impl ReportedUsage {
    pub(super) fn record(&mut self, event: &StreamEvent) {
        let usage = match event {
            StreamEvent::MessageStart { message } => message.usage.as_ref(),
            StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
            _ => None,
        };
        if let Some(usage) = usage {
            if let Some(current) = &mut self.cumulative {
                current.merge_stream_update(usage)
            } else {
                self.cumulative = Some(usage.clone())
            }
        }
    }
    pub(super) fn snapshot(
        &self,
        model: &ModelConfigurationSummary,
    ) -> IntegrationModelUsageObservation {
        let actual = self.cumulative.as_ref();
        let reported = actual.is_some_and(|usage| {
            usage.input_tokens > 0
                || usage.output_tokens > 0
                || usage.total_tokens.is_some()
                || usage.cache_creation_input_tokens.is_some()
                || usage.cache_read_input_tokens.is_some()
        });
        IntegrationModelUsageObservation {
            provider: model.provider_id.clone().unwrap_or_default(),
            model: model.model_id.clone(),
            configuration_revision: model.revision.clone(),
            last_observed_at: reported.then(|| chrono::Utc::now().to_rfc3339()),
            // Mandatory normalized zeros may be adapter defaults. Do not
            // invent explicit upstream fields that the shared type cannot prove.
            reported_input_tokens: actual
                .and_then(|usage| (usage.input_tokens > 0).then_some(usage.input_tokens)),
            reported_output_tokens: actual
                .and_then(|usage| (usage.output_tokens > 0).then_some(usage.output_tokens)),
            reported_total_tokens: actual.and_then(|usage| usage.total_tokens),
            reported_cache_read_input_tokens: actual
                .and_then(|usage| usage.cache_read_input_tokens),
            reported_cache_creation_input_tokens: actual
                .and_then(|usage| usage.cache_creation_input_tokens),
            // Normalized mandatory counters have lost raw field presence.
            // Terminal events and positive values alone do not restore it.
            complete: false,
        }
    }
}
impl ModelHealthTracker {
    pub(crate) fn observe_usage(
        &self,
        model: &ModelConfigurationSummary,
    ) -> IntegrationModelUsageObservation {
        self.data
            .lock()
            .ok()
            .and_then(|data| {
                data.entries
                    .get(&Key::from_model(model))
                    .map(|entry| entry.usage.clone())
            })
            .unwrap_or_else(|| ReportedUsage::default().snapshot(model))
    }
}
impl Observation {
    pub(super) fn eof(&mut self) {
        if self.usage.saw_eof {
            return;
        }
        self.usage.saw_eof = true;
        if self.usage.saw_stop && !self.usage.failed {
            self.success()
        } else if !self.settled {
            self.interrupted()
        }
    }
}
impl QueryEngine {
    pub fn integration_model_usage(
        &self,
        model: &ModelConfigurationSummary,
    ) -> IntegrationModelUsageObservation {
        self.model_health.observe_usage(model)
    }
}
