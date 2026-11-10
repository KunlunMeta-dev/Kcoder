use super::*;
use crate::{QueryEngine, recover_read_lock};
use kcoder_api::Provider;
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary};
use std::sync::{Arc, Mutex};

pub(crate) struct ModelRequestBinding {
    pub(super) observer: Arc<dyn NativeModelRequestObserver>,
    pub(super) observer_chain: Vec<Arc<dyn NativeModelRequestObserver>>,
    pub(super) mandatory: Vec<Arc<dyn NativeModelRequestObserver>>,
    actor: Arc<QueryEngine>,
    cache: Mutex<Vec<Cached>>,
    inherited_origin: Option<kcoder_state::AppStateIdentity>,
    pub(super) attempts: Arc<super::transition::AttemptTracker>,
}
struct Cached {
    inner: Arc<dyn Provider>,
    wrapped: Arc<dyn Provider>,
    purpose: NativeModelRequestPurpose,
    configuration: String,
}
impl ModelRequestBinding {
    pub(crate) fn observe_child_scheduled(
        &self,
        request: &crate::integrations::core::NativeScheduledChildRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.observer.observe_child_scheduled(request)
    }
    pub(crate) fn observe_execution_terminal(&self) -> Result<(), NativeModelRequestError> {
        self.observer.observe_execution_terminal()
    }
    pub(crate) fn has_mandatory_guard(&self) -> bool {
        !self.mandatory.is_empty()
    }
    pub(crate) fn prepare_native_child(
        &self,
        request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.observer.prepare_child(request)
    }
    pub(crate) fn observe_native_child_accepted(
        &self,
        request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.observer.observe_child_accepted(request)
    }
    fn new(engine: &QueryEngine, observer: Arc<dyn NativeModelRequestObserver>) -> Self {
        let mut actor = engine.clone();
        actor.model_request_binding = None;
        Self {
            observer_chain: vec![observer.clone()],
            mandatory: vec![],
            observer,
            actor: Arc::new(actor),
            cache: Mutex::new(vec![]),
            inherited_origin: None,
            attempts: Arc::default(),
        }
    }
    pub(super) fn with_mandatory_guard(
        &self,
        engine: &QueryEngine,
        guard: Arc<dyn NativeModelRequestObserver>,
    ) -> Self {
        let mut next = Self::new(engine, self.observer.clone());
        next.observer_chain = self.observer_chain.clone();
        next.mandatory = self.mandatory.clone();
        next.mandatory.push(guard);
        next.inherited_origin = self.inherited_origin.clone();
        next.attempts = self.attempts.clone();
        next
    }
    pub(super) fn with_additional(
        &self,
        engine: &QueryEngine,
        observer: Arc<dyn NativeModelRequestObserver>,
        additional: Arc<dyn NativeModelRequestObserver>,
    ) -> Self {
        let mut next = Self::new(engine, observer);
        next.observer_chain = self.observer_chain.clone();
        next.observer_chain.push(additional);
        next.mandatory = self.mandatory.clone();
        next.inherited_origin = self.inherited_origin.clone();
        next.attempts = self.attempts.clone();
        next
    }
    fn permits_actor(&self, engine: &QueryEngine) -> bool {
        self.inherited_origin.as_ref().is_none_or(|origin| {
            origin.matches(&engine.state)
                || engine
                    .subagent_runtime_control
                    .as_ref()
                    .as_ref()
                    .is_some_and(|parent| origin.matches(&parent.parent_state))
        })
    }
    pub(crate) fn wrap(
        &self,
        inner: Arc<dyn Provider>,
        purpose: NativeModelRequestPurpose,
        configuration: Option<ModelConfigurationSummary>,
    ) -> Arc<dyn Provider> {
        let inner = admission_identity(&inner);
        let key = serde_json::to_string(&configuration).unwrap_or_default();
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(found) = cache.iter().find(|cached| {
                Arc::ptr_eq(&cached.inner, &inner)
                    && cached.purpose == purpose
                    && cached.configuration == key
            }) {
                return found.wrapped.clone();
            }
            let wrapped = super::provider::ObservedProvider {
                inner: inner.clone(),
                observer: self.observer.clone(),
                actor: self.actor.clone(),
                purpose,
                configuration,
                valid_owner: true,
                attempts: self.attempts.clone(),
                mandatory: self.mandatory.clone(),
            }
            .install();
            if cache.len() >= 16 {
                cache.remove(0);
            }
            cache.push(Cached {
                inner,
                wrapped: wrapped.clone(),
                purpose,
                configuration: key,
            });
            wrapped
        } else {
            // A poisoned cache must not bypass the installed Native observer.
            super::provider::ObservedProvider {
                inner,
                observer: self.observer.clone(),
                actor: self.actor.clone(),
                purpose,
                configuration,
                valid_owner: true,
                attempts: self.attempts.clone(),
                mandatory: self.mandatory.clone(),
            }
            .install()
        }
    }
}
impl QueryEngine {
    /// Observe an installed meter by object identity; this is not a budget grant.
    pub fn has_native_model_request_observer(
        &self,
        expected: &Arc<dyn NativeModelRequestObserver>,
    ) -> bool {
        self.model_request_binding.as_ref().is_some_and(|binding| {
            binding
                .observer_chain
                .iter()
                .any(|current| Arc::ptr_eq(current, expected))
        })
    }

    /// Same-context replacements retain every previously installed observer.
    pub fn retains_native_model_observers_from(&self, previous: &Self) -> bool {
        previous.model_request_binding.as_ref().is_none_or(|old| {
            old.observer_chain
                .iter()
                .all(|observer| self.has_native_model_request_observer(observer))
                && old
                    .mandatory
                    .iter()
                    .all(|observer| self.has_native_model_request_observer(observer))
        })
    }

