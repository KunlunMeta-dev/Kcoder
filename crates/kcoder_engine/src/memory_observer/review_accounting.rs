use super::*;
use crate::integrations::knowledge::{
    CuratedMemoryObserverSink, ObserverExtractionOutcome, ObserverExtractionPermit,
    ObserverExtractionReceipt, ObserverUsageEvidence,
};

/// Drop preserves partial/unknown attempt accounting when an owned worker is aborted.
pub(super) struct ObserverAttempt<'a> {
    engine: &'a QueryEngine,
    model: String,
    sink: Option<Arc<dyn CuratedMemoryObserverSink>>,
    permit: Option<ObserverExtractionPermit>,
    receipt: ObserverExtractionReceipt,
    finished: bool,
    stream_completed: bool,
    final_usage_observed: bool,
}
impl<'a> ObserverAttempt<'a> {
    pub(super) fn new(
        engine: &'a QueryEngine,
        model: &str,
        sink: Option<Arc<dyn CuratedMemoryObserverSink>>,
        permit: Option<ObserverExtractionPermit>,
    ) -> Self {
        Self {
            engine,
            model: model.into(),
            receipt: ObserverExtractionReceipt {
                operation_id: permit.as_ref().map_or_else(
                    || uuid::Uuid::new_v4().to_string(),
                    |p| p.origin.operation_id.clone(),
                ),
                provider_started: false,
                requested_model_id: Some(model.into()),
                actual_model_id: None,
                usage: None,
                usage_evidence: ObserverUsageEvidence::NotStarted,
                started_at_ms: current_time_millis(),
                finished_at_ms: current_time_millis(),
                outcome: ObserverExtractionOutcome::Abandoned,
            },
            sink,
            permit,
            finished: false,
            stream_completed: false,
            final_usage_observed: false,
        }
    }
    pub(super) fn started(&mut self) {
        self.receipt.provider_started = true;
    }
    pub(super) fn observe(&mut self, event: &StreamEvent) {
        let update = match event {
            StreamEvent::MessageStart { message } => {
                if !message.model.is_empty() && message.model.len() <= 256 {
                    self.receipt.actual_model_id = Some(message.model.clone());
                }
                message.usage.as_ref()
            }
            StreamEvent::MessageDelta { delta } => {
                if delta.usage.is_some() {
                    self.final_usage_observed = true;
                }
                delta.usage.as_ref()
            }
            _ => None,
        };
        if let Some(update) = update {
            crate::usage::merge_stream_usage(&mut self.receipt.usage, update.clone());
        }
    }
    pub(super) fn completed_stream(&mut self) {
        self.stream_completed = true;
    }
    pub(super) fn total_observed(&self) -> Option<u64> {
        self.receipt
            .usage
            .as_ref()
            .map(UsageAccumulator::usage_total)
    }
    pub(super) fn finish(
        &mut self,
        outcome: ObserverExtractionOutcome,
    ) -> anyhow::Result<ObserverExtractionReceipt> {
        self.record(outcome)?;
        Ok(self.receipt.clone())
    }
    fn record(&mut self, outcome: ObserverExtractionOutcome) -> anyhow::Result<()> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        self.receipt.outcome = outcome;
        self.receipt.usage_evidence = if !self.receipt.provider_started {
            ObserverUsageEvidence::NotStarted
        } else if self.receipt.usage.is_none() {
            ObserverUsageEvidence::Unreported
        } else if self.stream_completed && self.final_usage_observed {
            ObserverUsageEvidence::Reported
        } else {
            ObserverUsageEvidence::Partial
        };
        self.receipt.finished_at_ms = current_time_millis();
        if self.receipt.provider_started {
            self.engine
                .state
                .record_token_usage(&self.model, self.receipt.usage.as_ref());
            if let Some(usage) = &self.receipt.usage {
                recover_write_lock(&self.engine.cumulative_usage, "cumulative_usage").add(usage);
            }
        }
        // The sink accounts the original native task, never whichever Goal happens to be current.
        if let (Some(sink), Some(permit)) = (&self.sink, &self.permit) {
            sink.record_attempt(permit, &self.receipt)?;
        }
        Ok(())
    }
}
impl Drop for ObserverAttempt<'_> {
    fn drop(&mut self) {
        if !self.finished && self.record(ObserverExtractionOutcome::Abandoned).is_err() {
            warn!("memory observer attempt accounting is unconfirmed");
        }
    }
}
