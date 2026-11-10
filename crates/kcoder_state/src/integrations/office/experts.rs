use super::*;
use kcoder_types::integrations::core::IntegrationRevisionRef;

pub(super) fn validate_package(package: &OfficeExpertPackage) -> Result<()> {
    ensure!(
        matches!(package.source.as_str(), "skillhub" | "octop-builtin")
            && !package.slug.is_empty()
            && package.slug.len() <= 200
            && package.package_sha256.len() == 64
            && package
                .package_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "OFFICE_INVALID_INPUT"
    );
    ensure!(
        package.files.len() <= 2000 && package.skill_slugs.len() <= 64,
        "OFFICE_STORAGE_LIMIT"
    );
    validate_expert_files(&package.files)
}

pub(super) fn validate_expert_files(files: &[OfficeExpertFile]) -> Result<()> {
    ensure!(files.len() <= 2000, "OFFICE_STORAGE_LIMIT");
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for file in files {
        ensure!(
            !file.path.is_empty()
                && file.path.len() <= 1024
                && !file.path.contains('\\')
                && !file.path.starts_with('/')
                && file
                    .path
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && !file.path.chars().any(char::is_control)
                && file.sha256.len() == 64
                && file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                && names.insert(&file.path),
            "OFFICE_INVALID_INPUT"
        );
        total = total
            .checked_add(file.bytes)
            .context("OFFICE_STORAGE_LIMIT")?;
    }
    ensure!(total <= 64 * 1024 * 1024, "OFFICE_STORAGE_LIMIT");
    Ok(())
}

impl OfficeStore {
    /// Commit the draft and complete asset inventory together, after all downloads.
    /// Downloaded blobs stay inert; selected snapshot caches do not execute scripts or hooks.
    pub fn install_expert(
        &self,
        operation: &str,
        definition: OfficeAssistantDefinition,
        package: OfficeExpertPackage,
        files: &[(String, Vec<u8>)],
        now: u64,
    ) -> Result<OfficeAssistantDraft> {
        definition.validate()?;
        validate_package(&package)?;
        ensure!(
            definition.scope == OfficeAssistantScope::Personal
                && files.len() == package.files.len(),
            "OFFICE_INVALID_INPUT"
        );
        for (entry, (name, bytes)) in package.files.iter().zip(files) {
            ensure!(
                entry.path == *name
                    && entry.bytes == bytes.len() as u64
                    && entry.sha256 == digest(bytes),
                "OFFICE_CONTENT_CORRUPT"
            );
        }
        let input = (&definition, &package);
        self.mutate(operation, "assistant.installExpert", &input, |state| {
            ensure!(
                !state.drafts.contains_key(&definition.id)
                    && !state.expert_packages.contains_key(&definition.id),
                "OFFICE_REVISION_CONFLICT"
            );
            ensure!(state.drafts.len() < MAX_DRAFTS, "OFFICE_DRAFT_CAPACITY");
            ensure!(
                state.expert_packages.len() < MAX_VERSIONS,
                "OFFICE_STORAGE_LIMIT"
            );
            let retained: u64 = state
                .expert_packages
                .values()
                .flat_map(|package| &package.files)
                .map(|file| file.bytes)
                .sum();
            ensure!(
                retained.saturating_add(package.files.iter().map(|file| file.bytes).sum::<u64>())
                    <= 256 * 1024 * 1024,
                "OFFICE_STORAGE_LIMIT"
            );
            for (entry, (_, bytes)) in package.files.iter().zip(files) {
                self.directory
                    .atomic_replace(OsStr::new(&format!("expert-{}.blob", entry.sha256)), bytes)?;
            }
            let draft = OfficeAssistantDraft {
                owner: self.owner.clone(),
                revision: 1,
                definition: definition.clone(),
                updated_at_ms: now,
            };
            state
                .expert_packages
                .insert(definition.id.clone(), package.clone());
            state.drafts.insert(definition.id.clone(), draft.clone());
            Ok(draft)
        })
    }

