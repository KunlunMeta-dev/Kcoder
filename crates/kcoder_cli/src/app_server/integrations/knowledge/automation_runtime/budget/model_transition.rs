//! Same-run model changes require the original persisted AUTO and sealed native failure.
use super::*;
use kcoder_engine::integrations::core::{
    resolve_integration_model_selection, validate_integration_auto_model,
};
use kcoder_types::ProviderFailureCategory;

impl AutomationBudgetObserver {
    pub(super) fn authorize_actual_transition(
        &self,
        transition: &NativeModelTransitionRequest<'_>,
    ) -> Result<Arc<dyn NativeModelRequestObserver>> {
        let IntegrationModelSelectionIntent::AutoPolicy { id, version } =
            self.shared.source.effective_model_selection()
        else {
            anyhow::bail!("AUTOMATION_MODEL_TRANSITION_DENIED");
        };
        ensure!(
            transition.policy().id == id && transition.policy().version == version,
            "AUTOMATION_MODEL_POLICY_CHANGED"
        );
        let context = transition.context();
        ensure!(
            context.purpose() == NativeModelRequestPurpose::Main
                && context
                    .configuration()
                    .is_some_and(|actual| { same_model_configuration(actual, &self.model) })
                && same_model_configuration(transition.previous(), &self.model)
                && self
                    .provider
                    .as_ref()
                    .is_none_or(|provider| { Arc::ptr_eq(provider, context.provider()) })
                && transition.original_request().model == self.model.model_id
                && transition.candidate_request().max_tokens
                    == transition.original_request().max_tokens,
            "AUTOMATION_MODEL_TRANSITION_ORIGIN_CHANGED"
        );
        let failure = transition.failure();
        ensure!(
            failure.retryable
                && failure.resume_safe
                && matches!(
                    failure.category,
                    ProviderFailureCategory::RateLimit
                        | ProviderFailureCategory::NetworkError
                        | ProviderFailureCategory::TimeoutError
                        | ProviderFailureCategory::ProviderError
                ),
            "AUTOMATION_MODEL_TRANSITION_DENIED"
        );
        self.shared.full_check_source()?;
        self.shared.service.verify(self.shared.source.native())?;
        let actor = self.shared.register_actor(context)?;
        let facts = self.shared.runtime_facts()?;
        ensure!(
            Instant::now() < self.shared.deadline(&facts)?,
            "AUTOMATION_RUNTIME_DEADLINE"
        );

        // Re-resolve through the original current catalog and factory. Candidate
        // labels or a previously resolved policy never grant current authority.
        let original = self.shared.original_model_engine()?;
        let next_request = transition.candidate_request();
        let output = effective_output_limit(transition.candidate(), next_request)?;
        let mut resolution = resolve_integration_model_selection(
            &original,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::AutoPolicy { id, version },
                requirements: IntegrationModelRequirements {
                    tools: true,
                    structured_output: next_request.response_json_schema.is_some(),
                    input_tokens: Some(reservation_input(next_request)?),
                    output_tokens: Some(u64::from(output)),
                    ..Default::default()
                },
            },
        )?;
        ensure!(
            resolution.model.provider_id == transition.candidate().provider_id
                && resolution.model.model_id == transition.candidate().model_id,
            "AUTOMATION_MODEL_CANDIDATE_CHANGED"
        );
        let owned = original.with_owned_native_model_resolution(&resolution)?;
        owned
            .settings
            .write()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_MODEL_UNAVAILABLE"))?
            .max_tokens = Some(next_request.max_tokens);
        resolution.model = owned.active_model_configuration_summary()?;
        ensure!(
            same_model_configuration(&resolution.model, transition.candidate()),
            "AUTOMATION_MODEL_CANDIDATE_CHANGED"
        );
        validate_integration_auto_model(&owned, &resolution)?;

        let ledger = self.shared.service.accounting_store();
        let old_id = format!(
            "automation-call-{}",
            digest(&(self.shared.root_operation()?, context.call_id()))?
        );
        let old = ledger
            .read_reservation(&old_id)?
            .context("AUTOMATION_BUDGET_CALL_MISSING")?;
        ensure!(
            old.unit == BudgetUnit::ModelCall
                && old.phase == BudgetPhase::Dispatched
                && !old.execution_confirmed_terminal
                && old.task.root_operation_id == self.shared.root_operation()?
                && old.task.root_task.as_ref() == Some(&facts.task)
                && old.task.parent_reservation_id.as_deref() == Some(&self.slot)
                && old.task.actor_attempt_id == format!("background-{}", digest(&actor)?)
                && old.coverage != BudgetUsageCoverage::Complete,
            "AUTOMATION_BUDGET_TRANSITION_ORIGIN_CHANGED"
        );
        let current = CurrentBudgetPolicy::capture(
            &ledger,
            self.principal()?,
            self.shared.root_operation()?,
            old.policy_refs.clone(),
            now()?,
        )?;
        self.shared.full_check_source()?;
        current.check(&ledger, now()?)?;
        ensure!(
            Instant::now() < self.shared.deadline(&facts)?,
            "AUTOMATION_RUNTIME_DEADLINE"
        );

        // The sealed adapter proves the actual failed stream has closed before
        // any output. End its execution slot while retaining every unknown
        // charge. The next actual call still reserves atomically in this same
        // ledger, subject, task slot, policy set and original deadline.
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            old.operation_id.clone(),
            Some(facts.task),
            old.task.actor_attempt_id.clone(),
            format!("native-sealed-failure-{}", context.call_id()),
            digest(&(
                context.call_id(),
                transition.original_request_sha256(),
                transition.candidate_request_sha256(),
                transition.policy(),
                failure,
                facts.receipt_sha256,
            ))?,
            BudgetTerminalKind::Failed,
        )?;
        let settled = ledger.record_usage(
            &old_id,
            old.revision,
            "native-sealed-model-transition",
            &NativeBudgetUsage {
                coverage: old.coverage,
                known: old.known_usage.clone(),
            },
            Some(&terminal),
            now()?,
        )?;
        ensure!(
            settled.charged == old.charged && settled.coverage == old.coverage,
            "AUTOMATION_BUDGET_UNKNOWN_CHARGE_CHANGED"
        );
        Ok(Arc::new(Self {
            shared: self.shared.clone(),
            slot: self.slot.clone(),
            model: resolution.model,
            provider: Some(transition.candidate_provider().clone()),
            #[cfg(test)]
            observed_calls: self.observed_calls.clone(),
        }))
    }
}
