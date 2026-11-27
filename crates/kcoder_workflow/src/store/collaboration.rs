//! Atomic initialization of an existing empty workflow draft.
use super::*;
use kcoder_types::workflow::WorkflowCollaborationPlan;
impl WorkflowStore {
    pub fn initialize_collaboration(
        &self,
        id: &str,
        expected_revision: u64,
        plan: &WorkflowCollaborationPlan,
        validate: impl FnOnce(&WorkflowDefinition) -> Result<()>,
    ) -> Result<WorkflowDefinition> {
        let original = self.read(id)?;
        ensure!(
            original.revision == expected_revision,
            "workflow_conflict: reload the original draft before applying collaboration"
        );
        let mut prepared = crate::collaboration::compile(&original, plan)?;
        validate(&prepared)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            ensure!(
                record.draft.nodes.is_empty(),
                "workflow_collaboration: existing content was retained; select an empty draft"
            );
            touch(&mut prepared)?;
            record.draft = prepared.clone();
            Ok(prepared)
        })
    }
}
