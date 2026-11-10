use super::*;
use kcoder_types::integrations::core::IntegrationScope;

impl OfficeStore {
    pub fn read_draft(&self, id: &str) -> Result<Option<OfficeAssistantDraft>> {
        valid_id(id)?;
        let _lock = self.lock(false)?;
        Ok(self.load()?.drafts.get(id).cloned())
    }
    pub fn list_drafts(&self) -> Result<Vec<OfficeAssistantDraft>> {
        let _lock = self.lock(false)?;
        Ok(self.load()?.drafts.values().cloned().collect())
    }
    pub fn save_draft(
        &self,
        operation: &str,
        definition: OfficeAssistantDefinition,
        expected: Option<u64>,
        now: u64,
    ) -> Result<OfficeAssistantDraft> {
        definition.validate()?;
        if definition.scope == OfficeAssistantScope::Organization {
            ensure!(
                self.owner
                    .organization_id
                    .as_ref()
                    .and_then(|v| v.as_ref())
                    .is_some(),
                "OFFICE_ORGANIZATION_REQUIRED"
            );
        }
        let input = (definition.clone(), expected);
        self.mutate(operation, "assistant.saveDraft", &input, |state| {
            let current = state.drafts.get(&definition.id);
            match current {
                Some(current) => ensure!(
                    expected == Some(current.revision),
                    "OFFICE_REVISION_CONFLICT"
                ),
                None => {
                    ensure!(
                        expected.is_none() || expected == Some(0),
                        "OFFICE_REVISION_CONFLICT"
                    );
                    ensure!(state.drafts.len() < MAX_DRAFTS, "OFFICE_DRAFT_CAPACITY");
                }
            }
            let draft = OfficeAssistantDraft {
                owner: self.owner.clone(),
                revision: current
                    .map(|draft| {
                        draft
                            .revision
                            .checked_add(1)
                            .context("OFFICE_REVISION_OVERFLOW")
                    })
                    .transpose()?
                    .unwrap_or(1),
                definition,
                updated_at_ms: now,
            };
            state
                .drafts
                .insert(draft.definition.id.clone(), draft.clone());
            Ok(draft)
        })
    }
    pub fn save_version(
        &self,
        operation: &str,
        id: &str,
        version: &str,
        expected: u64,
        now: u64,
    ) -> Result<OfficeAssistantVersion> {
        valid_id(id)?;
        valid_id(version)?;
        self.mutate(
            operation,
            "assistant.saveVersion",
            &(id, version, expected),
            |state| {
                let draft = state.drafts.get(id).context("OFFICE_DRAFT_NOT_FOUND")?;
                ensure!(draft.revision == expected, "OFFICE_REVISION_CONFLICT");
                let key = version_key(id, version);
                let definition_sha256 = digest(&serde_json::to_vec(&draft.definition)?);
                if let Some(previous) = state.versions.get(&key) {
                    ensure!(
                        previous.definition_sha256 == definition_sha256,
                        "OFFICE_VERSION_IMMUTABLE"
                    );
                    return Ok(previous.clone());
                }
                ensure!(
                    state.versions.len() < MAX_VERSIONS,
                    "OFFICE_VERSION_CAPACITY"
                );
                let saved = OfficeAssistantVersion {
                    owner: self.owner.clone(),
                    version: version.into(),
                    definition: draft.definition.clone(),
                    definition_sha256,
                    created_at_ms: now,
                    archived: false,
                };
                state.versions.insert(key, saved.clone());
                Ok(saved)
            },
        )
    }
    pub fn read_version(&self, id: &str, version: &str) -> Result<Option<OfficeAssistantVersion>> {
        valid_id(id)?;
        valid_id(version)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .versions
            .get(&version_key(id, version))
            .cloned())
    }
    pub fn list_versions(&self, id: &str) -> Result<Vec<OfficeAssistantVersion>> {
        valid_id(id)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .versions
            .into_values()
            .filter(|version| version.definition.id == id)
            .collect())
    }
    pub fn archive_version(
        &self,
        operation: &str,
        id: &str,
        version: &str,
    ) -> Result<OfficeAssistantVersion> {
        valid_id(id)?;
        valid_id(version)?;
        self.mutate(operation, "assistant.archive", &(id, version), |state| {
            let saved = state
                .versions
                .get_mut(&version_key(id, version))
                .context("OFFICE_VERSION_NOT_FOUND")?;
            saved.archived = true;
            Ok(saved.clone())
        })
    }
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
        assistant: OfficeAssistantVersion,
        inputs: Value,
        now: u64,
    ) -> Result<OfficeAssistantAdoption> {
        assistant.definition.validate()?;
        ensure!(
            IntegrationOwner::from(&scope) == self.owner
                && (assistant.owner == self.owner
                    || (assistant.definition.scope == OfficeAssistantScope::Organization
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

impl OfficeStore {
    pub fn save_adoption_origin(
        &self,
        operation: &str,
        adoption: &str,
        publication: OfficeResourceRef,
    ) -> Result<OfficeResourceRef> {
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
