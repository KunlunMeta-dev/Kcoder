use super::*;

impl ResourceStore {
    pub fn read_draft(&self, id: &str) -> Result<Option<AgentDefinitionDraft>> {
        valid_id(id)?;
        let _lock = self.lock(false)?;
        Ok(self.load()?.drafts.get(id).cloned())
    }
    pub fn list_drafts(&self) -> Result<Vec<AgentDefinitionDraft>> {
        let _lock = self.lock(false)?;
        Ok(self.load()?.drafts.values().cloned().collect())
    }
    pub fn save_draft(
        &self,
        operation: &str,
        definition: AgentDefinition,
        expected: Option<u64>,
        now: u64,
    ) -> Result<AgentDefinitionDraft> {
        definition.validate()?;
        if definition.scope == AgentDefinitionScope::Organization {
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
            let draft = AgentDefinitionDraft {
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
    ) -> Result<AgentDefinitionVersion> {
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
                let saved = AgentDefinitionVersion {
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
    pub fn read_version(&self, id: &str, version: &str) -> Result<Option<AgentDefinitionVersion>> {
        valid_id(id)?;
        valid_id(version)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .versions
            .get(&version_key(id, version))
            .cloned())
    }
    pub fn list_versions(&self, id: &str) -> Result<Vec<AgentDefinitionVersion>> {
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
    ) -> Result<AgentDefinitionVersion> {
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
}
