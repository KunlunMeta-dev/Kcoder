//! Owner-bound workspace resources shared by Agent definitions and Office consumers.
//! Legacy file names stay stable: ownership, leases and receipts must survive upgrades.
#[path = "office/actions.rs"]
mod actions;
#[path = "office/export_acknowledgements.rs"]
mod export_acknowledgements;
pub use export_acknowledgements::OfficeExportAcknowledgementIntent;
#[path = "office/application_receipts.rs"]
mod application_receipts;
#[path = "office/artifacts.rs"]
mod artifacts;
pub use application_receipts::{
    OfficeApplicationReconciliationProof, OfficeApplicationToolReceipt,
};
#[path = "office/application_effect_intents.rs"]
mod application_effect_intents;
pub use application_effect_intents::OfficeApplicationEffectIntent;
#[path = "office/canonical_sources.rs"]
mod canonical_sources;
pub use actions::OfficeActionRecord;
pub use canonical_sources::{OfficeCanonicalPreparation, OfficeCanonicalToolReceipt};
#[path = "office/assistants.rs"]
mod assistants;
#[path = "agent_definitions/catalog.rs"]
mod definitions;
#[path = "agent_definitions/expert_resources.rs"]
mod expert_resources;
#[path = "agent_definitions/expert_skills.rs"]
mod expert_skills;
pub use expert_resources::AgentResourceSnapshotExt;
pub use expert_skills::AgentSkillInstallation;
pub use kcoder_types::agent_definition::AgentResourceSnapshot;
#[path = "agent_definitions/experts.rs"]
mod experts;
#[path = "office/inputs.rs"]
mod inputs;
#[path = "office/projections.rs"]
mod projections;
#[cfg(test)]
#[path = "office/tests.rs"]
mod tests;
#[path = "office/verifications.rs"]
mod verifications;

use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::integrations::{core::IntegrationOwner, office::*};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

pub use inputs::{
    OfficeInputMetadata, OfficeInputReceipt, OfficeInputRecord, OfficeNativeInput,
    OfficeStoredInput,
};

