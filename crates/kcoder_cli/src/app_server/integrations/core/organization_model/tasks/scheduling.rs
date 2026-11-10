//! Capture queued children before the parent tool can release its Accepted turn.
use super::*;
impl OrganizationTasks {
    pub(in super::super) fn schedule(
        &mut self,
        native: &NativeIntegrationContext,
        request: &NativeScheduledChildRequest<'_>,
    ) -> Result<()> {
        native.verify()?;
        if request.parent_execution().attempt().is_none() {
            return self.workflows.schedule(native, request);
        }
        let parent = request
            .parent_execution()
            .attempt()
            .context("ORGANIZATION_CHILD_ORIGINAL_PARENT_REQUIRED")?;
        let operation = if let Some(child) = self.children.get(&request.parent().session_id()) {
            ensure!(
                child.accepted
                    && child.identity == *parent
                    && child.state.matches(&request.parent().state),
                "ORGANIZATION_CHILD_PARENT_CHANGED"
            );
            child.root.clone()
        } else {
            format!("org-turn-{}", digest(parent)?)
        };
        let store = actual_store(request.parent(), parent)?;
        let record = accepted(&store, parent)?;
        let accepted_sha256 = digest(&record)?;
        ensure!(
            !self
                .roots
                .iter()
                .any(|(id, root)| id != &operation
                    && root.scheduled.contains_key(&request.run().run_id)),
            "ORGANIZATION_SCHEDULED_RUN_CONFLICT"
        );
        let count: usize = self.roots.values().map(|root| root.scheduled.len()).sum();
        let root = self
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
        if let Some(original) = root.scheduled.get(&request.run().run_id) {
            ensure!(
                original.parent == *parent
                    && original.accepted_sha256 == accepted_sha256
                    && original.run == *request.run()
                    && original
                        .parent_state
                        .inspection_lifecycle_identity()
                        .matches(&request.parent().state),
                "ORGANIZATION_SCHEDULED_RUN_CONFLICT"
            );
            return Ok(());
        }
        ensure!(count < 1024, "ORGANIZATION_CHILD_CAPACITY");
        root.scheduled.insert(
            request.run().run_id.clone(),
            Scheduled {
                parent: parent.clone(),
                accepted_sha256,
                parent_state: request.parent().state.clone(),
                run: request.run().clone(),
            },
        );
        Ok(())
    }
}
