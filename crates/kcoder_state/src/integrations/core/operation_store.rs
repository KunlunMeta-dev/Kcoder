//! Private operation ledger with stable intents and compare-and-swap outcomes.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::integrations::core::{
    IntegrationEntityRef, IntegrationError, IntegrationOperationPhase, IntegrationOperationReceipt,
    IntegrationOwner, IntegrationRequest, IntegrationRuntimeAcceptance, IntegrationScope,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, fs::File, io::Read, path::Path};

pub const MAX_INTEGRATION_OPERATION_RECORDS: usize = 4096;
pub const MAX_INTEGRATION_OPERATION_BYTES: usize = 64 * 1024;
pub const MAX_INTEGRATION_INTENT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    version: u32,
    directory_identity: String,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    intent_sha256: String,
    receipt: IntegrationOperationReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntegrationOperationBegin {
    Created(IntegrationOperationReceipt),
    Existing(IntegrationOperationReceipt),
}

impl IntegrationOperationBegin {
    pub fn receipt(&self) -> &IntegrationOperationReceipt {
        match self {
            Self::Created(receipt) | Self::Existing(receipt) => receipt,
        }
    }
}

pub struct IntegrationOperationStore {
    directory: PrivateDirectory,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    // Retaining the original descriptor prevents unlink/recreate inode reuse.
    lock_anchor: File,
}

pub struct IntegrationOperationUpdate {
    pub expected_revision: u64,
    pub phase: IntegrationOperationPhase,
    pub entity_ref: Option<IntegrationEntityRef>,
    pub error: Option<IntegrationError>,
    pub runtime_acceptance: Option<IntegrationRuntimeAcceptance>,
    pub observed_at_ms: u64,
}

