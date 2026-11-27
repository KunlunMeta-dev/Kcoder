//! Profile-owned workspace hints remain independent of thread read authorization.
use kcoder_app_protocol::thread_workspace_lookup::*;
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    super::register::<ThreadWorkspaceLookupParams>(
        "ThreadWorkspaceLookupParams",
        fixtures,
        schemas,
    )?;
    super::register::<ThreadWorkspaceHintV1>("ThreadWorkspaceHintV1", fixtures, schemas)?;
    super::register::<ThreadWorkspaceLookupCompleteness>(
        "ThreadWorkspaceLookupCompleteness",
        fixtures,
        schemas,
    )?;
    super::register::<ThreadWorkspaceLookupResult>(
        "ThreadWorkspaceLookupResult",
        fixtures,
        schemas,
    )?;
    Ok(())
}
