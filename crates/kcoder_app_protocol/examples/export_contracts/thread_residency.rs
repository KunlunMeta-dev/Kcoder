use kcoder_app_protocol::{
    ThreadEvictedParams, ThreadMaintenanceBusyErrorDataV1, ThreadMaintenanceCancelParams,
    ThreadMaintenanceCancelResult, ThreadMaintenanceParams, ThreadNotResidentErrorDataV1,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    super::register::<ThreadEvictedParams>("ThreadEvictedParams", fixtures, schemas)?;
    super::register::<ThreadNotResidentErrorDataV1>(
        "ThreadNotResidentErrorDataV1",
        fixtures,
        schemas,
    )?;
    super::register::<ThreadMaintenanceParams>("ThreadMaintenanceParams", fixtures, schemas)?;
    super::register::<ThreadMaintenanceCancelParams>(
        "ThreadMaintenanceCancelParams",
        fixtures,
        schemas,
    )?;
    super::register::<ThreadMaintenanceCancelResult>(
        "ThreadMaintenanceCancelResult",
        fixtures,
        schemas,
    )?;
    super::register::<ThreadMaintenanceBusyErrorDataV1>(
        "ThreadMaintenanceBusyErrorDataV1",
        fixtures,
        schemas,
    )
}