impl IntegrationOperationStore {
    /// The caller supplies an authenticated account's private parent, never a model path.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        let directory = parent.create_private_child(name)?;
        let owner = IntegrationOwner::from(scope);
        directory.append(OsStr::new("operations.lock"), b"")?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new("operations.lock"))?;
        let lock_identity = directory.portable_regular_handle_identity(&lock_anchor)?;
        let binding = Binding {
            version: 1,
            directory_identity: directory.directory_identity()?,
            owner: owner.clone(),
            lock_identity: lock_identity.clone(),
        };
        directory.atomic_replace(OsStr::new("owner.json"), &serde_json::to_vec(&binding)?)?;
        Ok(Self {
            directory,
            owner,
            lock_identity,
            lock_anchor,
        })
    }

    /// Missing or corrupt bindings are errors, not permission to adopt or recreate data.
    pub fn open_existing(path: &Path, scope: &IntegrationScope) -> Result<Self> {
        Self::from_directory(PrivateDirectory::open_existing(path)?, scope)
    }

    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        parent.verify_private_directory()?;
        let entry = parent.open_entry_handle(name)?;
        Self::from_directory(entry.open_child_directory()?, scope)
    }

    pub fn storage_directory_identity(&self) -> Result<String> {
        self.verify_binding()?;
        self.directory.directory_identity()
    }

    fn from_directory(directory: PrivateDirectory, scope: &IntegrationScope) -> Result<Self> {
        scope.validate()?;
        let binding = read_binding(&directory)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new("operations.lock"))?;
        let store = Self {
            directory,
            owner: IntegrationOwner::from(scope),
            lock_identity: binding.lock_identity,
            lock_anchor,
        };
        store.verify_binding()?;
        Ok(store)
    }

    fn verify_binding(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        let bytes = self
            .read_bytes(OsStr::new("owner.json"))?
            .context("integration operation owner is missing")?;
        let binding: Binding =
            serde_json::from_slice(&bytes).context("invalid integration operation owner")?;
        ensure!(
            binding.version == 1
                && binding.owner == self.owner
                && binding.lock_identity == self.lock_identity
                && binding.directory_identity == self.directory.directory_identity()?,
            "integration operation storage identity mismatch"
        );
        ensure!(
            self.directory
                .portable_regular_handle_identity(&self.lock_anchor)?
                == self.lock_identity,
            "integration operation original lock is no longer valid"
        );
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new("operations.lock"))?
                == self.lock_identity,
            "integration operation lock identity mismatch"
        );
        Ok(())
    }

    fn read_bytes(&self, name: &OsStr) -> Result<Option<Vec<u8>>> {
        let file = match self.directory.open_single_link_regular_file(name) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(MAX_INTEGRATION_OPERATION_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_INTEGRATION_OPERATION_BYTES,
            "integration receipt exceeds storage bound"
        );
        Ok(Some(bytes))
    }

    fn read_record(&self, operation_id: &str) -> Result<Option<Record>> {
        let name = record_name(operation_id)?;
        let Some(bytes) = self.read_bytes(OsStr::new(&name))? else {
            return Ok(None);
        };
        let record: Record =
            serde_json::from_slice(&bytes).context("invalid integration operation record")?;
        validate_record(&record)?;
        ensure!(
            record.receipt.operation_id == operation_id
                && IntegrationOwner::from(&record.receipt.scope) == self.owner,
            "integration operation record owner mismatch"
        );
        Ok(Some(record))
    }

    /// Read-only lookup never creates files or repairs a missing receipt.
    pub fn read(&self, operation_id: &str) -> Result<Option<IntegrationOperationReceipt>> {
        self.verify_binding()?;
        Ok(self.read_record(operation_id)?.map(|r| r.receipt))
    }

    /// Match the exact existing native intent without mutation, a writer lock
    /// or operation creation. Lost replies keep their original phase.
    pub fn read_original(
        &self,
        request: &IntegrationRequest,
        port: &str,
        method: &str,
    ) -> Result<Option<IntegrationOperationReceipt>> {
        request.validate(true)?;
        validate_label(port)?;
        validate_label(method)?;
        ensure!(
            IntegrationOwner::from(&request.scope) == self.owner,
            "integration operation scope mismatch"
        );
        let operation = request
            .operation_id
            .as_deref()
            .context("operation identity is required")?;
        let digest = intent_digest(request, port, method)?;
        self.verify_binding()?;
        let Some(record) = self.read_record(operation)? else {
            return Ok(None);
        };
        ensure!(
            record.intent_sha256 == digest,
            "integration operation intent conflict"
        );
        self.verify_binding()?;
        Ok(Some(record.receipt))
    }

    fn writer(&self) -> Result<VerifiedPrivateLease> {
        self.directory
            .try_existing_portable_lock(
                OsStr::new("operations.lock"),
                &self.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("integration operation store is busy")
    }

    pub fn begin(
        &self,
        request: &IntegrationRequest,
        port: &str,
        method: &str,
        now_ms: u64,
    ) -> Result<IntegrationOperationBegin> {
        request.validate(true)?;
        validate_label(port)?;
        validate_label(method)?;
        ensure!(
            IntegrationOwner::from(&request.scope) == self.owner,
            "integration operation scope mismatch"
        );
        let operation_id = request
            .operation_id
            .as_deref()
            .context("operation identity is required")?;
        let intent_sha256 = intent_digest(request, port, method)?;
        let _lock = self.writer()?;
        self.verify_binding()?;
        if let Some(existing) = self.read_record(operation_id)? {
            ensure!(
                existing.intent_sha256 == intent_sha256,
                "integration operation intent conflict"
            );
            return Ok(IntegrationOperationBegin::Existing(existing.receipt));
        }
        let count = self.directory.count_regular_files_bounded(
            |name| {
                name.to_str()
                    .is_some_and(|s| s.starts_with("op-") && s.ends_with(".json"))
            },
            MAX_INTEGRATION_OPERATION_RECORDS,
        )?;
        ensure!(
            count < MAX_INTEGRATION_OPERATION_RECORDS,
            "integration operation capacity reached"
        );
        let receipt = IntegrationOperationReceipt {
            operation_id: operation_id.into(),
            scope: request.scope.clone(),
            port: port.into(),
            method: method.into(),
            revision: 1,
            phase: IntegrationOperationPhase::Pending,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            entity_ref: None,
            error: None,
            runtime_acceptance: None,
        };
        self.write_record(&Record {
            version: 1,
            intent_sha256,
            receipt: receipt.clone(),
        })?;
        Ok(IntegrationOperationBegin::Created(receipt))
    }

    /// Only an authenticated native executor may apply authoritative outcome evidence.
    pub fn compare_and_swap(
        &self,
        operation_id: &str,
        update: IntegrationOperationUpdate,
    ) -> Result<IntegrationOperationReceipt> {
        let IntegrationOperationUpdate {
            expected_revision,
            phase,
            entity_ref,
            error,
            runtime_acceptance,
            observed_at_ms,
        } = update;
        let _lock = self.writer()?;
        self.verify_binding()?;
        let mut record = self
            .read_record(operation_id)?
            .context("integration operation not found")?;
        ensure!(
            record.receipt.revision == expected_revision,
            "integration operation revision conflict"
        );
        ensure!(
            record.receipt.phase.may_transition_to(phase),
            "invalid integration operation transition"
        );
        record.receipt.revision = expected_revision
            .checked_add(1)
            .context("integration operation revision overflow")?;
        record.receipt.phase = phase;
        if let Some(acceptance) = runtime_acceptance {
            if let Some(original) = &record.receipt.runtime_acceptance {
                ensure!(
                    original == &acceptance,
                    "native acceptance identity is immutable"
                );
            }
            record.receipt.runtime_acceptance = Some(acceptance);
        }
        // A corrected wall clock must not discard an authoritative outcome.
        record.receipt.updated_at_ms = observed_at_ms.max(record.receipt.updated_at_ms);
        if entity_ref.is_some() {
            record.receipt.entity_ref = entity_ref;
        }
        record.receipt.error = error;
        validate_record(&record)?;
        self.write_record(&record)?;
        Ok(record.receipt)
    }

    fn write_record(&self, record: &Record) -> Result<()> {
        validate_record(record)?;
        let bytes = serde_json::to_vec(record)?;
        ensure!(
            bytes.len() <= MAX_INTEGRATION_OPERATION_BYTES,
            "integration receipt exceeds storage bound"
        );
        self.directory.atomic_replace(
            OsStr::new(&record_name(&record.receipt.operation_id)?),
            &bytes,
        )
    }
}

