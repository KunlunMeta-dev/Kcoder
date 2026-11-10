//! Original remote-delegation intents and protocol receipts. This is not remote task state authority.
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
};

const HEADER: &str = "owner.json";
const LOCK: &str = "delegations.lock";
const DATA: &str = "delegations.json";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INTENT_BYTES: usize = 64 * 1024;
const MAX_RECORDS: usize = 4096;
mod cleanup;
mod endpoint_receipts;
pub use endpoint_receipts::NativeRemoteEndpointReceiverObservation;
mod native_launch;
pub use cleanup::NativeRemoteEndpointCleanupObservation;
pub use cleanup::NativeRemoteOwnerCleanupObservation;
mod receiver_receipts;
pub use native_launch::NativeRemoteLaunchSnapshot;
pub use receiver_receipts::NativeRemoteReceiverDiagnostic;
pub use receiver_receipts::{NativeRemoteAcceptedReceiver, NativeRemoteReceiverObservation};

/// Protocol stages are journal facts, never native task/business terminal states.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRemoteStage {
    Spawn,
    Initialize,
    BindOriginal,
    OwnerClose,
    Session,
    Prompt,
    InputTransfer,
    Cancel,
    OutputTransfer,
    Verify,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRemoteStageState {
    Dispatched,
    Received,
    Unknown,
}

/// Native-only admitted plan. The host must validate real current-local-task/receiver authority.
/// This value has no serde authority surface. Launch paths, environments and credentials do not belong here.
pub struct NativeRemotePlan {
    pub operation_id: String,
    pub scope: IntegrationScope,
    pub public_intent: Value,
    pub recipient_revision: String,
    pub recipient_identity: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    nonce: u64,
    body_sha256: String,
    state: NativeRemoteStageState,
    safe_receipt: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    operation_id: String,
    scope_at_creation: IntegrationScope,
    public_intent: Value,
    intent_sha256: String,
    recipient_revision: String,
    recipient_identity: Value,
    revision: u64,
    stages: BTreeMap<NativeRemoteStage, Stage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receiver: Option<NativeRemoteReceiverObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_launch_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receiver_private_witness: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_cleanup: Option<NativeRemoteOwnerCleanupObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint_cleanup: Option<NativeRemoteEndpointCleanupObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint_receiver: Option<NativeRemoteEndpointReceiverObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint_manifest: Option<kcoder_types::integrations::office::OfficeArtifactManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receiver_diagnostic: Option<NativeRemoteReceiverDiagnostic>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    version: u32,
    owner: IntegrationOwner,
    revision: u64,
    entries: BTreeMap<String, Record>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}

/// Read-only projection from original stored facts. Absence is not execution completion.
#[derive(Clone, Debug)]
pub struct NativeRemoteObservation {
    pub scope_at_creation: IntegrationScope,
    pub receiver_diagnostic: Option<NativeRemoteReceiverDiagnostic>,
    pub owner_cleanup: Option<NativeRemoteOwnerCleanupObservation>,
    pub endpoint_cleanup: Option<NativeRemoteEndpointCleanupObservation>,
    pub endpoint_receiver: Option<NativeRemoteEndpointReceiverObservation>,
    pub endpoint_manifest: Option<kcoder_types::integrations::office::OfficeArtifactManifest>,
    pub operation_id: String,
    pub public_intent: Value,
    pub intent_sha256: String,
    pub recipient_revision: String,
    pub recipient_identity: Value,
    pub revision: u64,
    pub stages: BTreeMap<NativeRemoteStage, NativeRemoteStageState>,
    pub safe_receipts: BTreeMap<NativeRemoteStage, Value>,
    pub receiver: Option<NativeRemoteReceiverObservation>,
}
impl From<&Record> for NativeRemoteObservation {
    fn from(record: &Record) -> Self {
        Self {
            scope_at_creation: record.scope_at_creation.clone(),
            receiver_diagnostic: record.receiver_diagnostic.clone(),
            owner_cleanup: record.owner_cleanup.clone(),
            endpoint_cleanup: record.endpoint_cleanup.clone(),
            endpoint_receiver: record.endpoint_receiver.clone(),
            endpoint_manifest: record.endpoint_manifest.clone(),
            operation_id: record.operation_id.clone(),
            public_intent: record.public_intent.clone(),
            intent_sha256: record.intent_sha256.clone(),
            recipient_revision: record.recipient_revision.clone(),
            recipient_identity: record.recipient_identity.clone(),
            revision: record.revision,
            receiver: record.receiver.clone(),
            stages: record
                .stages
                .iter()
                .map(|(stage, receipt)| (*stage, receipt.state))
                .collect(),
            safe_receipts: record
                .stages
                .iter()
                .filter_map(|(stage, receipt)| {
                    receipt.safe_receipt.clone().map(|value| (*stage, value))
                })
                .collect(),
        }
    }
}