const SNAPSHOT_LIMIT: usize = 8 * 1024 * 1024;
const MAX_OPERATIONS: usize = 1024;
const MAX_DRAFTS: usize = 64;
const MAX_VERSIONS: usize = 256;
const MAX_ARTIFACTS: usize = 1024;
const MAX_DATASETS: usize = 128;
const SNAPSHOT_NAME: &str = "office-state.json";
const HEADER_NAME: &str = "office-header.json";
const LOCK_NAME: &str = "office-state.lock";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreHeader {
    schema_version: u32,
    owner: IntegrationOwner,
    // Preserve historical placement without requiring the current directory to match it.
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredOperation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    intent_sha256: String,
    result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredArtifact {
    manifest: OfficeArtifactManifest,
    blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDataset {
    reference: OfficeArtifactRef,
    blob: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: u32,
    owner: IntegrationOwner,
    revision: u64,
    drafts: BTreeMap<String, AgentDefinitionDraft>,
    #[serde(default)]
    expert_packages: BTreeMap<String, AgentDefinitionPackage>,
    versions: BTreeMap<String, AgentDefinitionVersion>,
    adoptions: BTreeMap<String, OfficeAssistantAdoption>,
    artifacts: BTreeMap<String, StoredArtifact>,
    datasets: BTreeMap<String, StoredDataset>,
    inputs: BTreeMap<String, OfficeInputRecord>,
    operations: BTreeMap<String, StoredOperation>,
    #[serde(default)]
    projections: BTreeMap<String, OfficeContextProjection>,
    #[serde(default)]
    actions: BTreeMap<String, OfficeActionRecord>,
    #[serde(default)]
    verifications: BTreeMap<String, Vec<OfficeVerificationObservation>>,
    #[serde(default)]
    canonical_preparations: BTreeMap<String, OfficeCanonicalPreparation>,
    #[serde(default)]
    canonical_sources: BTreeMap<String, canonical_sources::StoredCanonicalSource>,
    #[serde(default)]
    canonical_tool_receipts: BTreeMap<String, OfficeCanonicalToolReceipt>,
    #[serde(default)]
    application_tool_receipts: BTreeMap<String, OfficeApplicationToolReceipt>,
    #[serde(default)]
    application_effect_intents: BTreeMap<String, OfficeApplicationEffectIntent>,
}
impl Snapshot {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.expert_packages.len() <= MAX_VERSIONS,
            "OFFICE_STORAGE_LIMIT"
        );
        for package in self.expert_packages.values() {
            experts::validate_package(package)?;
        }
        ensure!(
            self.drafts.len() <= MAX_DRAFTS
                && self.versions.len() <= MAX_VERSIONS
                && self.artifacts.len() <= MAX_ARTIFACTS
                && self.datasets.len() <= MAX_DATASETS
                && self.inputs.len() <= MAX_OPERATIONS
                && self.operations.len() <= MAX_OPERATIONS
                && self.actions.len() <= MAX_OPERATIONS
                && self.projections.len() <= 256,
            "OFFICE_STATE_CORRUPT"
        );
        ensure!(
            self.canonical_preparations.len() <= MAX_ARTIFACTS
                && self.canonical_sources.len() <= MAX_ARTIFACTS
                && self.canonical_tool_receipts.len() <= MAX_ARTIFACTS,
            "OFFICE_STATE_CORRUPT"
        );
        for (operation, receipt) in &self.canonical_tool_receipts {
            receipt.validate()?;
            ensure!(receipt.operation_id == *operation, "OFFICE_STATE_CORRUPT");
            if let Some(prepared) = self.canonical_preparations.get(operation) {
                ensure!(
                    receipt.session_id == prepared.task.thread_id,
                    "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
                );
            }
        }
        for (operation, prepared) in &self.canonical_preparations {
            prepared.validate()?;
            ensure!(
                prepared.operation_id == *operation && prepared.owner == self.owner,
                "OFFICE_STATE_CORRUPT"
            );
        }
        ensure!(
            self.application_tool_receipts.len() <= MAX_ARTIFACTS,
            "OFFICE_STATE_CORRUPT"
        );
        for (key, receipt) in &self.application_tool_receipts {
            receipt.validate()?;
            let manifest = &self
                .artifacts
                .get(key)
                .context("OFFICE_APPLICATION_RECEIPT_MISSING")?
                .manifest;
            ensure!(
                receipt.owner == self.owner
                    && receipt.task == manifest.task
                    && reference_key(&receipt.artifact) == *key
                    && receipt.content_sha256 == manifest.sha256
                    && receipt.source_references()? == manifest.source_refs,
                "OFFICE_STATE_CORRUPT"
            );
        }
        ensure!(
            self.application_effect_intents.len() <= MAX_OPERATIONS,
            "OFFICE_STATE_CORRUPT"
        );
        for receipt in self.application_tool_receipts.values() {
            receipt.verify_reconciliation_intent(self)?;
        }
        for (operation, intent) in &self.application_effect_intents {
            intent.validate()?;
            ensure!(
                intent.owner == self.owner && intent.effect_operation_id == *operation,
                "OFFICE_STATE_CORRUPT"
            );
        }
        for (key, source) in &self.canonical_sources {
            let manifest = &self
                .artifacts
                .get(key)
                .context("OFFICE_CANONICAL_BINDING_MISSING")?
                .manifest;
            source.descriptor.validate_for(manifest)?;
            ensure!(
                key == &reference_key(&source.descriptor.artifact),
                "OFFICE_STATE_CORRUPT"
            );
        }
        for (id, draft) in &self.drafts {
            draft.definition.validate()?;
            ensure!(
                id == &draft.definition.id && draft.owner == self.owner && draft.revision > 0,
                "OFFICE_STATE_CORRUPT"
            );
        }
        for (key, version) in &self.versions {
            version.definition.validate()?;
            ensure!(
                version.owner == self.owner
                    && key == &version_key(&version.definition.id, &version.version)
                    && version.definition_sha256
                        == digest(&serde_json::to_vec(&version.definition)?),
                "OFFICE_STATE_CORRUPT"
            );
        }
        for (key, record) in &self.artifacts {
            record.manifest.validate()?;
            let reference = OfficeArtifactRef {
                id: record.manifest.id.clone(),
                revision: record.manifest.revision,
            };
            ensure!(
                record.manifest.owner == self.owner
                    && key == &reference_key(&reference)
                    && (record.blob == format!("artifact-{key}.blob")
                        || record.blob == format!("content-{}.blob", record.manifest.sha256)),
                "OFFICE_STATE_CORRUPT"
            );
        }
        for (key, record) in &self.datasets {
            ensure!(
                record.reference.revision > 0
                    && key == &reference_key(&record.reference)
                    && record.blob == format!("dataset-{key}.json")
                    && record.sha256.len() == 64,
                "OFFICE_STATE_CORRUPT"
            );
        }
        for projection in self.projections.values() {
            projection.validate()?;
            ensure!(projection.owner == self.owner, "OFFICE_STATE_CORRUPT");
        }
        for (id, record) in &self.inputs {
            record.receipt.metadata.validate()?;
            ensure!(
                id == &record.receipt.input_id
                    && record.receipt.owner == self.owner
                    && matches!(
                        record.receipt.status.as_str(),
                        "pending" | "accepted" | "unknown"
                    ),
                "OFFICE_STATE_CORRUPT"
            );
            if record.receipt.status == "accepted" {
                ensure!(
                    record.native.is_some()
                        && record.receipt.bytes == Some(record.receipt.metadata.expected_bytes)
                        && record
                            .receipt
                            .sha256
                            .as_ref()
                            .is_some_and(|hash| hash.len() == 64),
                    "OFFICE_STATE_CORRUPT"
                );
            }
            if let Some(content) = &record.stored_content {
                content.validate_for(&record.receipt)?;
                ensure!(
                    record.native.as_ref().is_some_and(|native| native.path
                        == format!("office-input:{}:1", record.receipt.input_id)),
                    "OFFICE_STATE_CORRUPT"
                );
            }
        }
        for (key, observations) in &self.verifications {
            let artifact = self.artifacts.get(key).context("OFFICE_STATE_CORRUPT")?;
            ensure!(observations.len() <= 64, "OFFICE_STATE_CORRUPT");
            for (index, observation) in observations.iter().enumerate() {
                ensure!(
                    observation.reference.id == artifact.manifest.id
                        && observation.reference.revision == artifact.manifest.revision
                        && observation.content_sha256 == artifact.manifest.sha256
                        && observation.revision == index as u64 + 1,
                    "OFFICE_STATE_CORRUPT"
                );
            }
        }
        for (id, record) in &self.actions {
            ensure!(
                id == &record.operation_id
                    && matches!(
                        record.phase.as_str(),
                        "pending" | "executing" | "completed" | "rejected"
                    )
                    && (record.phase != "completed" || record.result.is_some()),
                "OFFICE_STATE_CORRUPT"
            );
        }
        Ok(())
    }
    fn empty(owner: IntegrationOwner) -> Self {
        Self {
            schema_version: 1,
            owner,
            revision: 0,
            drafts: BTreeMap::new(),
            expert_packages: BTreeMap::new(),
            versions: BTreeMap::new(),
            adoptions: BTreeMap::new(),
            artifacts: BTreeMap::new(),
            datasets: BTreeMap::new(),
            inputs: BTreeMap::new(),
            operations: BTreeMap::new(),
            projections: BTreeMap::new(),
            actions: BTreeMap::new(),
            verifications: BTreeMap::new(),
            canonical_preparations: BTreeMap::new(),
            canonical_sources: BTreeMap::new(),
            canonical_tool_receipts: BTreeMap::new(),
            application_tool_receipts: BTreeMap::new(),
            application_effect_intents: BTreeMap::new(),
        }
    }
}

