//! Sealed native transition facts. Only the Engine's actual-attempt adapter may construct these.
//! No renderer label, model name, DTO or error prose constructs this evidence.
use super::NativeModelRequestContext;
use kcoder_api::Provider;
use kcoder_types::{
    MessagesRequest, ModelConfigurationSummary, ProviderFailureDetails,
    integrations::core::IntegrationModelPolicyRef,
};
use std::sync::Arc;

pub struct NativeModelTransitionRequest<'a> {
    context: &'a NativeModelRequestContext,
    original_request: &'a MessagesRequest,
    candidate_request: &'a MessagesRequest,
    policy: &'a IntegrationModelPolicyRef,
    previous: &'a ModelConfigurationSummary,
    candidate: &'a ModelConfigurationSummary,
    candidate_provider: &'a Arc<dyn Provider>,
    failure: &'a ProviderFailureDetails,
    original_request_sha256: &'a str,
    candidate_request_sha256: &'a str,
}
impl NativeModelTransitionRequest<'_> {
    /// The original actual Provider call id/State/witness/parent; never reconstituted from strings.
    pub fn context(&self) -> &NativeModelRequestContext {
        self.context
    }
    pub fn original_request(&self) -> &MessagesRequest {
        self.original_request
    }
    /// The next final request produced by the native factory, after compatibility checks.
    pub fn candidate_request(&self) -> &MessagesRequest {
        self.candidate_request
    }
    pub fn policy(&self) -> &IntegrationModelPolicyRef {
        self.policy
    }
    pub fn previous(&self) -> &ModelConfigurationSummary {
        self.previous
    }
    pub fn candidate(&self) -> &ModelConfigurationSummary {
        self.candidate
    }
    pub fn candidate_provider(&self) -> &Arc<dyn Provider> {
        self.candidate_provider
    }
    pub fn failure(&self) -> &ProviderFailureDetails {
        self.failure
    }
    pub fn original_request_sha256(&self) -> &str {
        self.original_request_sha256
    }
    pub fn candidate_request_sha256(&self) -> &str {
        self.candidate_request_sha256
    }
}

use super::{NativeModelRequestError, NativeModelRequestObserver, NativeModelRequestPurpose};
use crate::QueryEngine;
use sha2::{Digest, Sha256};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
#[derive(Default)]
pub(super) struct AttemptTracker {
    current: Mutex<AttemptState>,
}
#[derive(Default)]
struct AttemptState {
    call_id: Option<String>,
    failure: Option<Arc<AttemptFailure>>,
}
pub(super) struct AttemptOrigin {
    tracker: Arc<AttemptTracker>,
    context: Arc<NativeModelRequestContext>,
    request_sha256: String,
    started: bool,
    closed: Arc<AtomicBool>,
}
struct AttemptFailure {
    context: Arc<NativeModelRequestContext>,
    request_sha256: String,
    failure: ProviderFailureDetails,
    closed: Arc<AtomicBool>,
    consumed: AtomicBool,
}
impl AttemptTracker {
    pub(super) fn begin(
        self: &Arc<Self>,
        context: Arc<NativeModelRequestContext>,
        request: &MessagesRequest,
    ) -> Result<Option<AttemptOrigin>, NativeModelRequestError> {
        if context.purpose() != NativeModelRequestPurpose::Main {
            return Ok(None);
        }
        let mut state = self
            .current
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?;
        state.call_id = Some(context.call_id().into());
        state.failure = None;
        Ok(Some(AttemptOrigin {
            tracker: self.clone(),
            context,
            request_sha256: request_digest(request)
                .map_err(|_| NativeModelRequestError::Unavailable)?,
            started: false,
            closed: Arc::new(AtomicBool::new(false)),
        }))
    }
}
impl AttemptOrigin {
    pub(super) fn event(&mut self, event: &kcoder_types::StreamEvent) {
        if !matches!(event, kcoder_types::StreamEvent::Ping) {
            self.started = true;
        }
    }
    pub(super) fn failed(&self, error: &kcoder_api::ApiErrorKind) {
        let failure = crate::retry_policy::provider_failure_details(error, self.started);
        if self.started || !failure.retryable || !failure.resume_safe {
            return;
        }
        let Ok(mut state) = self.tracker.current.lock() else {
            return;
        };
        if state.call_id.as_deref() != Some(self.context.call_id()) {
            return;
        }
        state.failure = Some(Arc::new(AttemptFailure {
            context: self.context.clone(),
            request_sha256: self.request_sha256.clone(),
            failure,
            closed: self.closed.clone(),
            consumed: AtomicBool::new(false),
        }));
    }
    pub(super) fn closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}