/// Proof of a recorded original dispatch, retained only by its actual native owner.
/// It is not an execution grant and cannot be deserialized or reconstructed from metadata.
pub struct NativeRemoteDispatch {
    operation_id: String,
    stage: NativeRemoteStage,
    nonce: u64,
    directory_identity: String,
    owner: IntegrationOwner,
}

pub struct NativeRemoteDelegationStore {
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
}
impl std::fmt::Debug for NativeRemoteDelegationStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRemoteDelegationStore { original_namespace: bound }")
    }
}
impl NativeRemoteDelegationStore {
    /// Authorized first write only. Reads must call open_in and never initialize.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            version: 1,
            owner: IntegrationOwner::from(scope),
            directory_identity: directory.directory_identity()?,
            lock_identity: directory.portable_regular_handle_identity(&lock)?,
        };
        let data = Ledger {
            version: 1,
            owner: header.owner.clone(),
            revision: 1,
            entries: BTreeMap::new(),
        };
        directory.atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        Self::bind(parent, name, directory, scope)
    }
    /// Missing child returns None. Existing damage always fails closed without resetting records.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Self::bind(parent, name, entry.open_child_directory()?, scope).map(Some)
    }
    fn bind(
        parent: &PrivateDirectory,
        name: &OsStr,
        directory: PrivateDirectory,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        let header: Header = serde_json::from_slice(&read(&directory, HEADER, 8192)?)?;
        ensure!(
            header.owner == IntegrationOwner::from(scope),
            "REMOTE_JOURNAL_OWNER_MISMATCH"
        );
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let header_identity = directory.portable_regular_handle_identity(&header_anchor)?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.to_owned(),
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
        };
        store.load()?;
        Ok(store)
    }
    fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        let actual = self
            .parent
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        let header: Header = serde_json::from_slice(&read(&self.directory, HEADER, 8192)?)?;
        ensure!(
            header == self.header
                && header.version == 1
                && actual.directory_identity()? == header.directory_identity
                && self.directory.directory_identity()? == header.directory_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(HEADER))?
                    == self.header_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.header_anchor)?
                    == self.header_identity
                && self.directory.portable_regular_identity(OsStr::new(LOCK))?
                    == header.lock_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.lock_anchor)?
                    == header.lock_identity,
            "REMOTE_JOURNAL_CHANGED"
        );
        Ok(())
    }
    fn load(&self) -> Result<Ledger> {
        self.verify()?;
        let ledger: Ledger = serde_json::from_slice(&read(&self.directory, DATA, MAX_BYTES)?)?;
        ensure!(
            ledger.version == 1
                && ledger.owner == self.header.owner
                && ledger.entries.len() <= MAX_RECORDS,
            "REMOTE_JOURNAL_INVALID"
        );
        for (id, record) in &ledger.entries {
            record.scope_at_creation.validate()?;
            ensure!(
                record
                    .native_launch_sha256
                    .as_ref()
                    .is_none_or(|hash| hash.len() == 64
                        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())),
                "REMOTE_NATIVE_LAUNCH_INVALID"
            );
            if let Some(cleanup) = &record.owner_cleanup {
                ensure!(
                    cleanup.owned_pid > 0
                        && record
                            .stages
                            .get(&NativeRemoteStage::Spawn)
                            .and_then(|stage| stage.safe_receipt.as_ref())
                            .and_then(|receipt| receipt["ownedPid"].as_u64())
                            == Some(u64::from(cleanup.owned_pid)),
                    "REMOTE_ORIGINAL_CLEANUP_CHANGED"
                );
            }
            if let Some(cleanup) = &record.endpoint_cleanup {
                label(&cleanup.endpoint_instance_id)?;
                ensure!(
                    record.owner_cleanup.is_none()
                        && record
                            .stages
                            .get(&NativeRemoteStage::Spawn)
                            .and_then(|stage| stage.safe_receipt.as_ref())
                            .is_some_and(|receipt| receipt["ownedEndpointInstanceId"]
                                == cleanup.endpoint_instance_id
                                && receipt.get("ownedPid").is_none()),
                    "REMOTE_ORIGINAL_ENDPOINT_CHANGED"
                );
            }
            if let Some(witness) = &record.receiver_private_witness {
                ensure!(
                    record.receiver.is_some()
                        && witness.is_object()
                        && serde_json::to_vec(witness)?.len() <= 16 * 1024,
                    "REMOTE_RECEIVER_PRIVATE_WITNESS_INVALID"
                );
            }
            endpoint_receipts::validate_record(record)?;
            if let Some(receiver) = &record.receiver {
                receiver.identity.validate().map_err(anyhow::Error::msg)?;
                ensure!(
                    [
                        receiver.accepted_input_sha256.as_str(),
                        receiver.accepted_receipt_sha256.as_str()
                    ]
                    .iter()
                    .all(|hash| hash.len() == 64
                        && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
                        && record.stages.contains_key(&NativeRemoteStage::Prompt),
                    "REMOTE_RECEIVER_NATIVE_RECEIPT_INVALID"
                );
            }
            label(id)?;
            label(&record.recipient_revision)?;
            for stage in record.stages.values() {
                ensure!(
                    stage.nonce > 0
                        && stage.nonce <= ledger.revision
                        && stage.body_sha256.len() == 64
                        && stage
                            .body_sha256
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                        && (stage.state == NativeRemoteStageState::Received)
                            == stage.safe_receipt.is_some(),
                    "REMOTE_JOURNAL_INVALID"
                );
            }
            ensure!(
                id == &record.operation_id
                    && IntegrationOwner::from(&record.scope_at_creation) == ledger.owner
                    && digest(&record.public_intent)? == record.intent_sha256
                    && record.revision > 0,
                "REMOTE_JOURNAL_INVALID"
            );
        }
        self.verify()?;
        Ok(ledger)
    }
    fn mutate<T>(&self, action: impl FnOnce(&mut Ledger) -> Result<T>) -> Result<T> {
        self.verify()?;
        let _lock = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.header.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("REMOTE_JOURNAL_BUSY")?;
        let mut ledger = self.load()?;
        let before = ledger.revision;
        let result = action(&mut ledger)?;
        if ledger.revision != before {
            let bytes = serde_json::to_vec(&ledger)?;
            ensure!(bytes.len() as u64 <= MAX_BYTES, "REMOTE_JOURNAL_CAPACITY");
            self.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
        }
        self.verify()?;
        Ok(result)
    }
    pub fn storage_directory_identity(&self) -> Result<String> {
        self.verify()?;
        self.directory.directory_identity()
    }
    /// Freeze complete public intent once, separately from private native launch configuration.
    /// The returned bool distinguishes a new record from original-operation observation.
    pub fn begin(&self, plan: &NativeRemotePlan) -> Result<(NativeRemoteObservation, bool)> {
        plan.scope.validate()?;
        label(&plan.operation_id)?;
        label(&plan.recipient_revision)?;
        ensure!(
            IntegrationOwner::from(&plan.scope) == self.header.owner,
            "REMOTE_JOURNAL_OWNER_MISMATCH"
        );
        let hash = digest(&plan.public_intent)?;
        ensure!(
            serde_json::to_vec(&plan.recipient_identity)?.len() <= 8192,
            "REMOTE_PEER_METADATA_LIMIT"
        );
        self.mutate(|ledger| {
            if let Some(record) = ledger.entries.get(&plan.operation_id) {
                ensure!(
                    record.intent_sha256 == hash
                        && record.recipient_revision == plan.recipient_revision
                        && record.recipient_identity == plan.recipient_identity,
                    "REMOTE_OPERATION_INTENT_CONFLICT"
                );
                return Ok((record.into(), false));
            }
            ensure!(
                ledger.entries.len() < MAX_RECORDS,
                "REMOTE_JOURNAL_CAPACITY"
            );
            let record = Record {
                operation_id: plan.operation_id.clone(),
                scope_at_creation: plan.scope.clone(),
                public_intent: plan.public_intent.clone(),
                intent_sha256: hash,
                recipient_revision: plan.recipient_revision.clone(),
                recipient_identity: plan.recipient_identity.clone(),
                revision: 1,
                stages: BTreeMap::new(),
                receiver: None,
                native_launch_sha256: None,
                receiver_private_witness: None,
                owner_cleanup: None,
                endpoint_cleanup: None,
                endpoint_receiver: None,
                endpoint_manifest: None,
                receiver_diagnostic: None,
            };
            let observation = (&record).into();
            ledger.entries.insert(plan.operation_id.clone(), record);
            ledger.revision = next(ledger.revision)?;
            Ok((observation, true))
        })
    }
    /// Own-namespace observations only. This never initializes or replays work.
    pub fn recent(&self) -> Result<(Vec<NativeRemoteObservation>, usize)> {
        let ledger = self.load()?;
        let total = ledger.entries.len();
        let mut rows = ledger.entries.values().collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            right
                .revision
                .cmp(&left.revision)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        Ok((rows.into_iter().take(10).map(Into::into).collect(), total))
    }
    pub fn read(&self, operation: &str) -> Result<Option<NativeRemoteObservation>> {
        label(operation)?;
        Ok(self.load()?.entries.get(operation).map(Into::into))
    }
    /// Native host must recheck the actual operation/actor/current policy before calling this.
    /// Any previous dispatch, including unknown, prevents another execution attempt.
    pub fn before_dispatch(
        &self,
        operation: &str,
        scope: &IntegrationScope,
        stage: NativeRemoteStage,
        actual_intent: &Value,
    ) -> Result<NativeRemoteDispatch> {
        label(operation)?;
        scope.validate()?;
        let body = digest(actual_intent)?;
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                &record.scope_at_creation == scope,
                "REMOTE_ACTIVE_SCOPE_CHANGED"
            );
            ensure!(
                !record.stages.contains_key(&stage),
                "REMOTE_ALREADY_DISPATCHED_DO_NOT_REPLAY"
            );
            ensure!(
                !record.stages.contains_key(&NativeRemoteStage::OwnerClose),
                "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
            );
            let required = match stage {
                NativeRemoteStage::Spawn => None,
                NativeRemoteStage::Initialize => Some(NativeRemoteStage::Spawn),
                NativeRemoteStage::BindOriginal => Some(NativeRemoteStage::Initialize),
                NativeRemoteStage::Session => Some(NativeRemoteStage::Initialize),
                NativeRemoteStage::Prompt => Some(NativeRemoteStage::Session),
                NativeRemoteStage::InputTransfer => Some(NativeRemoteStage::Initialize),
                NativeRemoteStage::Cancel => Some(NativeRemoteStage::Session),
                NativeRemoteStage::OwnerClose => Some(NativeRemoteStage::Prompt),
                NativeRemoteStage::OutputTransfer | NativeRemoteStage::Verify => {
                    Some(NativeRemoteStage::Prompt)
                }
            };
            if let Some(required) = required {
                ensure!(
                    record
                        .stages
                        .get(&required)
                        .is_some_and(
                            |previous| previous.state == NativeRemoteStageState::Received
                                || (stage == NativeRemoteStage::OwnerClose
                                    && record.endpoint_receiver.is_some())
                        ),
                    "REMOTE_PREVIOUS_RECEIPT_REQUIRED"
                );
            }
            let nonce = next(ledger.revision)?;
            record.stages.insert(
                stage,
                Stage {
                    nonce,
                    body_sha256: body,
                    state: NativeRemoteStageState::Dispatched,
                    safe_receipt: None,
                },
            );
            record.revision = next(record.revision)?;
            ledger.revision = nonce;
            Ok(NativeRemoteDispatch {
                operation_id: operation.to_owned(),
                stage,
                nonce,
                directory_identity: self.header.directory_identity.clone(),
                owner: self.header.owner.clone(),
            })
        })
    }
    /// Settle only a retained original dispatch. This writes facts, never reauthorizes execution.
    pub fn receive(
        &self,
        dispatch: &NativeRemoteDispatch,
        safe_receipt: &Value,
    ) -> Result<NativeRemoteObservation> {
        ensure!(
            serde_json::to_vec(safe_receipt)?.len() <= 8192,
            "REMOTE_RECEIPT_LIMIT"
        );
        self.settle(dispatch, Some(safe_receipt))
    }
    pub fn unknown(&self, dispatch: &NativeRemoteDispatch) -> Result<NativeRemoteObservation> {
        self.settle(dispatch, None)
    }
    fn settle(
        &self,
        dispatch: &NativeRemoteDispatch,
        receipt: Option<&Value>,
    ) -> Result<NativeRemoteObservation> {
        ensure!(
            dispatch.owner == self.header.owner
                && dispatch.directory_identity == self.header.directory_identity,
            "REMOTE_DISPATCH_OWNER_CHANGED"
        );
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(&dispatch.operation_id)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            let stage = record
                .stages
                .get_mut(&dispatch.stage)
                .context("REMOTE_ORIGINAL_DISPATCH_MISSING")?;
            ensure!(stage.nonce == dispatch.nonce, "REMOTE_DISPATCH_CHANGED");
            if stage.state == NativeRemoteStageState::Received {
                ensure!(
                    receipt.is_none_or(|receipt| stage.safe_receipt.as_ref() == Some(receipt)),
                    "REMOTE_RECEIPT_CONFLICT"
                );
                return Ok((&*record).into());
            }
            stage.state = if receipt.is_some() {
                NativeRemoteStageState::Received
            } else {
                NativeRemoteStageState::Unknown
            };
            stage.safe_receipt = receipt.cloned();
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok((&*record).into())
        })
    }
}
fn label(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "REMOTE_IDENTIFIER_INVALID"
    );
    Ok(())
}
fn next(value: u64) -> Result<u64> {
    value
        .checked_add(1)
        .context("REMOTE_JOURNAL_REVISION_EXHAUSTED")
}
fn digest(value: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(&super::operation_store::canonical(value, 0)?)?;
    ensure!(bytes.len() <= MAX_INTENT_BYTES, "REMOTE_INTENT_LIMIT");
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    directory
        .open_single_link_regular_file(OsStr::new(name))?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "REMOTE_JOURNAL_CAPACITY");
    Ok(bytes)
}
#[cfg(test)]
mod tests;