fn validate_label(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.chars().count() <= 256,
        "invalid integration operation label"
    );
    Ok(())
}

fn read_binding(directory: &PrivateDirectory) -> Result<Binding> {
    let file = directory.open_single_link_regular_file(OsStr::new("owner.json"))?;
    let mut bytes = Vec::new();
    file.take(MAX_INTEGRATION_OPERATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_INTEGRATION_OPERATION_BYTES,
        "integration operation owner exceeds bound"
    );
    serde_json::from_slice(&bytes).context("invalid integration operation owner")
}

fn record_name(operation_id: &str) -> Result<String> {
    validate_label(operation_id)?;
    let mut hash = Sha256::new();
    hash.update(b"kcoder-integration-operation-v1\0");
    hash.update(operation_id.as_bytes());
    Ok(format!("op-{:x}.json", hash.finalize()))
}

pub(super) fn canonical(value: &Value, depth: usize) -> Result<Value> {
    ensure!(depth <= 64, "integration intent nesting exceeds bound");
    Ok(match value {
        Value::Object(map) => {
            let sorted = map
                .iter()
                .map(|(key, value)| Ok((key.clone(), canonical(value, depth + 1)?)))
                .collect::<Result<BTreeMap<_, _>>>()?;
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|v| canonical(v, depth + 1))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}

fn intent_digest(request: &IntegrationRequest, port: &str, method: &str) -> Result<String> {
    let mut scope = request.scope.clone();
    scope.organization_id = IntegrationOwner::from(&scope).organization_id;
    let intent = serde_json::json!({
        "version": 1, "scope": scope, "port": port, "method": method,
        "expectedRevision": request.expected_revision, "payload": request.payload
    });
    let bytes = serde_json::to_vec(&canonical(&intent, 0)?)?;
    ensure!(
        bytes.len() <= MAX_INTEGRATION_INTENT_BYTES,
        "integration intent exceeds bound"
    );
    let mut hash = Sha256::new();
    hash.update(b"kcoder-integration-intent-v1\0");
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_record(record: &Record) -> Result<()> {
    let r = &record.receipt;
    ensure!(
        record.version == 1,
        "unsupported integration operation record"
    );
    r.scope.validate()?;
    validate_label(&r.operation_id)?;
    validate_label(&r.port)?;
    validate_label(&r.method)?;
    ensure!(
        record.intent_sha256.len() == 64
            && record.intent_sha256.bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid integration intent identity"
    );
    ensure!(
        r.revision > 0 && r.updated_at_ms >= r.created_at_ms,
        "invalid integration operation revision"
    );
    if let Some(entity) = &r.entity_ref {
        validate_label(&entity.id)?;
        if let Some(revision) = &entity.revision {
            validate_label(revision)?;
        }
    }
    if let Some(error) = &r.error {
        error.validate()?;
    }
    if let Some(acceptance) = &r.runtime_acceptance {
        acceptance.validate()?;
        ensure!(
            r.port == "P-RUNTIME"
                && r.method == "acceptTask"
                && !matches!(
                    r.phase,
                    IntegrationOperationPhase::Pending
                        | IntegrationOperationPhase::Executing
                        | IntegrationOperationPhase::Rejected
                ),
            "native acceptance cannot be attached to an unaccepted operation"
        );
    }
    if matches!(
        r.phase,
        IntegrationOperationPhase::Rejected | IntegrationOperationPhase::Unknown
    ) {
        ensure!(
            r.error.is_some(),
            "unresolved or rejected operation requires an error"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
