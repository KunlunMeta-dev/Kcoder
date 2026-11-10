//! A virtual Hook definition is bound to its original configuration, not a fabricated credential file.
use crate::{asset_sources::SourceAsset, discovery::ConfigurationBinding};
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InlineHooksBinding {
    pub(crate) configuration: ConfigurationBinding,
}
impl InlineHooksBinding {
    pub(crate) fn read(&self) -> Result<SourceAsset> {
        let bytes = self
            .configuration
            .definition_hook_bytes()?
            .ok_or_else(|| anyhow::anyhow!("migration_source_changed"))?;
        Ok(SourceAsset {
            key: "inline-hooks.json".into(),
            name: "inline-hooks".into(),
            files: vec![kcoder_skills::SkillPackageFile {
                relative_path: "inline-hooks.json".into(),
                content: bytes,
                executable: false,
            }],
            native_reference: false,
        })
    }
}