pub(crate) struct NativeTransitionCandidate<'a> {
    pub request: &'a MessagesRequest,
    pub policy: &'a IntegrationModelPolicyRef,
    pub configuration: &'a ModelConfigurationSummary,
    pub provider: &'a Arc<dyn Provider>,
}
impl super::binding::ModelRequestBinding {
    /// Called only after the original stream/lease has closed, at an Engine
    /// retry boundary. A caller-supplied failure or session id is insufficient.
    pub(crate) fn authorize_candidate_transition(
        &self,
        engine: &QueryEngine,
        original: &MessagesRequest,
        candidate: NativeTransitionCandidate<'_>,
    ) -> Result<Arc<dyn NativeModelRequestObserver>, NativeModelRequestError> {
        let selection = engine
            .native_auto_resolution_for_transition()
            .ok_or(NativeModelRequestError::Denied)?;
        crate::integrations::core::validate_integration_auto_model(engine, selection)
            .map_err(|_| NativeModelRequestError::Denied)?;
        let kcoder_types::integrations::core::IntegrationNullable::Value(policy) =
            &selection.policy_ref
        else {
            return Err(NativeModelRequestError::Denied);
        };
        if policy != candidate.policy {
            return Err(NativeModelRequestError::Denied);
        }
        let proof = self
            .attempts
            .current
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .failure
            .clone()
            .ok_or(NativeModelRequestError::Denied)?;
        if !proof.closed.load(Ordering::SeqCst)
            || !proof.context.execution().matches_current_engine(engine)
            || proof.request_sha256
                != request_digest(original).map_err(|_| NativeModelRequestError::Unavailable)?
        {
            return Err(NativeModelRequestError::Denied);
        }
        let previous = proof
            .context
            .configuration()
            .ok_or(NativeModelRequestError::Unavailable)?;
        if previous.model_id != original.model
            || candidate.configuration.model_id != candidate.request.model
        {
            return Err(NativeModelRequestError::Denied);
        }
        // Preserve input/history/schema/cache semantics. Only the explicit next
        // model identity may differ in the common request at this boundary.
        let mut expected = original.clone();
        expected.model = candidate.request.model.clone();
        let candidate_sha =
            request_digest(candidate.request).map_err(|_| NativeModelRequestError::Unavailable)?;
        if request_digest(&expected).map_err(|_| NativeModelRequestError::Unavailable)?
            != candidate_sha
            || proof.consumed.swap(true, Ordering::SeqCst)
        {
            return Err(NativeModelRequestError::Denied);
        }
        let request = NativeModelTransitionRequest {
            context: &proof.context,
            original_request: original,
            candidate_request: candidate.request,
            policy: candidate.policy,
            previous,
            candidate: candidate.configuration,
            candidate_provider: candidate.provider,
            failure: &proof.failure,
            original_request_sha256: &proof.request_sha256,
            candidate_request_sha256: &candidate_sha,
        };
        self.observer.authorize_transition(&request)
    }
}
fn request_digest(request: &MessagesRequest) -> Result<String, serde_json::Error> {
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut digest = HashWriter(Sha256::new());
    serde_json::to_writer(&mut digest, request)?;
    let schema=request.response_json_schema.as_ref().map(|schema|serde_json::json!({"name":schema.name,"description":schema.description,"schema":schema.schema,"strict":schema.strict}));
    serde_json::to_writer(
        &mut digest,
        &serde_json::json!({"responseJsonSchema":schema,"reasoningEffort":request.reasoning_effort.as_ref().map(|value|value.as_str()),"recoveryDisableReasoning":request.recovery_disable_reasoning,"pathFirstTools":request.path_first_tools,"trajectoryAgentDepth":request.trajectory_agent_depth}),
    )?;
    Ok(format!("{:x}", digest.0.finalize()))
}