/// The authenticated host chooses the directory and owner; neither grants permission.
pub struct ResourceStore {
    directory: PrivateDirectory,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    header_identity: PortableLeaseIdentity,
}

// Coordinate only acquisition. The protected transaction runs exactly once after this returns.
fn wait_for_existing_lock(
    directory: &PrivateDirectory,
    identity: &PortableLeaseIdentity,
    mode: PrivateLeaseMode,
    verify: impl Fn() -> Result<()>,
) -> Result<VerifiedPrivateLease> {
    // Synchronous readers leave room for their async owner's cancellation checks.
    let wait = match mode {
        PrivateLeaseMode::Exclusive => Duration::from_secs(1),
        PrivateLeaseMode::Shared => Duration::from_millis(100),
    };
    let deadline = Instant::now() + wait;
    loop {
        verify()?;
        if let Some(lease) =
            directory.try_existing_portable_lock(OsStr::new(LOCK_NAME), identity, mode)?
        {
            verify()?;
            return Ok(lease);
        }
        ensure!(Instant::now() < deadline, "OFFICE_STORE_BUSY");
        std::thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

impl ResourceStore {
    /// Change only the existing unsigned lock pin of this stopped publication.
    pub fn relocate_lock(
        &self,
        coordinator: &mut kcoder_config::storage::StorageCoordinator,
        published: &kcoder_config::storage::StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<()> {
        self.verify_pinned_header()?;
        crate::integrations::unsigned_writer_placement::place(
            crate::integrations::unsigned_writer_placement::Store::WorkspaceResources,
            &self.directory,
            &self.lock_identity,
            published,
            namespace,
            Some(coordinator),
        )?;
        self.verify_pinned_header()
    }

    /// Read-only reconciliation preserves original definitions and effect receipts.
    pub fn verify_lock_relocation(
        &self,
        published: &kcoder_config::storage::StoragePublishedComponent,
        namespace: &OsStr,
    ) -> Result<()> {
        self.verify_pinned_header()?;
        crate::integrations::unsigned_writer_placement::place(
            crate::integrations::unsigned_writer_placement::Store::WorkspaceResources,
            &self.directory,
            &self.lock_identity,
            published,
            namespace,
            None,
        )?;
        self.verify_pinned_header()
    }

    /// Explicit first-time initialization. Existing entries are never adopted or repaired.
    pub fn create(path: &Path, owner: IntegrationOwner) -> Result<Self> {
        valid_id(&owner.account_id)?;
        valid_id(&owner.target_id)?;
        let parent =
            PrivateDirectory::open_existing(path.parent().context("OFFICE_INVALID_STORE_PATH")?)?;
        Self::create_in(
            &parent,
            path.file_name().context("OFFICE_INVALID_STORE_PATH")?,
            owner,
        )
    }
    /// Native composition uses the already held namespace, never a reconstructed path.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        owner: IntegrationOwner,
    ) -> Result<Self> {
        valid_id(&owner.account_id)?;
        valid_id(&owner.target_id)?;
        let directory = parent.create_private_child(name)?;
        let lock_file = directory.open_read_write_file(OsStr::new(LOCK_NAME), true)?;
        let lock_identity = directory.portable_regular_handle_identity(&lock_file)?;
        let lease = wait_for_existing_lock(
            &directory,
            &lock_identity,
            PrivateLeaseMode::Exclusive,
            || directory.verify_private_directory(),
        )?;
        let snapshot = serde_json::to_vec(&Snapshot::empty(owner.clone()))?;
        directory.atomic_replace(OsStr::new(SNAPSHOT_NAME), &snapshot)?;
        let header = StoreHeader {
            schema_version: 1,
            owner: owner.clone(),
            directory_identity: directory.directory_identity()?,
            lock_identity: lock_identity.clone(),
        };
        directory.atomic_replace(OsStr::new(HEADER_NAME), &serde_json::to_vec(&header)?)?;
        let header_identity = directory.portable_regular_identity(OsStr::new(HEADER_NAME))?;
        drop(lease);
        Ok(Self {
            directory,
            owner,
            lock_identity,
            header_identity,
        })
    }
    pub fn open_existing(path: &Path, owner: IntegrationOwner) -> Result<Option<Self>> {
        let directory = match PrivateDirectory::open_existing(path) {
            Ok(directory) => directory,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        Self::from_directory(directory, owner).map(Some)
    }
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        owner: IntegrationOwner,
    ) -> Result<Option<Self>> {
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        Self::from_directory(entry.open_child_directory()?, owner).map(Some)
    }
    fn from_directory(directory: PrivateDirectory, owner: IntegrationOwner) -> Result<Self> {
        let bytes = read_directory_bytes(&directory, HEADER_NAME, 16 * 1024)?
            .context("OFFICE_HEADER_MISSING")?;
        let header: StoreHeader =
            serde_json::from_slice(&bytes).context("OFFICE_HEADER_CORRUPT")?;
        ensure!(
            header.schema_version == 1 && header.owner == owner,
            "OFFICE_OWNER_MISMATCH"
        );
        let header_identity = directory.portable_regular_identity(OsStr::new(HEADER_NAME))?;
        let store = Self {
            directory,
            owner,
            lock_identity: header.lock_identity,
            header_identity,
        };
        let _lock = store.lock(false)?;
        store.load()?;
        Ok(store)
    }
    pub fn storage_directory_identity(&self) -> Result<String> {
        let _lock = self.lock(false)?;
        self.load()?;
        self.directory.directory_identity()
    }
    pub fn owner(&self) -> &IntegrationOwner {
        &self.owner
    }
    fn lock(&self, exclusive: bool) -> Result<VerifiedPrivateLease> {
        wait_for_existing_lock(
            &self.directory,
            &self.lock_identity,
            if exclusive {
                PrivateLeaseMode::Exclusive
            } else {
                PrivateLeaseMode::Shared
            },
            || self.verify_pinned_header(),
        )
    }
    fn read_optional(&self, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
        read_directory_bytes(&self.directory, name, limit)
    }
    fn load(&self) -> Result<Snapshot> {
        self.verify_pinned_header()?;
        let bytes = self
            .read_optional(SNAPSHOT_NAME, SNAPSHOT_LIMIT)?
            .context("OFFICE_STATE_MISSING")?;
        let snapshot: Snapshot = serde_json::from_slice(&bytes).context("OFFICE_STATE_CORRUPT")?;
        ensure!(
            snapshot.schema_version == 1,
            "OFFICE_STATE_VERSION_UNSUPPORTED"
        );
        ensure!(snapshot.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        snapshot.validate()?;
        Ok(snapshot)
    }
    fn save(&self, snapshot: &Snapshot) -> Result<()> {
        self.verify_pinned_header()?;
        ensure!(snapshot.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let bytes = serde_json::to_vec(snapshot)?;
        ensure!(bytes.len() <= SNAPSHOT_LIMIT, "OFFICE_STORAGE_LIMIT");
        self.directory
            .atomic_replace(OsStr::new(SNAPSHOT_NAME), &bytes)?;
        self.verify_pinned_header()
    }
    fn verify_pinned_header(&self) -> Result<()> {
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new(HEADER_NAME))?
                == self.header_identity,
            "OFFICE_HEADER_REPLACED"
        );
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new(LOCK_NAME))?
                == self.lock_identity,
            "OFFICE_LOCK_REPLACED"
        );
        Ok(())
    }
    fn mutate<T: Serialize + DeserializeOwned>(
        &self,
        operation_id: &str,
        method: &str,
        input: &impl Serialize,
        change: impl FnOnce(&mut Snapshot) -> Result<T>,
    ) -> Result<T> {
        valid_id(operation_id)?;
        let intent = digest(&serde_json::to_vec(&(method, &self.owner, input))?);
        let _lock = self.lock(true)?;
        let mut snapshot = self.load()?;
        ensure!(
            !snapshot.actions.contains_key(operation_id),
            "OFFICE_OPERATION_CONFLICT"
        );
        if let Some(previous) = snapshot.operations.get(operation_id) {
            ensure!(
                previous.intent_sha256 == intent,
                "OFFICE_OPERATION_CONFLICT"
            );
            return serde_json::from_value(previous.result.clone())
                .context("OFFICE_RECEIPT_CORRUPT");
        }
        ensure!(
            snapshot.operations.len() < MAX_OPERATIONS,
            "OFFICE_RECEIPT_CAPACITY"
        );
        let output = change(&mut snapshot)?;
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .context("OFFICE_REVISION_OVERFLOW")?;
        snapshot.operations.insert(
            operation_id.into(),
            StoredOperation {
                method: Some(method.into()),
                intent_sha256: intent,
                result: serde_json::to_value(&output)?,
            },
        );
        self.save(&snapshot)?;
        Ok(output)
    }
    /// Read only receipts that belong to expert management. The generic Office
    /// receipt reader remains available to the Office host for business work.
    pub fn read_definition_operation(&self, operation_id: &str) -> Result<Option<Value>> {
        valid_id(operation_id)?;
        let _lock = self.lock(false)?;
        let snapshot = self.load()?;
        let Some(operation) = snapshot.operations.get(operation_id) else {
            return Ok(None);
        };
        match operation.method.as_deref() {
            Some(
                "assistant.saveDraft"
                | "assistant.saveVersion"
                | "assistant.archive"
                | "assistant.installExpert"
                | "assistant.copyExpert"
                | "assistant.deleteDraft"
                | "assistant.installSkill",
            ) => {}
            Some(_) => anyhow::bail!("OFFICE_POLICY_DENIED"),
            None => ensure!(
                legacy_definition_operation(&snapshot, operation)?,
                "OFFICE_RECONCILIATION_REQUIRED"
            ),
        }
        Ok(Some(operation.result.clone()))
    }
    pub fn read_operation(&self, operation_id: &str) -> Result<Option<Value>> {
        valid_id(operation_id)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .operations
            .get(operation_id)
            .map(|operation| operation.result.clone()))
    }
}
// Old snapshots did not retain methods. Only a matching original intent and
// the store owner prove that a receipt came from expert management.
fn legacy_definition_operation(snapshot: &Snapshot, operation: &StoredOperation) -> Result<bool> {
    if let Ok(draft) = serde_json::from_value::<AgentDefinitionDraft>(operation.result.clone()) {
        if draft.owner != snapshot.owner {
            return Ok(false);
        }
        let matches_intent = |expected: Option<u64>| -> Result<bool> {
            Ok(operation.intent_sha256
                == digest(&serde_json::to_vec(&(
                    "assistant.saveDraft",
                    &snapshot.owner,
                    (&draft.definition, expected),
                ))?))
        };
        return if draft.revision == 1 {
            Ok(matches_intent(None)? || matches_intent(Some(0))?)
        } else if draft.revision > 1 {
            matches_intent(Some(draft.revision - 1))
        } else {
            Ok(false)
        };
    }

    let Ok(saved) = serde_json::from_value::<AgentDefinitionVersion>(operation.result.clone())
    else {
        return Ok(false);
    };
    if saved.owner != snapshot.owner {
        return Ok(false);
    }
    let id = saved.definition.id.as_str();
    // Prior draft receipts preserve the expected revision used when publishing.
    let revisions = snapshot
        .drafts
        .get(id)
        .map(|draft| draft.revision)
        .into_iter()
        .chain(snapshot.operations.values().filter_map(|receipt| {
            if receipt.result.get("definition")?.get("id")?.as_str()? != id {
                return None;
            }
            receipt.result.get("revision")?.as_u64()
        }));
    for expected in revisions {
        if operation.intent_sha256
            == digest(&serde_json::to_vec(&(
                "assistant.saveVersion",
                &snapshot.owner,
                (id, &saved.version, expected),
            ))?)
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !id.trim().is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control),
        "OFFICE_INVALID_ID"
    );
    Ok(())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn version_key(id: &str, version: &str) -> String {
    digest(&serde_json::to_vec(&(id, version)).expect("string tuple serializes"))
}
fn reference_key(reference: &OfficeArtifactRef) -> String {
    digest(
        &serde_json::to_vec(&(reference.id.as_str(), reference.revision))
            .expect("reference serializes"),
    )
}
fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
fn read_directory_bytes(
    directory: &PrivateDirectory,
    name: &str,
    limit: usize,
) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "OFFICE_STORAGE_LIMIT");
    Ok(Some(bytes))
}
