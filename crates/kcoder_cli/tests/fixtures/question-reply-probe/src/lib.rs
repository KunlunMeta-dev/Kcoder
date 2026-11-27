#![allow(dead_code)]
//! Compile the production response boundary without the Engine or model transports.
mod boundary {
    use kcoder_app_protocol::{ApprovalResponse, QuestionResponse};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::oneshot;

    type PendingQuestionResponses =
        Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<QuestionResponse, String>>>>>;
    type PendingApprovalResponses =
        Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<ApprovalResponse, String>>>>>;
    pub(super) enum InteractionReply {
        Delivered,
        Misattributed,
        Unmatched,
    }
    #[derive(Clone)]
    pub(super) struct InteractionBinding {
        interaction_id: String,
        server_id: String,
        thread_id: String,
        turn_id: String,
        kind: kcoder_app_protocol::InteractionStatusKindV1,
    }
    struct OutstandingInteraction {
        binding: InteractionBinding,
        request: Value,
    }
    #[derive(Default)]
    pub(super) struct InteractionReceipts {
        outstanding: HashMap<u64, OutstandingInteraction>,
    }
    struct ReplyBinding<'a> {
        interaction_id: Option<&'a str>,
        thread_id: Option<&'a str>,
        turn_id: Option<&'a str>,
    }
    include!(concat!(env!("OUT_DIR"), "/replies.rs"));
    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        include!(concat!(env!("OUT_DIR"), "/tests.rs"));
    }
}
