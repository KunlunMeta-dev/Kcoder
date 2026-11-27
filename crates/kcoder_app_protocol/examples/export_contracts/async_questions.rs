//! Reviewed nonblocking question contracts share the task-interaction domain.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::*;
    use kcoder_types::async_user_questions::*;
    macro_rules! contracts {
        ($($contract:ident),+ $(,)?) => {$(
            super::register::<$contract>(stringify!($contract), fixtures, schemas)?;
        )+};
    }
    contracts!(
        AsyncQuestionOptionDraft,
        AsyncQuestionItemDraft,
        AsyncQuestionRequest,
        AsyncQuestionOption,
        AsyncQuestionItem,
        AsyncQuestionStatus,
        AsyncQuestionAnswerValue,
        AsyncQuestionAnswerRecord,
        AsyncQuestionRecord,
        AsyncQuestionAccepted,
        AsyncQuestionAnswerReceipt,
        AsyncQuestionListParams,
        AsyncQuestionAnswerParams,
        AsyncQuestionCancelParams,
        AsyncQuestionListResult,
        AsyncQuestionAnswerResult,
        AsyncQuestionCancelResult,
        AsyncQuestionChangedNotification,
    );
    Ok(())
}