    pub fn read_expert_package(&self, id: &str) -> Result<Option<OfficeExpertPackage>> {
        valid_id(id)?;
        let _lock = self.lock(false)?;
        let package = self.load()?.expert_packages.get(id).cloned();
        if let Some(package) = &package {
            validate_package(package)?;
        }
        Ok(package)
    }

    pub fn copy_expert(
        &self,
        operation: &str,
        source: &IntegrationRevisionRef,
        definition: OfficeAssistantDefinition,
        now: u64,
    ) -> Result<OfficeAssistantDraft> {
        definition.validate()?;
        source.validate()?;
        let expected: u64 = source.revision.parse()?;
        ensure!(
            definition.id != source.id && definition.scope == OfficeAssistantScope::Personal,
            "OFFICE_INVALID_INPUT"
        );
        self.mutate(
            operation,
            "assistant.copyExpert",
            &(source, &definition),
            |state| {
                let original = state
                    .drafts
                    .get(&source.id)
                    .context("OFFICE_DRAFT_NOT_FOUND")?;
                ensure!(
                    original.revision == expected && !state.drafts.contains_key(&definition.id),
                    "OFFICE_REVISION_CONFLICT"
                );
                ensure!(
                    original.definition.scope != OfficeAssistantScope::Organization,
                    "OFFICE_INVALID_INPUT"
                );
                ensure!(
                    state.drafts.len() < MAX_DRAFTS && state.expert_packages.len() < MAX_VERSIONS,
                    "OFFICE_STORAGE_LIMIT"
                );
                if let Some(package) = state.expert_packages.get(&source.id).cloned() {
                    state.expert_packages.insert(definition.id.clone(), package);
                }
                let draft = OfficeAssistantDraft {
                    owner: self.owner.clone(),
                    revision: 1,
                    definition: definition.clone(),
                    updated_at_ms: now,
                };
                state.drafts.insert(definition.id.clone(), draft.clone());
                Ok(draft)
            },
        )
    }

    pub fn read_expert_file(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        valid_id(id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let package = state
            .expert_packages
            .get(id)
            .context("OFFICE_CONTENT_MISSING")?;
        validate_package(package)?;
        let entry = package
            .files
            .iter()
            .find(|file| file.path == path)
            .context("OFFICE_CONTENT_MISSING")?;
        ensure!(entry.bytes <= 256 * 1024, "OFFICE_STORAGE_LIMIT");
        let bytes = self
            .read_optional(&format!("expert-{}.blob", entry.sha256), 256 * 1024)?
            .context("OFFICE_CONTENT_MISSING")?;
        ensure!(
            bytes.len() as u64 == entry.bytes && digest(&bytes) == entry.sha256,
            "OFFICE_CONTENT_CORRUPT"
        );
        Ok(bytes)
    }

    /// Remove the editable entry and archive its versions; adopted tasks remain intact.
    pub fn delete_assistant_draft(
        &self,
        operation: &str,
        id: &str,
        expected: u64,
    ) -> Result<Value> {
        valid_id(id)?;
        self.mutate(
            operation,
            "assistant.deleteDraft",
            &(id, expected),
            |state| {
                let draft = state.drafts.get(id).context("OFFICE_DRAFT_NOT_FOUND")?;
                ensure!(draft.revision == expected, "OFFICE_REVISION_CONFLICT");
                ensure!(
                    draft.definition.scope != OfficeAssistantScope::Organization,
                    "OFFICE_INVALID_INPUT"
                );
                state.drafts.remove(id);
                for version in state
                    .versions
                    .values_mut()
                    .filter(|version| version.definition.id == id)
                {
                    version.archived = true;
                }
                Ok(serde_json::json!({"id": id, "deleted": true, "adoptedCopiesDeleted": false}))
            },
        )
    }
}
