use kcoder_app_protocol::thread_ownership::ThreadOwnershipErrorDataV1;
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    super::register::<ThreadOwnershipErrorDataV1>("ThreadOwnershipErrorDataV1", fixtures, schemas)
}
