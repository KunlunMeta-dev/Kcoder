//! Immutable material bytes in the existing Office namespace, not staging paths.
use super::*;
use std::io;
#[cfg(test)]
#[path = "stored_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeStoredInput {
    pub schema_version: u32,
    pub bytes: u64,
    pub sha256: String,
}
impl OfficeStoredInput {
    pub(in crate::integrations::office) fn validate_for(
        &self,
        receipt: &OfficeInputReceipt,
    ) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && receipt.status == "accepted"
                && receipt.bytes == Some(self.bytes)
                && receipt.sha256.as_deref() == Some(self.sha256.as_str())
                && self.bytes == receipt.metadata.expected_bytes
                && self.sha256.len() == 64
                && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && self
                    .sha256
                    .eq_ignore_ascii_case(&receipt.metadata.expected_sha256),
            "OFFICE_INPUT_CONTENT_CORRUPT"
        );
        Ok(())
    }
    fn name(&self) -> String {
        format!("input-content-{}.blob", self.sha256.to_ascii_lowercase())
    }
}

/// The Native host first verifies its actual owned upload descriptor. This
/// method publishes only a size/hash-checked stream, then one atomic receipt.
impl OfficeStore {
    pub fn complete_stored_input(
        &self,
        operation: &str,
        input_id: &str,
        source: &mut impl Read,
        current: impl Fn() -> bool,
    ) -> Result<OfficeInputReceipt> {
        valid_id(operation)?;
        valid_id(input_id)?;
        ensure!(current(), "OFFICE_CANCELLED");
        let _lock = self.lock(true)?;
        let mut state = self.load()?;
        let record = state
            .inputs
            .get(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        ensure!(
            record.receipt.owner == self.owner && record.receipt.operation_id == operation,
            "OFFICE_OWNER_MISMATCH"
        );
        record.receipt.metadata.validate()?;
        let content = OfficeStoredInput {
            schema_version: 1,
            bytes: record.receipt.metadata.expected_bytes,
            sha256: record.receipt.metadata.expected_sha256.to_ascii_lowercase(),
        };
        if record.receipt.status == "accepted" {
            ensure!(
                record.stored_content.as_ref() == Some(&content),
                "OFFICE_OPERATION_CONFLICT"
            );
            self.verify_input_blob(&content, &current)?;
            return Ok(record.receipt.clone());
        }
        ensure!(
            record.receipt.status == "pending" && record.stored_content.is_none(),
            "OFFICE_INPUT_RECONCILIATION_REQUIRED"
        );
        let name = content.name();
        match self
            .directory
            .open_single_link_regular_file(OsStr::new(&name))
        {
            Ok(_) => self.verify_input_blob(&content, &current)?,
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                let mut checked = CheckedInput {
                    source,
                    current: &current,
                    expected: &content,
                    received: 0,
                    hash: Sha256::new(),
                };
                self.directory.atomic_publish_from_reader(
                    OsStr::new(&name),
                    &mut checked,
                    false,
                    || {
                        ensure!(current(), "OFFICE_CANCELLED");
                        Ok(None)
                    },
                )?;
            }
            Err(error) => return Err(error),
        }
        self.verify_input_blob(&content, &current)?;
        ensure!(current(), "OFFICE_CANCELLED");
        let record = state
            .inputs
            .get_mut(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        record.receipt.status = "accepted".into();
        record.receipt.bytes = Some(content.bytes);
        record.receipt.sha256 = Some(content.sha256.clone());
        record.native = Some(OfficeNativeInput {
            path: format!("office-input:{input_id}:1"),
            stage_ref: None,
            connection_id: "office-store-v1".into(),
        });
        record.stored_content = Some(content);
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

    pub fn validate_stored_input(
        &self,
        input_id: &str,
        current: impl Fn() -> bool,
    ) -> Result<Option<OfficeInputReceipt>> {
        valid_id(input_id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let record = state
            .inputs
            .get(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        let Some(content) = &record.stored_content else {
            return Ok(None);
        };
        content.validate_for(&record.receipt)?;
        self.verify_input_blob(content, &current)?;
        Ok(Some(record.receipt.clone()))
    }

    pub fn read_stored_input(
        &self,
        input_id: &str,
        maximum_bytes: u64,
        current: impl Fn() -> bool,
    ) -> Result<Option<(OfficeInputReceipt, Vec<u8>)>> {
        valid_id(input_id)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let record = state
            .inputs
            .get(input_id)
            .context("OFFICE_INPUT_NOT_FOUND")?;
        let Some(content) = &record.stored_content else {
            return Ok(None);
        };
        content.validate_for(&record.receipt)?;
        ensure!(
            content.bytes <= maximum_bytes && maximum_bytes <= 100 * 1024 * 1024,
            "OFFICE_INPUT_TOO_LARGE"
        );
        self.verify_input_blob(content, &current)?;
        let name = content.name();
        let identity = self
            .directory
            .portable_regular_identity(OsStr::new(&name))?;
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new(&name))?;
        let mut bytes = Vec::with_capacity(usize::try_from(content.bytes)?);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            ensure!(current(), "OFFICE_CANCELLED");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            ensure!(
                bytes.len().saturating_add(count) as u64 <= content.bytes,
                "OFFICE_INPUT_CONTENT_CORRUPT"
            );
            bytes.extend_from_slice(&buffer[..count]);
        }
        ensure!(
            bytes.len() as u64 == content.bytes
                && digest(&bytes) == content.sha256
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(&name))?
                    == identity,
            "OFFICE_INPUT_CONTENT_CORRUPT"
        );
        ensure!(current(), "OFFICE_CANCELLED");
        Ok(Some((record.receipt.clone(), bytes)))
    }

    fn verify_input_blob(
        &self,
        content: &OfficeStoredInput,
        current: &impl Fn() -> bool,
    ) -> Result<()> {
        let name = content.name();
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new(&name))?;
        let identity = self.directory.portable_regular_handle_identity(&file)?;
        ensure!(
            file.metadata()?.len() == content.bytes,
            "OFFICE_INPUT_CONTENT_CORRUPT"
        );
        let mut hash = Sha256::new();
        let mut received = 0u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            ensure!(current(), "OFFICE_CANCELLED");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            received += count as u64;
            ensure!(received <= content.bytes, "OFFICE_INPUT_CONTENT_CORRUPT");
            hash.update(&buffer[..count]);
        }
        ensure!(
            received == content.bytes
                && format!("{:x}", hash.finalize()) == content.sha256
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(&name))?
                    == identity,
            "OFFICE_INPUT_CONTENT_CORRUPT"
        );
        Ok(())
    }
}
struct CheckedInput<'a, R> {
    source: &'a mut R,
    current: &'a dyn Fn() -> bool,
    expected: &'a OfficeStoredInput,
    received: u64,
    hash: Sha256,
}
impl<R: Read> Read for CheckedInput<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if !(self.current)() {
            return Err(io::Error::other("OFFICE_CANCELLED"));
        }
        if buffer.is_empty() {
            return Ok(0);
        }
        let count = self.source.read(buffer)?;
        self.received += count as u64;
        if self.received > self.expected.bytes {
            return Err(io::Error::other("OFFICE_INPUT_HASH_MISMATCH"));
        }
        if count == 0 {
            if self.received != self.expected.bytes
                || format!("{:x}", self.hash.clone().finalize()) != self.expected.sha256
            {
                return Err(io::Error::other("OFFICE_INPUT_HASH_MISMATCH"));
            }
        } else {
            self.hash.update(&buffer[..count]);
        }
        Ok(count)
    }
}
