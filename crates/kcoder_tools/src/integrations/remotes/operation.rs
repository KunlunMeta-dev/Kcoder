//! Original-operation management never delegates another prompt or selects a replacement peer.
use super::*;

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationAction {
    Read,
    Reconcile,
    Cancel,
}
#[derive(Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationInput {
    pub action: RemoteOperationAction,
    pub operation_id: String,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}
impl RemoteOperationInput {
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.operation_id.is_empty()
            || self.operation_id.len() > 256
            || self.operation_id.chars().any(char::is_control)
            || (matches!(self.action, RemoteOperationAction::Cancel)
                && self.expected_revision.is_none())
        {
            return Err(ToolError::InvalidInput("RemoteOperation requires the original operationId; cancel also requires its current operationRevision as expectedRevision".into()));
        }
        Ok(())
    }
}
pub struct RemoteOperationTool {
    backend: Arc<dyn RemoteDelegateBackend>,
}
impl RemoteOperationTool {
    pub fn new(backend: Arc<dyn RemoteDelegateBackend>) -> Self {
        Self { backend }
    }
}
#[async_trait]
impl Tool for RemoteOperationTool {
    fn name(&self) -> String {
        "RemoteOperation".into()
    }
    fn source(&self) -> ToolSource {
        ToolSource::NativeFeature {
            feature: "remotes".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Read or reconcile one original remote operationId and its exact native receiver task without starting a process, creating a task or replaying a prompt. Read/reconcile are observation only. Cancel requests revocation of that original operation and requires the current operationRevision as expectedRevision; cancel_requested is not confirmed execution termination or process cleanup. Native Completed/Failed/Interrupted and missing/unknown receipts remain distinct. A protocol stop or valid artifact does not prove business correctness. Never substitute a new peer/session after an unknown result.".into()
    }
    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(RemoteOperationInput))
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    async fn call(&self, value: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        if !actual.authorizes_native_tool_invocation(self, &value) {
            return Err(ToolError::Execution(
                "REMOTE_NATIVE_APPROVAL_RECEIPT_REQUIRED".into(),
            ));
        }
        let input: RemoteOperationInput = parse_input(&value)?;
        input.validate()?;
        if actual.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let result = self.backend.operation(input, actual)?;
        Ok(ToolOutput::text(serde_json::to_string(&result).map_err(
            |_| ToolError::Execution("REMOTE_RESULT_INVALID".into()),
        )?))
    }
}
