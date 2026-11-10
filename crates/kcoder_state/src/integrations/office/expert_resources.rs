//! Immutable per-attempt skill inventories and rebuildable target-owned read-only caches.
use super::*;
use std::path::PathBuf;

#[cfg(test)]
mod tests;

pub trait OfficeExpertResourceSnapshotExt {
    fn validate(&self) -> Result<()>;
    fn validate_definition(&self, definition: &OfficeAssistantDefinition) -> Result<()>;
    fn sha256(&self) -> Result<String>;
}

impl OfficeExpertResourceSnapshotExt for OfficeExpertResourceSnapshot {
    fn validate(&self) -> Result<()> {
        valid_id(&self.expert_id)?;
        ensure!(self.skills.len() <= 64, "OFFICE_STORAGE_LIMIT");
        let mut total_bytes = 0u64;
        for (slug, files) in &self.skills {
            ensure!(
                !slug.is_empty()
                    && slug.len() <= 128
                    && slug != "."
                    && slug != ".."
                    && slug
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
                "OFFICE_INVALID_INPUT"
            );
            super::experts::validate_expert_files(files)?;
            ensure!(
                files.iter().any(|file| file.path == "SKILL.md"),
                "OFFICE_CONTENT_MISSING"
            );
            ensure!(
                files.iter().all(|file| file.bytes <= 256 * 1024),
                "OFFICE_STORAGE_LIMIT"
            );
            for file in files {
                total_bytes = total_bytes
                    .checked_add(file.bytes)
                    .context("OFFICE_STORAGE_LIMIT")?;
            }
        }
        ensure!(total_bytes <= 64 * 1024 * 1024, "OFFICE_STORAGE_LIMIT");
        Ok(())
    }

    fn validate_definition(&self, definition: &OfficeAssistantDefinition) -> Result<()> {
        self.validate()?;
        ensure!(
            self.expert_id == definition.id
                && self.skills.len()
                    == definition
                        .skills
                        .iter()
                        .filter(|skill| skill.enabled)
                        .count(),
            "AGENT_RESOURCE_DEFINITION_MISMATCH"
        );
        for skill in definition.skills.iter().filter(|skill| skill.enabled) {
            ensure!(
                self.skills
                    .get(&skill.slug)
                    .is_some_and(|files| files.iter().any(|entry| entry.path == "SKILL.md"
                        && entry.sha256 == digest(skill.content.as_bytes())
                        && entry.bytes == skill.content.len() as u64)),
                "AGENT_RESOURCE_CONTENT_CHANGED"
            );
        }
        Ok(())
    }

    fn sha256(&self) -> Result<String> {
        self.validate()?;
        Ok(digest(&serde_json::to_vec(self)?))
    }
}

impl OfficeStore {
    /// Capture the actual enabled files once; later retries use this inventory, not a new draft.
    pub fn capture_expert_resources(
        &self,
        definition: &OfficeAssistantDefinition,
        draft_revision: Option<u64>,
    ) -> Result<OfficeExpertResourceSnapshot> {
        definition.validate()?;
        let _lock = self.lock(true)?;
        let state = self.load()?;
        if let Some(revision) = draft_revision {
            ensure!(
                state
                    .drafts
                    .get(&definition.id)
                    .is_some_and(|draft| draft.revision == revision
                        && draft.definition.skills == definition.skills
                        && draft.definition.instructions == definition.instructions
                        && draft.definition.allowed_tools == definition.allowed_tools),
                "OFFICE_REVISION_CONFLICT"
            );
        }
        let package = state.expert_packages.get(&definition.id);
        let mut skills = BTreeMap::new();
        for skill in definition.skills.iter().filter(|skill| skill.enabled) {
            let prefix = format!("skills/{}/", skill.slug);
            let mut files = package
                .into_iter()
                .flat_map(|package| &package.files)
                .filter_map(|file| {
                    file.path
                        .strip_prefix(&prefix)
                        .map(|path| OfficeExpertFile {
                            path: path.into(),
                            sha256: file.sha256.clone(),
                            bytes: file.bytes,
                        })
                })
                .filter(|file| file.path != "SKILL.md")
                .collect::<Vec<_>>();
            let sha256 = digest(skill.content.as_bytes());
            self.directory.atomic_replace(
                OsStr::new(&format!("expert-{sha256}.blob")),
                skill.content.as_bytes(),
            )?;
            files.push(OfficeExpertFile {
                path: "SKILL.md".into(),
                sha256,
                bytes: skill.content.len() as u64,
            });
            files.sort_by(|a, b| a.path.cmp(&b.path));
            skills.insert(skill.slug.clone(), files);
        }
        let snapshot = OfficeExpertResourceSnapshot {
            owner: self.owner.clone(),
            expert_id: definition.id.clone(),
            skills,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// Publish only files from the pinned inventory. No package hooks or scripts are executed.
    pub fn materialize_expert_resources(
        &self,
        snapshot: &OfficeExpertResourceSnapshot,
        data_path: &Path,
    ) -> Result<PathBuf> {
        snapshot.validate()?;
        ensure!(snapshot.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let _lock = self.lock(false)?;
        let observed = PrivateDirectory::open_existing(data_path)?;
        ensure!(
            observed.directory_identity()? == self.directory.directory_identity()?,
            "OFFICE_CACHE_DIRECTORY_CHANGED"
        );
        let digest = snapshot.sha256()?;
        let cache = self
            .directory
            .open_child(OsStr::new("expert-resources"), true)?;
        let root = cache.open_child(OsStr::new(&digest), true)?;
        let skills = root.open_child(OsStr::new("skills"), true)?;
        for (slug, files) in &snapshot.skills {
            let directory = skills.open_child(OsStr::new(slug), true)?;
            for entry in files {
                let bytes = self
                    .read_optional(&format!("expert-{}.blob", entry.sha256), 256 * 1024)?
                    .context("OFFICE_CONTENT_MISSING")?;
                ensure!(
                    bytes.len() as u64 == entry.bytes && super::digest(&bytes) == entry.sha256,
                    "OFFICE_CONTENT_CORRUPT"
                );
                let mut parent = directory.duplicate_handle()?;
                let mut parts = entry.path.split('/').peekable();
                while let Some(part) = parts.next() {
                    if parts.peek().is_some() {
                        parent = parent.open_child(OsStr::new(part), true)?;
                    } else {
                        let name = OsStr::new(part);
                        match parent.open_regular_file(name) {
                            Ok(mut file) => {
                                let mut existing = Vec::new();
                                (&mut file)
                                    .take(256 * 1024 + 1)
                                    .read_to_end(&mut existing)?;
                                ensure!(existing == bytes, "OFFICE_RESOURCE_CACHE_CORRUPT");
                            }
                            Err(error)
                                if error.downcast_ref::<std::io::Error>().is_some_and(
                                    |error| error.kind() == std::io::ErrorKind::NotFound,
                                ) =>
                            {
                                parent.atomic_replace(name, &bytes)?;
                            }
                            Err(error) => return Err(error),
                        }
                        let file = parent.open_regular_file(name)?;
                        let mut permissions = file.metadata()?.permissions();
                        permissions.set_readonly(true);
                        file.set_permissions(permissions)?;
                    }
                }
            }
        }
        ensure!(
            PrivateDirectory::open_existing(data_path)?.directory_identity()?
                == self.directory.directory_identity()?,
            "OFFICE_CACHE_DIRECTORY_CHANGED"
        );
        Ok(data_path
            .join("expert-resources")
            .join(digest)
            .join("skills"))
    }
}