    /// Notify Native meters only after the host committed the original terminal.
    /// The observer still verifies actual State receipts; a call is not a grant.
    pub fn observe_native_execution_terminal(&self) -> Result<(), NativeModelRequestError> {
        let binding = self
            .validated_model_request_binding()
            .map_err(|_| NativeModelRequestError::Unavailable)?;
        if let Some(binding) = binding {
            binding.observer.observe_execution_terminal()?;
        }
        Ok(())
    }
    pub(super) fn with_reauthorized_model_request_observer(
        mut self,
        observer: Arc<dyn NativeModelRequestObserver>,
        original: &ModelRequestBinding,
    ) -> anyhow::Result<Self> {
        let mut next = ModelRequestBinding::new(&self, observer);
        // The sealed transition has already reauthorized the whole composed observer.
        // Retain host-wide guards for any later source replacement without adding them twice.
        next.mandatory = original.mandatory.clone();
        next.inherited_origin = original.inherited_origin.clone();
        self.model_request_binding = Some(Arc::new(next));
        Ok(self)
    }
    pub fn with_native_model_request_observer(
        mut self,
        observer: Arc<dyn NativeModelRequestObserver>,
    ) -> anyhow::Result<Self> {
        if let Some(existing) = &self.model_request_binding
            && existing
                .actor
                .native_tool_execution_witness()
                .matches_current_engine(&self)
            && Arc::ptr_eq(&existing.observer, &observer)
        {
            return Ok(self);
        }
        let mandatory = self
            .model_request_binding
            .as_ref()
            .map(|binding| binding.mandatory.clone())
            .unwrap_or_default();
        let mut binding = ModelRequestBinding::new(&self, observer.clone());
        for guard in &mandatory {
            if !Arc::ptr_eq(guard, &observer) {
                binding.observer = super::additive::intersect(binding.observer, guard.clone());
                binding.observer_chain.push(guard.clone());
            }
        }
        binding.mandatory = mandatory;
        if !binding.mandatory.is_empty()
            && let Some(original) = &self.model_request_binding
        {
            binding.inherited_origin = original.inherited_origin.clone();
            binding.attempts = original.attempts.clone();
        }
        self.model_request_binding = Some(Arc::new(binding));
        Ok(self)
    }
    /// The actual child constructor calls this only after its State and native
    /// parent runtime control are installed. A sibling clone is not authority.
    pub fn inherit_native_model_requests_from(mut self, parent: &Self) -> anyhow::Result<Self> {
        if let Some(binding) = &parent.model_request_binding {
            let mut inherited = ModelRequestBinding::new(&self, binding.observer.clone());
            inherited.observer_chain = binding.observer_chain.clone();
            inherited.mandatory = binding.mandatory.clone();
            inherited.inherited_origin = Some(parent.state.inspection_identity());
            self.model_request_binding = Some(Arc::new(inherited));
            for guard in &binding.mandatory {
                self.background_jobs.register_terminal_observer(guard)?;
            }
            if let Some(resolution) = parent.native_auto_resolution_for_transition() {
                self = self.with_client_model_configuration_from(parent);
                // Rebind only the parent's already approved restrictions to the
                // real child State. Its observer still proves native admission.
                self = self.with_native_auto_model_health(resolution)?;
            }
        }
        Ok(self)
    }
    pub(crate) fn with_inherited_provider_model_observer(
        mut self,
        inherited: super::provider::InheritedModelObserver,
    ) -> anyhow::Result<Self> {
        let mut binding = ModelRequestBinding::new(&self, inherited.observer);
        binding.inherited_origin = Some(inherited.origin);
        binding.mandatory = inherited.mandatory;
        for guard in &binding.mandatory {
            self.background_jobs.register_terminal_observer(guard)?;
        }
        self.model_request_binding = Some(Arc::new(binding));
        Ok(self)
    }
    pub(crate) fn validated_model_request_binding(
        &self,
    ) -> anyhow::Result<Option<Arc<ModelRequestBinding>>> {
        if let Some(binding) = &self.model_request_binding {
            anyhow::ensure!(
                binding.permits_actor(self)
                    && binding
                        .actor
                        .native_tool_execution_witness()
                        .matches_current_engine(self),
                "Native model actor binding is unavailable"
            );
        }
        Ok(self.model_request_binding.clone())
    }
    pub(crate) fn current_raw_provider(&self) -> Arc<dyn Provider> {
        admission_identity(&recover_read_lock(&self.provider, "provider").clone())
    }
    pub(crate) fn observe_model_provider(
        &self,
        provider: Arc<dyn Provider>,
        purpose: NativeModelRequestPurpose,
        configuration: Option<ModelConfigurationSummary>,
    ) -> Arc<dyn Provider> {
        match &self.model_request_binding {
            Some(binding)
                if !binding.permits_actor(self)
                    || !binding
                        .actor
                        .native_tool_execution_witness()
                        .matches_current_engine(self) =>
            {
                super::provider::ObservedProvider {
                    inner: provider,
                    observer: binding.observer.clone(),
                    actor: binding.actor.clone(),
                    purpose,
                    configuration,
                    valid_owner: false,
                    attempts: binding.attempts.clone(),
                    mandatory: binding.mandatory.clone(),
                }
                .install()
            }
            Some(binding) => binding.wrap(provider, purpose, configuration),
            None => provider,
        }
    }
    pub(crate) fn observer_main_configuration(&self) -> Option<ModelConfigurationSummary> {
        crate::provider_runtime::model_configuration_summary(
            &recover_read_lock(&self.settings, "settings"),
            ModelConfigurationBoundary::SessionSnapshot,
        )
        .ok()
    }
}
