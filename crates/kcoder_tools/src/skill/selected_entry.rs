//! Host approval for one exact expert entry; never decoded from a model or workflow payload.
use crate::ToolError;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct SelectedExpertSkillLoad {
    name: String,
    source: PathBuf,
    sha256: String,
}

impl std::fmt::Debug for SelectedExpertSkillLoad {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectedExpertSkillLoad")
            .finish_non_exhaustive()
    }
}

impl SelectedExpertSkillLoad {
    /// The trusted host must first approve this selected expert's execution under its original Native scope.
    /// This reuses that instruction-load approval only; tools, scripts and other skill entries gain nothing.
    pub fn after_host_approval(
        name: String,
        source: PathBuf,
        sha256: String,
    ) -> Result<Self, ToolError> {
        if !name.starts_with("expert:")
            || !source.is_absolute()
            || sha256.len() != 64
            || !sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(ToolError::InvalidInput(
                "invalid selected expert entry approval".into(),
            ));
        }
        Ok(Self {
            name,
            source,
            sha256,
        })
    }

    pub(crate) fn approves(&self, name: &str, source: &Path) -> Result<bool, ToolError> {
        if self.name != name || self.source != source {
            return Ok(false);
        }
        let verify = || -> anyhow::Result<()> {
            let parent = kcoder_config::PrivateDirectory::open_existing(
                source
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("skill entry has no parent"))?,
            )?;
            let file = parent.open_regular_file(source.file_name().unwrap_or(OsStr::new("")))?;
            let mut bytes = Vec::new();
            file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
            anyhow::ensure!(
                bytes.len() <= 1024 * 1024
                    && format!("{:x}", Sha256::digest(&bytes)) == self.sha256,
                "selected expert entry changed after approval"
            );
            Ok(())
        };
        verify().map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SkillTool, Tool, ToolContext};
    use std::sync::{Arc, RwLock};

    #[tokio::test]
    async fn selected_expert_entry_reuses_only_its_exact_host_approval() {
        let root = tempfile::tempdir().unwrap();
        let body = "---\nname: source\ndescription: Notes\n---\nWrite clear notes.";
        let entry = root.path().join("SKILL.md");
        std::fs::write(&entry, body).unwrap();
        let mut skill = kcoder_skills::parse_skill_file_lazy(&entry).unwrap();
        skill.name = "expert:approved-source".into();
        let mut registry = kcoder_skills::SkillRegistry::empty();
        registry.insert_runtime_skill(skill.clone()).unwrap();
        let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
            .with_skill_registry(Arc::new(RwLock::new(registry)))
            .with_active_skills(Arc::new(RwLock::new(Vec::new())))
            .with_external_skill_dirs(vec![root.path().to_owned()])
            .with_project_skill_telemetry(false);
        assert!(!context.trust_external_skills);
        assert!(
            SkillTool
                .call(serde_json::json!({"skill":skill.name}), &context)
                .await
                .is_err()
        );
        let approval = SelectedExpertSkillLoad::after_host_approval(
            skill.name.clone(),
            entry.clone(),
            format!("{:x}", Sha256::digest(body.as_bytes())),
        )
        .unwrap();
        assert!(!approval.approves("expert:another-source", &entry).unwrap());
        let context = context.with_selected_expert_skill_loads(vec![approval.clone()]);
        let loaded = SkillTool
            .call(serde_json::json!({"skill":skill.name}), &context)
            .await
            .unwrap();
        assert!(!loaded.is_error);
        assert!(!context.trust_external_skills);
        std::fs::write(&entry, "Changed entry").unwrap();
        assert!(approval.approves(&skill.name, &entry).is_err());
    }

    #[tokio::test]
    async fn selected_expert_entry_approval_does_not_disable_high_risk_scan() {
        let root = tempfile::tempdir().unwrap();
        let body = "---\nname: unsafe\ndescription: Fixture\n---\nrm -rf /";
        let entry = root.path().join("SKILL.md");
        std::fs::write(&entry, body).unwrap();
        let mut skill = kcoder_skills::parse_skill_file_lazy(&entry).unwrap();
        skill.name = "expert:risk-fixture".into();
        let mut registry = kcoder_skills::SkillRegistry::empty();
        registry.insert_runtime_skill(skill.clone()).unwrap();
        let approval = SelectedExpertSkillLoad::after_host_approval(
            skill.name.clone(),
            entry,
            format!("{:x}", Sha256::digest(body.as_bytes())),
        )
        .unwrap();
        let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
            .with_skill_registry(Arc::new(RwLock::new(registry)))
            .with_active_skills(Arc::new(RwLock::new(Vec::new())))
            .with_external_skill_dirs(vec![root.path().to_owned()])
            .with_selected_expert_skill_loads(vec![approval])
            .with_project_skill_telemetry(false);
        let error = SkillTool
            .call(serde_json::json!({"skill":skill.name}), &context)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("high-risk"));
    }
}
