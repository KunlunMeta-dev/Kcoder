//! Unified extension inventory, skill source preference, per-plugin skill
//! switch and conflict previews.
use kcoder_app_protocol::*;
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    super::register::<ExtensionsInventoryParams>("ExtensionsInventoryParams", fixtures, schemas)?;
    super::register::<ExtensionsInventoryResult>("ExtensionsInventoryResult", fixtures, schemas)?;
    super::register::<ExtensionSkillPreferenceUpdateParams>(
        "ExtensionSkillPreferenceUpdateParams",
        fixtures,
        schemas,
    )?;
    super::register::<ExtensionSkillPreferenceResult>(
        "ExtensionSkillPreferenceResult",
        fixtures,
        schemas,
    )?;
    super::register::<ExtensionPluginSkillsSetEnabledParams>(
        "ExtensionPluginSkillsSetEnabledParams",
        fixtures,
        schemas,
    )?;
    super::register::<ExtensionPluginSkillsResult>(
        "ExtensionPluginSkillsResult",
        fixtures,
        schemas,
    )?;
    super::register::<ExtensionConflictsPreviewParams>(
        "ExtensionConflictsPreviewParams",
        fixtures,
        schemas,
    )?;
    super::register::<ExtensionConflictsPreviewResult>(
        "ExtensionConflictsPreviewResult",
        fixtures,
        schemas,
    )?;
    Ok(())
}
