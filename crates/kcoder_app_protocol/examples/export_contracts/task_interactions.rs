//! Exact native interaction projections do not create reply authority.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    super::register::<kcoder_app_protocol::TaskInteractionReferenceV1>(
        "TaskInteractionReferenceV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionOptionV1>(
        "TaskInteractionOptionV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionQuestionV1>(
        "TaskInteractionQuestionV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionApprovalKindV1>(
        "TaskInteractionApprovalKindV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionApprovalV1>(
        "TaskInteractionApprovalV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionPresentationV1>(
        "TaskInteractionPresentationV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionStateV1>(
        "TaskInteractionStateV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionObservationStateV1>(
        "TaskInteractionObservationStateV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionItemV1>(
        "TaskInteractionItemV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionSnapshotV1>(
        "TaskInteractionSnapshotV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionAnswerV1>(
        "TaskInteractionAnswerV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionRespondParamsV1>(
        "TaskInteractionRespondParamsV1",
        fixtures,
        schemas,
    )?;
    super::register::<kcoder_app_protocol::TaskInteractionRespondResultV1>(
        "TaskInteractionRespondResultV1",
        fixtures,
        schemas,
    )?;
    Ok(())
}
