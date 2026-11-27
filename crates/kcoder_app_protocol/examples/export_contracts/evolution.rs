//! Reviewed self-evolution request, result and notification shapes. The
//! capability is not advertised until server dispatch exists.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::evolution::*;
    macro_rules! contract {
        ($($name:ident),* $(,)?) => { $(
            super::register::<$name>(stringify!($name), fixtures, schemas)?;
        )* };
    }
    contract! {
        EvolutionStatusParams,
        EvolutionStatusResult,
        EvolutionTargetsListParams,
        EvolutionTargetsListResult,
        EvolutionTargetReadParams,
        EvolutionTargetReadResult,
        EvolutionProposalDecideParams,
        EvolutionProposalDecideResult,
        EvolutionOverlayUpdateParams,
        EvolutionOverlayUpdateResult,
        EvolutionPreferenceListParams,
        EvolutionPreferenceListResult,
        EvolutionPreferenceUpdateParams,
        EvolutionPreferenceUpdateResult,
        EvolutionRateParams,
        EvolutionRateResult,
        EvolutionRatingsListParams,
        EvolutionRatingsListResult,
        EvolutionDataClearParams,
        EvolutionDataClearResult,
        EvolutionTargetDistillParams,
        EvolutionTargetDistillResult,
        EvolutionDistillOutcome,
        EvolutionChangedNotification,
        EvolutionErrorCode,
        EvolutionSettingsReadParams,
        EvolutionSettingsReadResult,
        EvolutionSettingsSaveParams,
    }
    Ok(())
}
