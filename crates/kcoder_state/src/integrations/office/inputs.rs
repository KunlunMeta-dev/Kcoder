use super::*;
mod stored;
pub use stored::OfficeStoredInput;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeInputMetadata {
    pub filename: String,
    pub media_type: String,
    pub expected_bytes: u64,
    pub expected_sha256: String,
}
impl OfficeInputMetadata {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.filename.trim().is_empty()
                && self.filename.chars().count() <= 200
                && !self.filename.contains(['/', '\\', '\0'])
                && !matches!(self.filename.as_str(), "." | "..")
                && self.expected_bytes <= 100 * 1024 * 1024
                && self.expected_sha256.len() == 64
                && self
                    .expected_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                && !self.media_type.is_empty()
                && self.media_type.len() <= 200
                && !self.media_type.chars().any(char::is_control),
            "OFFICE_INVALID_INPUT_METADATA"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeInputReceipt {
    pub input_id: String,
    pub revision: u64,
    pub operation_id: String,
    pub owner: IntegrationOwner,
    pub metadata: OfficeInputMetadata,
    pub status: String,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
}

/// Private trusted-host data, never returned through an ordinary client RPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeNativeInput {
    pub path: String,
    pub stage_ref: Option<Value>,
    pub connection_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeInputRecord {
    pub receipt: OfficeInputReceipt,
    pub intent_sha256: String,
    pub native: Option<OfficeNativeInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_content: Option<OfficeStoredInput>,
}

impl OfficeStore {
    /// Read the original unique operation receipt; never initialize or retry input IO.
    pub fn input_for_operation(&self, operation: &str) -> Result<Option<OfficeInputReceipt>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let mut matches = state
            .inputs
            .values()
            .filter(|record| record.receipt.operation_id == operation);
        let result = matches.next().map(|record| record.receipt.clone());
        ensure!(matches.next().is_none(), "OFFICE_INPUT_OPERATION_CONFLICT");
        Ok(result)
    }
    pub fn begin_input(
        &self,
        operation: &str,
        input_id: &str,
        metadata: OfficeInputMetadata,
    ) -> Result<OfficeInputRecord> {
        self.begin_input_attempt(operation, input_id, metadata)
            .map(|(_, record)| record)
    }
    pub fn begin_input_attempt(
        &self,
        operation: &str,
        input_id: &str,
        metadata: OfficeInputMetadata,
    ) -> Result<(bool, OfficeInputRecord)> {
        valid_id(operation)?;
        valid_id(input_id)?;
        metadata.validate()?;
        let intent = digest(&serde_json::to_vec(&(
            "input.prepare",
            self.owner(),
            input_id,
            &metadata,
        ))?);
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        if let Some(record) = state.inputs.get(input_id) {
            ensure!(
                record.receipt.operation_id == operation && record.intent_sha256 == intent,
                "OFFICE_OPERATION_CONFLICT"
            );
            return Ok((false, record.clone()));
        }
        ensure!(
            !state
                .inputs
                .values()
                .any(|record| record.receipt.operation_id == operation),
            "OFFICE_OPERATION_CONFLICT"
        );
        ensure!(
            !state.actions.contains_key(operation) && !state.operations.contains_key(operation),
            "OFFICE_OPERATION_CONFLICT"
        );
        ensure!(
            state.inputs.len() < MAX_OPERATIONS && state.operations.len() < MAX_OPERATIONS,
            "OFFICE_INPUT_CAPACITY"
        );
        let record = OfficeInputRecord {
            receipt: OfficeInputReceipt {
                input_id: input_id.into(),
                revision: 1,
                operation_id: operation.into(),
                owner: self.owner.clone(),
                metadata,
                status: "pending".into(),
                bytes: None,
                sha256: None,
            },
            intent_sha256: intent,
            native: None,
            stored_content: None,
        };
        state.inputs.insert(input_id.into(), record.clone());
        state.operations.insert(
            operation.into(),
            StoredOperation {
                intent_sha256: record.intent_sha256.clone(),
                result: serde_json::to_value(&record.receipt)?,
            },
        );
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)?;
        Ok((true, record))
    }
    /// Only the host that captured the real upload/finish receipt may call this.
    pub fn complete_input(
        &self,
        operation: &str,
        input_id: &str,
        bytes: u64,
        sha256: &str,
        native: OfficeNativeInput,
    ) -> Result<OfficeInputReceipt> {
        valid_id(operation)?;
        valid_id(input_id)?;
        ensure!(
            sha256.len() == 64
                && sha256.bytes().all(|b| b.is_ascii_hexdigit())
                && !native.path.is_empty()
                && native.path.len() <= 32 * 1024
                && !native.path.contains('\0'),
            "OFFICE_INVALID_NATIVE_RECEIPT"
        );
        valid_id(&native.connection_id)?;
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .inputs
            .get_mut(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        ensure!(
            record.receipt.owner == self.owner && record.receipt.operation_id == operation,
            "OFFICE_OWNER_MISMATCH"
        );
        ensure!(
            bytes == record.receipt.metadata.expected_bytes
                && sha256.eq_ignore_ascii_case(&record.receipt.metadata.expected_sha256),
            "OFFICE_INPUT_SIZE_MISMATCH"
        );
        if record.receipt.status == "accepted" {
            ensure!(
                record.receipt.bytes == Some(bytes)
                    && record.receipt.sha256.as_deref() == Some(sha256)
                    && record.native.as_ref() == Some(&native),
                "OFFICE_OPERATION_CONFLICT"
            );
            return Ok(record.receipt.clone());
        }
        ensure!(
            record.receipt.status == "pending",
            "OFFICE_INPUT_RECONCILIATION_REQUIRED"
        );
        record.receipt.status = "accepted".into();
        record.receipt.bytes = Some(bytes);
        record.receipt.sha256 = Some(sha256.into());
        record.native = Some(native);
        let receipt = record.receipt.clone();
        state
            .operations
            .get_mut(operation)
            .context("OFFICE_RECEIPT_MISSING")?
            .result = serde_json::to_value(&receipt)?;
        state.revision = state
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        self.save(&state)?;
        Ok(receipt)
    }
    pub fn fail_input(&self, operation: &str, input_id: &str) -> Result<OfficeInputReceipt> {
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .inputs
            .get_mut(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        ensure!(
            record.receipt.owner == self.owner && record.receipt.operation_id == operation,
            "OFFICE_OWNER_MISMATCH"
        );
        if record.receipt.status != "accepted" {
            record.receipt.status = "unknown".into();
            let receipt = record.receipt.clone();
            state
                .operations
                .get_mut(operation)
                .context("OFFICE_RECEIPT_MISSING")?
                .result = serde_json::to_value(&receipt)?;
            state.revision = state
                .revision
                .checked_add(1)
                .context("OFFICE_REVISION_OVERFLOW")?;
            self.save(&state)?;
            return Ok(receipt);
        }
        Ok(record.receipt.clone())
    }
    pub fn read_input(&self, input_id: &str) -> Result<Option<OfficeInputRecord>> {
        valid_id(input_id)?;
        let _lock = self.lock(false)?;
        let record = self.load()?.inputs.get(input_id).cloned();
        if let Some(record) = &record {
            ensure!(record.receipt.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        }
        Ok(record)
    }
}
