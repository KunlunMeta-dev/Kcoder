//! Retain the original task slot for native work queued during its Accepted turn.
use super::*;
use kcoder_engine::native_model_requests::NativeAuxiliaryModelRequest;

pub(in super::super) struct AuxiliaryRetention {
    token: Option<Arc<()>>,
    tasks: std::sync::Weak<Mutex<OrganizationTasks>>,
    native: Arc<NativeIntegrationContext>,
}
impl Drop for AuxiliaryRetention {
    fn drop(&mut self) {
        self.token.take();
        if let Some(tasks) = self.tasks.upgrade()
            && let Ok(mut tasks) = tasks.lock()
            && tasks.reconcile(&self.native).is_err()
        {
            tracing::warn!("Native auxiliary task reconciliation remains pending");
        }
    }
}
impl OrganizationTasks {
    pub(in super::super) fn retain_auxiliary(
        tasks: &Arc<Mutex<Self>>,
        native: &Arc<NativeIntegrationContext>,
        request: &NativeAuxiliaryModelRequest<'_>,
    ) -> Result<Arc<dyn Send + Sync>> {
        native.verify()?;
        ensure!(
            matches!(
                request.purpose(),
                NativeModelRequestPurpose::MemoryObserver | NativeModelRequestPurpose::Summary
            ),
            "ORGANIZATION_AUXILIARY_PURPOSE_INVALID"
        );
        let execution = request.execution();
        let engine = request.engine();
        let attempt = execution
            .attempt()
            .context("ORGANIZATION_MODEL_ACCEPTED_ATTEMPT_REQUIRED")?;
        ensure!(
            execution.matches_state(&engine.state)
                && engine.state.matches_current_history_attempt(Some(attempt)),
            "ORGANIZATION_MODEL_ATTEMPT_CHANGED"
        );
        let mut state = tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("ORGANIZATION_TASK_BINDING_UNAVAILABLE"))?;
        let operation = if execution.parent().is_some() {
            let child = state
                .children
                .get(execution.session_id())
                .context("ORGANIZATION_CHILD_BINDING_REQUIRED")?;
            ensure!(
                child.accepted && child.identity == *attempt && child.state.matches(&engine.state),
                "ORGANIZATION_CHILD_ACCEPTED_CHANGED"
            );
            child.root.clone()
        } else {
            format!("org-turn-{}", digest(attempt)?)
        };
        let store = actual_store(engine, attempt)?;
        accepted(&store, attempt)?;
        let token = Arc::new(());
        if state.workflows.retain(native, &operation, &token)? {
            return Ok(Arc::new(AuxiliaryRetention {
                token: Some(token),
                tasks: Arc::downgrade(tasks),
                native: native.clone(),
            }));
        }
        let root = state
            .roots
            .get_mut(&operation)
            .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
        let current = receipt(native.organization_budget_request(
            &operation,
            json!({"kind":"check","reservation_id":root.facts.slot}),
        )?)?;
        ensure!(
            !current.execution_confirmed_terminal,
            "ORGANIZATION_PARENT_TASK_NOT_ACTIVE"
        );
        root.auxiliary.retain(|work| work.strong_count() > 0);
        ensure!(
            root.auxiliary.len() < 1024,
            "ORGANIZATION_AUXILIARY_CAPACITY"
        );
        root.auxiliary.push(Arc::downgrade(&token));
        Ok(Arc::new(AuxiliaryRetention {
            token: Some(token),
            tasks: Arc::downgrade(tasks),
            native: native.clone(),
        }))
    }
}
