use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeActionRecord {
    pub operation_id: String,
    pub method: String,
    pub intent_sha256: String,
    pub phase: String,
    pub result: Option<Value>,
}
impl OfficeStore {
    /// Reserve before generation, task acceptance, export or delivery. A pending
    /// reservation after process loss requires reconciliation, never blind replay.
    pub fn begin_action(
        &self,
        operation: &str,
        method: &str,
        payload: &Value,
    ) -> Result<(bool, OfficeActionRecord)> {
        valid_id(operation)?;
        valid_id(method)?;
        let intent_sha256 = digest(&serde_json::to_vec(&(method, self.owner(), payload))?);
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        if let Some(record) = state.actions.get(operation) {
            ensure!(
                record.intent_sha256 == intent_sha256 && record.method == method,
                "OFFICE_OPERATION_CONFLICT"
            );
            return Ok((false, record.clone()));
        }
        ensure!(
            !state.operations.contains_key(operation),
            "OFFICE_OPERATION_CONFLICT"
        );
        ensure!(
            state.actions.len() < MAX_OPERATIONS,
            "OFFICE_RECEIPT_CAPACITY"
        );
        let record = OfficeActionRecord {
            operation_id: operation.into(),
            method: method.into(),
            intent_sha256,
            phase: "pending".into(),
            result: None,
        };
        state.actions.insert(operation.into(), record.clone());
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)?;
        Ok((true, record))
    }
    pub fn complete_action(&self, operation: &str, result: &Value) -> Result<OfficeActionRecord> {
        ensure!(
            serde_json::to_vec(result)?.len() <= 128 * 1024,
            "OFFICE_RECEIPT_TOO_LARGE"
        );
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .actions
            .get_mut(operation)
            .context("OFFICE_ACTION_NOT_FOUND")?;
        if record.phase == "completed" {
            ensure!(
                record.result.as_ref() == Some(result),
                "OFFICE_OPERATION_CONFLICT"
            );
            return Ok(record.clone());
        }
        ensure!(
            matches!(record.phase.as_str(), "pending" | "executing"),
            "OFFICE_RECONCILIATION_REQUIRED"
        );
        record.phase = "completed".into();
        record.result = Some(result.clone());
        let output = record.clone();
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)?;
        Ok(output)
    }
    pub fn read_action(&self, operation: &str) -> Result<Option<OfficeActionRecord>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        Ok(self.load()?.actions.get(operation).cloned())
    }
}

impl OfficeStore {
    pub fn dispatch_action_checkpoint(&self, operation: &str, checkpoint: Value) -> Result<()> {
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .actions
            .get_mut(operation)
            .context("OFFICE_ACTION_NOT_FOUND")?;
        ensure!(record.phase == "pending", "OFFICE_RECONCILIATION_REQUIRED");
        record.phase = "executing".into();
        record.result = Some(checkpoint);
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)
    }
    pub fn reject_action(&self, operation: &str, code: &str) -> Result<()> {
        let code = office_public_error_code(code).unwrap_or("OFFICE_OPERATION_FAILED");
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .actions
            .get_mut(operation)
            .context("OFFICE_ACTION_NOT_FOUND")?;
        if record.phase != "pending" {
            return Ok(());
        }
        record.phase = "rejected".into();
        record.result = Some(serde_json::json!({"errorCode":code}));
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)
    }
}

impl OfficeStore {
    /// Use only after an authoritative native port returned rejected, never on a lost response.
    pub fn reject_dispatched_action(&self, operation: &str, code: &str) -> Result<()> {
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .actions
            .get_mut(operation)
            .context("OFFICE_ACTION_NOT_FOUND")?;
        ensure!(
            record.phase == "executing",
            "OFFICE_RECONCILIATION_REQUIRED"
        );
        record.phase = "rejected".into();
        record.result = Some(
            serde_json::json!({"errorCode":office_public_error_code(code).unwrap_or("OFFICE_PORT_REJECTED")}),
        );
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)
    }
}
