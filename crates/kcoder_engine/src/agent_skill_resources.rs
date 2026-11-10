//! Attach immutable skill files to the original task registry without changing its working directory.
use super::*;
use kcoder_state::integrations::office::{
    OfficeExpertResourceSnapshot, OfficeExpertResourceSnapshotExt,
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::RwLock};

#[cfg(test)]
#[path = "agent_skill_resources/tests.rs"]
mod tests;

pub(crate) struct AgentSkillResources {
    pub snapshot: OfficeExpertResourceSnapshot,
    pub root: PathBuf,
    pub inline_only: bool,
    pub approved_loads: Vec<kcoder_tools::SelectedExpertSkillLoad>,
}

impl QueryEngine {
    pub fn agent_resource_snapshot(&self) -> Option<&OfficeExpertResourceSnapshot> {
        self.agent_skill_resources
            .as_ref()
            .map(|resources| &resources.snapshot)
    }

    pub(crate) fn clear_agent_skill_resources(&mut self) {
        if self.agent_skill_resources.take().is_none() {
            return;
        }
        let mut registry = crate::recover_read_lock(&self.skill_registry, "skill_registry").clone();
        let runtime_names = registry.runtime_skill_names().clone();
        registry.clear_runtime_expert_skills();
        self.skill_registry = Arc::new(RwLock::new(registry));
        let mut active = crate::recover_read_lock(&self.active_skills, "active_skills").clone();
        active.retain(|name| !runtime_names.contains(name));
        self.active_skills = Arc::new(RwLock::new(active));
        self.sandbox = Arc::new(
            self.sandbox
                .as_ref()
                .clone()
                .with_resource_readonly_paths(Vec::new()),
        );
    }

    /// The Native caller materializes the owner-bound inventory before attaching it.
    pub fn with_agent_skill_resources(
        mut self,
        snapshot: OfficeExpertResourceSnapshot,
        root: PathBuf,
    ) -> Result<Self> {
        let root = root.canonicalize()?;
        snapshot.validate()?;
        let definition = self
            .agent_definition_context()
            .ok_or_else(|| anyhow::anyhow!("AGENT_DEFINITION_REQUIRED"))?;
        snapshot.validate_definition(definition)?;
        if !snapshot.skills.is_empty() {
            let tools = self.active_tool_registry();
            if tools.get("skill").is_none() || tools.get("read").is_none() {
                // Instruction-only legacy skills remain usable with an explicit empty
                // tool allowlist. Additional resource files still require real tools.
                anyhow::ensure!(
                    snapshot
                        .skills
                        .values()
                        .all(|files| { files.len() == 1 && files[0].path == "SKILL.md" }),
                    "AGENT_SKILL_TOOLS_NOT_AVAILABLE_IN_LUNA"
                );
                self.clear_agent_skill_resources();
                self.agent_skill_resources = Some(Arc::new(AgentSkillResources {
                    snapshot,
                    root,
                    inline_only: true,
                    approved_loads: Vec::new(),
                }));
                return Ok(self);
            }
        }
        anyhow::ensure!(
            definition.id == snapshot.expert_id,
            "AGENT_RESOURCE_DEFINITION_MISMATCH"
        );
        let digest = snapshot.sha256()?;
        let mut additions = Vec::new();
        let mut approved_loads = Vec::new();
        for configured in definition.skills.iter().filter(|skill| skill.enabled) {
            let files = snapshot
                .skills
                .get(&configured.slug)
                .ok_or_else(|| anyhow::anyhow!("AGENT_RESOURCE_MISSING"))?;
            let base = root.join(&configured.slug);
            let entry = files
                .iter()
                .find(|file| file.path == "SKILL.md")
                .ok_or_else(|| anyhow::anyhow!("AGENT_RESOURCE_MISSING"))?;
            let mut skill =
                kcoder_skills::parse_pinned_skill_file(&base.join("SKILL.md"), &entry.sha256)?;
            anyhow::ensure!(
                format!("{:x}", Sha256::digest(configured.content.as_bytes())) == entry.sha256,
                "AGENT_RESOURCE_CONTENT_CHANGED"
            );
            let suffix = format!(
                "{:x}",
                Sha256::digest(format!("{digest}:{}", configured.slug))
            );
            skill.name = format!(
                "expert:{}:{suffix}",
                configured.slug.chars().take(48).collect::<String>()
            );
            skill.paths = None;
            skill.user_invocable = true;
            if skill.description.is_empty() {
                skill.description = configured.description.clone();
            }
            approved_loads.push(kcoder_tools::SelectedExpertSkillLoad::after_host_approval(
                skill.name.clone(),
                skill.source.clone(),
                entry.sha256.clone(),
            )?);
            additions.push(skill);
        }
        self.clear_agent_skill_resources();
        let active_skills = crate::recover_read_lock(&self.active_skills, "active_skills").clone();
        self.active_skills = Arc::new(RwLock::new(active_skills));
        let mut registry = crate::recover_read_lock(&self.skill_registry, "skill_registry").clone();
        registry.clear_runtime_expert_skills();
        for skill in additions {
            registry.insert_runtime_skill(skill)?;
        }
        self.skill_registry = Arc::new(RwLock::new(registry));
        self.sandbox = Arc::new(
            self.sandbox
                .as_ref()
                .clone()
                .with_resource_readonly_paths(vec![root.clone()]),
        );
        self.agent_skill_resources = Some(Arc::new(AgentSkillResources {
            snapshot,
            root,
            inline_only: false,
            approved_loads,
        }));
        Ok(self)
    }

    pub(crate) fn validate_agent_resource_read(
        &self,
        name: &str,
        input: &serde_json::Value,
        output: &kcoder_tools::ToolOutput,
    ) -> Result<()> {
        if name != "read" || output.is_error {
            return Ok(());
        }
        let Some(resources) = &self.agent_skill_resources else {
            return Ok(());
        };
        let Some(path) = input.get("file_path").and_then(serde_json::Value::as_str) else {
            return Ok(());
        };
        let path = std::path::Path::new(path);
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            self.cwd.join(path)
        };
        let observed = output
            .execution_metadata
            .iter()
            .find_map(|metadata| match metadata {
                kcoder_tools::ToolExecutionMetadata::FileRead(read)
                    if read.path().starts_with(&resources.root) =>
                {
                    Some(read)
                }
                _ => None,
            });
        let Some(observed) = observed else {
            anyhow::ensure!(
                !path.starts_with(&resources.root),
                "AGENT_RESOURCE_PATH_CHANGED"
            );
            return Ok(());
        };
        let relative = observed.path().strip_prefix(&resources.root)?;
        let expected = resources
            .snapshot
            .skills
            .iter()
            .flat_map(|(slug, files)| {
                files
                    .iter()
                    .map(move |file| (std::path::Path::new(slug).join(&file.path), file))
            })
            .find(|(file, _)| file == relative)
            .map(|(_, file)| file)
            .ok_or_else(|| anyhow::anyhow!("AGENT_RESOURCE_NOT_IN_SNAPSHOT"))?;
        anyhow::ensure!(
            observed
                .full_content_observation()
                .is_some_and(|(bytes, sha)| bytes == expected.bytes && sha == expected.sha256),
            "AGENT_RESOURCE_CONTENT_CHANGED"
        );
        Ok(())
    }
}
