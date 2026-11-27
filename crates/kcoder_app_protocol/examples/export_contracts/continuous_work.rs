//! Reviewed shapes for not-yet-advertised continuous work requests and views.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::continuous_work::*;
    macro_rules! contract {
        ($($name:ident),* $(,)?) => { $(
            super::register::<$name>(stringify!($name), fixtures, schemas)?;
        )* };
    }
    contract! {
        ContinuousWorkCapability,
        ContinuousWorkPresence,
        ContinuousWorkListParams,
        ContinuousWorkReadParams,
        ContinuousWorkView,
        ContinuousWorkWaitView,
        ContinuousWorkDeliveryRequirement,
        ContinuousWorkResultView,
        ContinuousWorkListResult,
        ContinuousWorkReadResult,
        ContinuousWorkInputSubmitParams,
        ContinuousWorkInputReadParams,
        ContinuousWorkInputReceiptView,
        ContinuousWorkInputResult,
        ContinuousWorkControlAction,
        ContinuousWorkControlTarget,
        ContinuousWorkControlParams,
        ContinuousWorkControlResult,
        ContinuousWorkChanged,
    }
    Ok(())
}
