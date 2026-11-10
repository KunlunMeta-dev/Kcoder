//! Bounded workspace observations. Health never authorizes a model or replays a request.
mod provider;
mod request_guard;
mod usage;
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_api::{ApiErrorKind, Provider};
use kcoder_types::{
    ModelConfigurationSummary, ProviderFailureCategory, ProviderFailureDetails,
    integrations::core::*,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_RECORDS: usize = 256;
const MAX_COOLDOWN: Duration = Duration::from_secs(30);
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    provider: String,
    model: String,
    revision: String,
}
impl Key {
    fn from_model(model: &ModelConfigurationSummary) -> Self {
        Self {
            provider: model.provider_id.clone().unwrap_or_default(),
            model: model.model_id.clone(),
            revision: model.revision.clone(),
        }
    }
}
struct Entry {
    observed: IntegrationModelHealthObservation,
    until: Option<Instant>,
    probe: Option<String>,
    sequence: u64,
    usage: IntegrationModelUsageObservation,
}
#[derive(Default)]
struct Data {
    entries: BTreeMap<Key, Entry>,
    sequence: u64,
}
#[derive(Default)]
pub(crate) struct ModelHealthTracker {
    data: Mutex<Data>,
}
#[derive(Clone)]
pub(crate) struct NativeAutoModelHealthBinding {
    key: Key,
    origin: kcoder_state::AppStateIdentity,
    resolution: IntegrationModelResolutionResult,
}
impl ModelHealthTracker {
    fn wrap(
        self: &Arc<Self>,
        inner: Arc<dyn Provider>,
        model: ModelConfigurationSummary,
        gated: bool,
        request_guard: Option<request_guard::AutoRequestGuard>,
    ) -> Arc<dyn Provider> {
        provider::tracked(self.clone(), inner, model, gated, request_guard)
    }
    pub(crate) fn observe(
        &self,
        model: &ModelConfigurationSummary,
    ) -> IntegrationModelHealthObservation {
        self.data
            .lock()
            .ok()
            .and_then(|data| {
                data.entries.get(&Key::from_model(model)).map(|entry| {
                    let mut value = entry.observed.clone();
                    if entry.probe.is_some() {
                        value.state = IntegrationModelHealthState::Probing
                    } else if entry.until.is_some_and(|until| until <= Instant::now()) {
                        value.state = IntegrationModelHealthState::Unknown
                    }
                    value
                })
            })
            .unwrap_or_else(|| unknown(model))
    }
    pub(crate) fn routing(&self, model: &ModelConfigurationSummary) -> Result<()> {
        let data = self
            .data
            .lock()
            .map_err(|_| anyhow::anyhow!("MODEL_HEALTH_UNAVAILABLE"))?;
        if let Some(entry) = data.entries.get(&Key::from_model(model)) {
            ensure!(entry.probe.is_none(), "MODEL_AUTO_PROBE_BUSY");
            if entry.until.is_some_and(|until| until > Instant::now()) {
                ensure!(
                    !blocked(&entry.observed),
                    "MODEL_AUTO_CONFIGURATION_BLOCKED"
                );
                anyhow::bail!("MODEL_AUTO_CANDIDATE_COOLING_DOWN");
            }
        }
        Ok(())
    }
    fn begin(
        self: &Arc<Self>,
        model: &ModelConfigurationSummary,
        gated: bool,
    ) -> Result<Observation> {
        let key = Key::from_model(model);
        let mut data = self
            .data
            .lock()
            .map_err(|_| anyhow::anyhow!("MODEL_HEALTH_UNAVAILABLE"))?;
        let mut probe = None;
        if gated && let Some(entry) = data.entries.get_mut(&key) {
            ensure!(entry.probe.is_none(), "MODEL_AUTO_PROBE_BUSY");
            if let Some(until) = entry.until {
                ensure!(until <= Instant::now(), "MODEL_AUTO_CANDIDATE_COOLING_DOWN");
                let id = uuid::Uuid::new_v4().to_string();
                entry.probe = Some(id.clone());
                probe = Some(id);
            }
        }
        Ok(Observation {
            tracker: self.clone(),
            key,
            model: model.clone(),
            probe,
            started: false,
            settled: false,
            usage: usage::ReportedUsage::default(),
        })
    }
    fn record(
        &self,
        key: &Key,
        model: &ModelConfigurationSummary,
        probe: &Option<String>,
        outcome: Outcome,
    ) {
        let Outcome {
            failure,
            started,
            interrupted,
            usage,
        } = outcome;
        let Ok(mut data) = self.data.lock() else {
            return;
        };
        if let Some(id) = probe
            && data.entries.get(key).and_then(|entry| entry.probe.as_ref()) != Some(id)
        {
            return;
        }
        if data.entries.len() >= MAX_RECORDS && !data.entries.contains_key(key) {
            let oldest = data
                .entries
                .iter()
                .filter(|(_, entry)| entry.probe.is_none())
                .min_by_key(|(_, entry)| entry.sequence)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                data.entries.remove(&oldest);
            } else {
                return;
            }
        }
        let retained_probe = if probe.is_none() {
            data.entries.get(key).and_then(|entry| entry.probe.clone())
        } else {
            None
        };
        data.sequence = data.sequence.saturating_add(1);
        let sequence = data.sequence;
        let prior = data
            .entries
            .get(key)
            .map(|entry| entry.observed.consecutive_failures)
            .unwrap_or(0);
        let now = chrono::Utc::now();
        let mut observed = unknown(model);
        observed.last_observed_at = Some(now.to_rfc3339());
        observed.response_started = started;
        let until = if let Some(failure) = failure {
            observed.consecutive_failures = prior.saturating_add(1);
            let delay = Duration::from_millis(
                1000u64.saturating_mul(1u64 << observed.consecutive_failures.min(5)),
            )
            .max(Duration::from_millis(failure.retry_after_ms.unwrap_or(0)))
            .min(MAX_COOLDOWN);
            observed.state = if failure.retryable {
                IntegrationModelHealthState::CoolingDown
            } else {
                IntegrationModelHealthState::NeedsConfiguration
            };
            observed.cooldown_until =
                Some((now + chrono::Duration::from_std(delay).unwrap_or_default()).to_rfc3339());
            observed.failure = Some(failure);
            Some(Instant::now() + delay)
        } else if interrupted {
            observed.state = IntegrationModelHealthState::Interrupted;
            observed.consecutive_failures = prior;
            observed.cooldown_until = Some((now + chrono::Duration::seconds(2)).to_rfc3339());
            Some(Instant::now() + Duration::from_secs(2))
        } else {
            observed.state = IntegrationModelHealthState::Healthy;
            None
        };
        data.entries.insert(
            key.clone(),
            Entry {
                observed,
                until,
                probe: retained_probe,
                sequence,
                usage,
            },
        );
    }
}
fn unknown(model: &ModelConfigurationSummary) -> IntegrationModelHealthObservation {
    IntegrationModelHealthObservation {
        provider: model.provider_id.clone().unwrap_or_default(),
        model: model.model_id.clone(),
        configuration_revision: model.revision.clone(),
        state: IntegrationModelHealthState::Unknown,
        consecutive_failures: 0,
        last_observed_at: None,
        cooldown_until: None,
        failure: None,
        response_started: false,
    }
}
fn blocked(observed: &IntegrationModelHealthObservation) -> bool {
    observed.failure.as_ref().is_some_and(|failure| {
        matches!(
            failure.category,
            ProviderFailureCategory::AuthenticationError
                | ProviderFailureCategory::Forbidden
                | ProviderFailureCategory::QuotaExceeded
                | ProviderFailureCategory::ModelOrRoute
        )
    })
}
fn native_admission_error(error: &ApiErrorKind) -> bool {
    matches!(error, ApiErrorKind::Api { error_type, .. } if matches!(error_type.as_str(),
        "native_model_budget_denied" | "native_model_budget_unavailable" | "native_model_budget_deadline"))
}

