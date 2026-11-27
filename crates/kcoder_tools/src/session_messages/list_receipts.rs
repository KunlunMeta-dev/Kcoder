//! Read-only peer outbox tool, bound to the independent source that invoked it.
use super::*;
use kcoder_types::cross_session_messages::{
    CrossSessionMessageReceiptListParams, MAX_RECEIPT_LIST_BYTES,
};

#[derive(Clone)]
pub struct ListSessionMessageReceiptsTool {
    pub(super) contribution: Arc<()>,
    host: Arc<dyn SessionMessagesHost>,
}

impl ListSessionMessageReceiptsTool {
    pub fn new(host: Arc<dyn SessionMessagesHost>) -> Self {
        Self {
            host,
            contribution: Arc::new(()),
        }
    }
    pub fn weak_contribution(&self) -> SessionMessageContribution {
        SessionMessageContribution(Arc::downgrade(&self.contribution))
    }
    pub fn same_contribution(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.contribution, &other.contribution)
    }
}
#[async_trait]
impl Tool for ListSessionMessageReceiptsTool {
    fn name(&self) -> String {
        "ListSessionMessageReceipts".into()
    }
    fn description(&self) -> String {
        concat!(
            "List messages this independent session already sent, including its own outgoing replies. To find a reply's IDs, invoke this tool in the session that sent that reply and filter by the destination's thread ID. ",
            "{} returns the first page; filters combine with AND (createdAfterMs inclusive, createdBeforeMs exclusive, Unix ms). ",
            "To continue, repeat the same filters with cursor = nextCursor, even after an empty page. ",
            "Each row gives the original clientMessageId and destination. confirmed carries a fresh receipt (messageId, status, revision, ",
            "deferral reason); missing means the destination confirmed no current receipt; unconfirmedCount counts candidates this page ",
            "could not verify. An unreachable destination never matches status or time filters, and a durable status of unknown differs ",
            "from an unconfirmed observation; retry later instead of resending. A queued row whose reasonCode starts with cold_target_ ",
            "is still awaiting delivery. Recovered clientMessageId values identify sends in this same session. ",
            "Never sends, resumes, acknowledges or marks messages read."
        ).into()
    }
    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(CrossSessionMessageReceiptListParams));
        crate::session_discovery::set_model_field_descriptions(
            &mut schema,
            &[
                (
                    "targetThreadId",
                    "Exact, case-sensitive destination threadId from ListSessions; omit for any destination.",
                ),
                (
                    "status",
                    "Current receipt status: queued (awaiting delivery), delivering, applied (appended to the recipient's history), rejected, expired or unknown.",
                ),
                (
                    "createdAfterMs",
                    "Inclusive lower creation-time bound, Unix milliseconds (UTC).",
                ),
                (
                    "createdBeforeMs",
                    "Exclusive upper creation-time bound, Unix milliseconds (UTC); must exceed createdAfterMs.",
                ),
                (
                    "limit",
                    "Maximum matches; default 10, may change between pages.",
                ),
                (
                    "cursor",
                    "Exact nextCursor; repeat the original filters. Omit to change filters or refresh.",
                ),
            ],
        );
        schema
    }
    fn is_read_only(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let started = std::time::Instant::now();
        let result = self.call_observed(input, ctx).await;
        crate::peer_diagnostics::observe_tool_result(
            "ListSessionMessageReceipts",
            started,
            false,
            &result,
        );
        result
    }
}
impl ListSessionMessageReceiptsTool {
    async fn call_observed(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        if !input.is_object() {
            return Err(ToolError::InvalidInput(
                "ListSessionMessageReceipts expects a JSON object".into(),
            ));
        }
        let query: CrossSessionMessageReceiptListParams = parse_input(&input)?;
        query
            .validate()
            .map_err(|message| ToolError::InvalidInput(message.into()))?;
        let call = call(ctx, &self.contribution, "ListSessionMessageReceipts")?;
        let response = tokio::select! {
            biased;
            _ = ctx.cancelled() => return Err(ToolError::Execution("peer_message_receipt_list_cancelled".into())),
            result = self.host.list_receipts(call.clone(), query.clone()) => result?,
        };
        if !call.is_current() || ctx.is_aborted() {
            return Err(ToolError::Execution("peer_message_source_changed".into()));
        }
        response
            .validate(&query, &call.state().session_id(), None)
            .map_err(|code| ToolError::Execution(code.into()))?;
        let json = serde_json::to_string(&response)
            .map_err(|_| ToolError::Execution("peer_message_receipt_list_invalid_result".into()))?;
        if json.len() > MAX_RECEIPT_LIST_BYTES {
            return Err(ToolError::Execution(
                "peer_message_receipt_list_limit".into(),
            ));
        }
        Ok(ToolOutput::text(json))
    }
}
