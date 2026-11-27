use serde_json::Value;
use std::collections::BTreeMap;
pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::*;
    super::register::<AttachmentDraftRetainParams>(
        "AttachmentDraftRetainParams",
        fixtures,
        schemas,
    )?;
    super::register::<AttachmentDraftRetainResult>(
        "AttachmentDraftRetainResult",
        fixtures,
        schemas,
    )?;
    Ok(())
}