impl QueryEngine {
    /// Prepare a value-owned model change only after the real failed attempt
    /// closes and its original native observer reauthorizes the candidate.
    /// No actor, run, tool registry, history or reservation is recreated here.
    pub(crate) fn try_native_auto_model_transition(
        &self,
        original: &MessagesRequest,
    ) -> Result<Option<Self>, NativeModelRequestError> {
        if self.is_cancelled() {
            return Err(NativeModelRequestError::Denied);
        }
        let Some(selection) = self.native_auto_resolution_for_transition() else {
            return Ok(None);
        };
        let kcoder_types::integrations::core::IntegrationNullable::Value(policy) =
            &selection.policy_ref
        else {
            return Ok(None);
        };
        let binding = self
            .validated_model_request_binding()
            .map_err(|_| NativeModelRequestError::Denied)?
            .ok_or(NativeModelRequestError::Denied)?;
        // Do not even resolve credentials for a candidate without a closed,
        // unconsumed actual attempt on this same State/turn/request.
        {
            let state = binding
                .attempts
                .current
                .lock()
                .map_err(|_| NativeModelRequestError::Unavailable)?;
            let Some(proof) = &state.failure else {
                return Ok(None);
            };
            if !proof.closed.load(Ordering::SeqCst)
                || proof.consumed.load(Ordering::SeqCst)
                || !proof.context.execution().matches_current_engine(self)
                || proof.request_sha256
                    != request_digest(original).map_err(|_| NativeModelRequestError::Unavailable)?
            {
                return Ok(None);
            }
        }
        let requirements =
            crate::integrations::core::model_health::transition_requirements(original)
                .map_err(|_| NativeModelRequestError::Denied)?;
        let request = kcoder_types::integrations::core::IntegrationModelResolutionRequest {
            selection:
                kcoder_types::integrations::core::IntegrationModelSelectionIntent::AutoPolicy {
                    id: policy.id.clone(),
                    version: policy.version.clone(),
                },
            requirements,
        };
        let mut resolution =
            crate::integrations::core::resolve_integration_model_selection(self, &request)
                .map_err(|_| NativeModelRequestError::Unavailable)?;
        if resolution.model.provider_id == selection.model.provider_id
            && resolution.model.model_id == selection.model.model_id
            && resolution.model.revision == selection.model.revision
        {
            return Ok(None);
        }
        let mut candidate = self
            .clone()
            .with_owned_native_model_resolution(&resolution)
            .map_err(|_| NativeModelRequestError::Denied)?;
        // The factory already detached mutable model Arcs. Keep the original
        // request's task-owned output limit, then rebuild its true provider.
        crate::recover_write_lock(&candidate.settings, "settings").max_tokens =
            Some(original.max_tokens);
        let settings = crate::recover_read_lock(&candidate.settings, "settings").clone();
        let provider = match &candidate.client_model_configuration {
            Some(source) => source.provider(&settings),
            None => (|| {
                let kind = kcoder_api::ProviderKind::from_settings(&settings)?
                    .ok_or_else(|| anyhow::anyhow!("MODEL_TRANSITION_PROVIDER_UNAVAILABLE"))?;
                kcoder_api::ProviderFactory::new(&settings).build(kind, &settings.model)
            })(),
        }
        .map_err(|_| NativeModelRequestError::Unavailable)?;
        candidate.provider = Arc::new(std::sync::RwLock::new(provider.clone()));
        resolution.model = candidate
            .active_model_configuration_summary()
            .map_err(|_| NativeModelRequestError::Unavailable)?;
        let mut candidate_request = original.clone();
        candidate_request.model = resolution.model.model_id.clone();
        crate::integrations::core::model_health::validate_transition_request(
            &candidate,
            &resolution,
            &candidate_request,
        )
        .map_err(|_| NativeModelRequestError::Denied)?;
        let observer = binding.authorize_candidate_transition(
            self,
            original,
            NativeTransitionCandidate {
                request: &candidate_request,
                policy,
                configuration: &resolution.model,
                provider: &provider,
            },
        )?;
        candidate = candidate
            .with_reauthorized_model_request_observer(observer, &binding)
            .map_err(|_| NativeModelRequestError::Denied)?
            .with_native_auto_model_health(&resolution)
            .map_err(|_| NativeModelRequestError::Denied)?;
        Ok(Some(candidate))
    }
}
