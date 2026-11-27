use super::*;
use kcoder_types::integrations::core::IntegrationScope;
impl ResourceStore {
    /// The Engine validates inputs and live authority before storing a frozen adoption.
    pub fn adopt(
        &self,
        operation: &str,
        scope: IntegrationScope,
        id: &str,
        version: &str,
        inputs: Value,
        now: u64,
    ) -> Result<OfficeAssistantAdoption> {
        ensure!(
            IntegrationOwner::from(&scope) == self.owner,
            "OFFICE_OWNER_MISMATCH"
        );
        ensure!(
            serde_json::to_vec(&inputs)?.len() <= 128 * 1024,
            "OFFICE_INPUT_TOO_LARGE"
        );
        self.mutate(
            operation,
            "assistant.adopt",
            &(id, version, &inputs),
            |state| {
                let assistant = state
                    .versions
                    .get(&version_key(id, version))
                    .context("OFFICE_VERSION_NOT_FOUND")?
                    .clone();
                ensure!(!assistant.archived, "OFFICE_VERSION_ARCHIVED");
                let adoption = OfficeAssistantAdoption {
                    operation_id: operation.into(),
                    scope,
                    assistant,
                    inputs: inputs.clone(),
                    created_at_ms: now,
                    native_thread_id: None,
                    native_turn_id: None,
                };
                state.adoptions.insert(operation.into(), adoption.clone());
                Ok(adoption)
            },
        )
    }
    pub fn adoption(&self, operation: &str) -> Result<Option<OfficeAssistantAdoption>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        Ok(self.load()?.adoptions.get(operation).cloned())
    }
    /// Save a trusted built-in or imported fixed version without creating a mutable draft.
    pub fn adopt_snapshot(
        &self,
        operation: &str,
        scope: IntegrationScope,
        assistant: AgentDefinitionVersion,
        inputs: Value,
        now: u64,
    ) -> Result<OfficeAssistantAdoption> {
        assistant.definition.validate()?;
        ensure!(
            IntegrationOwner::from(&scope) == self.owner
                && (assistant.owner == self.owner
                    || (assistant.definition.scope == AgentDefinitionScope::Organization
                        && self
                            .owner
                            .organization_id
                            .as_ref()
                            .and_then(|id| id.as_ref())
                            .is_some()
                        && assistant.owner.organization_id == self.owner.organization_id)),
            "OFFICE_OWNER_MISMATCH"
        );
        ensure!(
            !assistant.archived
                && assistant.definition_sha256
                    == digest(&serde_json::to_vec(&assistant.definition)?),
            "OFFICE_VERSION_CORRUPT"
        );
        ensure!(
            serde_json::to_vec(&inputs)?.len() <= 128 * 1024,
            "OFFICE_INPUT_TOO_LARGE"
        );
        let intent = (assistant.clone(), inputs.clone());
        self.mutate(operation, "assistant.adoptSnapshot", &intent, |state| {
            let adoption = OfficeAssistantAdoption {
                operation_id: operation.into(),
                scope,
                assistant,
                inputs,
                created_at_ms: now,
                native_thread_id: None,
                native_turn_id: None,
            };
            state.adoptions.insert(operation.into(), adoption.clone());
            Ok(adoption)
        })
    }
    pub fn attach_native_task(
        &self,
        operation: &str,
        adoption_operation: &str,
        thread: &str,
        turn: Option<&str>,
    ) -> Result<OfficeAssistantAdoption> {
        valid_id(thread)?;
        if let Some(turn) = turn {
            valid_id(turn)?;
        }
        self.mutate(
            operation,
            "assistant.attachNativeTask",
            &(adoption_operation, thread, turn),
            |state| {
                let adoption = state
                    .adoptions
                    .get_mut(adoption_operation)
                    .context("OFFICE_ADOPTION_NOT_FOUND")?;
                ensure!(
                    adoption
                        .native_thread_id
                        .as_deref()
                        .is_none_or(|id| id == thread),
                    "OFFICE_NATIVE_TASK_CONFLICT"
                );
                if let (Some(old), Some(new)) = (adoption.native_turn_id.as_deref(), turn) {
                    ensure!(old == new, "OFFICE_NATIVE_TASK_CONFLICT");
                }
                adoption.native_thread_id = Some(thread.into());
                adoption.native_turn_id = turn.map(str::to_owned);
                Ok(adoption.clone())
            },
        )
    }
}

impl ResourceStore {
    pub fn save_adoption_origin(
        &self,
        operation: &str,
        adoption: &str,
        publication: AgentResourceRef,
    ) -> Result<AgentResourceRef> {
        publication.validate()?;
        ensure!(publication.kind == "publication", "OFFICE_INVALID_INPUT");
        self.mutate(
            operation,
            "assistant.saveAdoptionOrigin",
            &(adoption, &publication),
            |state| {
                ensure!(
                    state.adoptions.contains_key(adoption),
                    "OFFICE_ADOPTION_NOT_FOUND"
                );
                Ok(publication.clone())
            },
        )
    }
}