struct Observation {
    tracker: Arc<ModelHealthTracker>,
    key: Key,
    model: ModelConfigurationSummary,
    probe: Option<String>,
    started: bool,
    settled: bool,
    usage: usage::ReportedUsage,
}
struct Outcome {
    failure: Option<ProviderFailureDetails>,
    started: bool,
    interrupted: bool,
    usage: IntegrationModelUsageObservation,
}
impl Observation {
    fn success(&mut self) {
        self.usage.saw_stop = true;
        self.tracker.record(
            &self.key,
            &self.model,
            &self.probe,
            Outcome {
                failure: None,
                started: self.started,
                interrupted: false,
                usage: self.usage.snapshot(&self.model),
            },
        );
        self.probe = None;
        self.settled = true;
    }
    fn not_dispatched(&mut self) {
        if let Some(probe) = &self.probe
            && let Ok(mut data) = self.tracker.data.lock()
            && let Some(entry) = data.entries.get_mut(&self.key)
            && entry.probe.as_ref() == Some(probe)
        {
            entry.probe = None;
        }
        self.settled = true;
    }
    fn interrupted(&mut self) {
        self.tracker.record(
            &self.key,
            &self.model,
            &self.probe,
            Outcome {
                failure: None,
                started: self.started,
                interrupted: true,
                usage: self.usage.snapshot(&self.model),
            },
        );
        self.settled = true;
    }
    fn error(&mut self, error: &ApiErrorKind) {
        self.usage.failed = true;
        if native_admission_error(error) {
            self.interrupted();
            return;
        }
        let failure = crate::retry_policy::provider_failure_details(error, self.started);
        self.tracker.record(
            &self.key,
            &self.model,
            &self.probe,
            Outcome {
                failure: Some(failure),
                started: self.started,
                interrupted: false,
                usage: self.usage.snapshot(&self.model),
            },
        );
        self.settled = true;
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        if !self.settled {
            self.tracker.record(
                &self.key,
                &self.model,
                &self.probe,
                Outcome {
                    failure: None,
                    started: self.started,
                    interrupted: true,
                    usage: self.usage.snapshot(&self.model),
                },
            )
        }
    }
}
impl QueryEngine {
    pub(crate) fn native_auto_resolution_for_transition(
        &self,
    ) -> Option<&IntegrationModelResolutionResult> {
        self.native_auto_model_health
            .as_ref()
            .filter(|binding| binding.origin.matches(&self.state))
            .map(|binding| &binding.resolution)
    }
    pub fn integration_model_health(
        &self,
        model: &ModelConfigurationSummary,
    ) -> IntegrationModelHealthObservation {
        self.model_health.observe(model)
    }
    /// Adds only a health restriction after the native installer's authorization.
    pub fn with_native_auto_model_health(
        mut self,
        resolution: &IntegrationModelResolutionResult,
    ) -> Result<Self> {
        if resolution.selection_kind == IntegrationModelSelectionKind::AutoPolicy {
            super::model_policies::validate_integration_auto_model(&self, resolution)?;
            self.native_auto_model_health = Some(Arc::new(NativeAutoModelHealthBinding {
                key: Key::from_model(&resolution.model),
                origin: self.state.inspection_identity(),
                resolution: resolution.clone(),
            }));
        }
        Ok(self)
    }
    pub(crate) fn observe_health_provider(&self, provider: Arc<dyn Provider>) -> Arc<dyn Provider> {
        let settings = crate::recover_read_lock(&self.settings, "settings");
        if settings.integrations.core.model_policies.is_empty()
            && self.native_auto_model_health.is_none()
        {
            return provider;
        }
        drop(settings);
        let Some(model) = self.observer_main_configuration() else {
            return provider;
        };
        let binding = self.native_auto_model_health.as_ref().filter(|binding| {
            binding.origin.matches(&self.state)
                && binding.key.provider == model.provider_id.as_deref().unwrap_or_default()
                && binding.key.model == model.model_id
        });
        let guard = binding.map(|binding| request_guard::AutoRequestGuard {
            engine: self.clone(),
            resolution: binding.resolution.clone(),
        });
        self.model_health
            .wrap(provider, model, binding.is_some(), guard)
    }
}
pub(crate) use provider::admission_identity;
#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod request_guard_tests;

#[cfg(test)]
mod usage_tests;

pub(crate) use request_guard::transition_requirements;
pub(crate) fn validate_transition_request(
    engine: &QueryEngine,
    resolution: &IntegrationModelResolutionResult,
    request: &kcoder_types::MessagesRequest,
) -> anyhow::Result<()> {
    request_guard::AutoRequestGuard {
        engine: engine.clone(),
        resolution: resolution.clone(),
    }
    .validate(request)
}
