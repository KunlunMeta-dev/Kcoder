//! Private lifecycle metadata. None of these records accepts source paths or tool authority.
use anyhow::{Context, Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const VERSION: u8 = 2;
pub(super) const MAX_ARCHIVES: usize = 4096;
pub(super) const MAX_REFERENCES: usize = 16_384;
pub(super) const MAX_RESOURCES: usize = 256;
pub(super) const MAX_DOCUMENT: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveReferenceKind {
    ImportJob,
    Reinterpretation,
    BranchView,
    BranchChoice,
    BatchReference,
    AttachmentJob,
    LocalAttachment,
    Upload,
    Preparation,
    Continuation,
    NativeSession,
}

/// Native producers construct this from their verified immutable selection, never an RPC owner.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveReferenceOwner {
    pub(super) kind: ArchiveReferenceKind,
    pub(super) operation: String,
    pub(super) binding: String,
}
impl ArchiveReferenceOwner {
    pub fn new(kind: ArchiveReferenceKind, operation: &str, binding: &str) -> Result<Self> {
        operation_id(operation)?;
        digest(binding)?;
        Ok(Self {
            kind,
            operation: operation.into(),
            binding: binding.into(),
        })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveReferenceReceipt {
    pub(super) scope: String,
    pub(super) reference_id: String,
    pub(super) owner: ArchiveReferenceOwner,
    #[serde(deserialize_with = "bounded_archives")]
    pub(super) archives: Vec<String>,
    pub(super) fingerprint: String,
}
fn bounded_archives<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Vec<String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a bounded array of archive identities")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<String>()? {
                if values.len() == MAX_RESOURCES || archive_id(&value).is_err() {
                    return Err(serde::de::Error::custom(
                        "external_history_lifecycle_budget_exceeded",
                    ));
                }
                values.push(value);
            }
            Ok(values)
        }
    }
    deserializer.deserialize_seq(Visitor)
}
impl std::fmt::Debug for ArchiveReferenceReceipt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchiveReferenceReceipt")
            .finish_non_exhaustive()
    }
}
impl ArchiveReferenceReceipt {
    pub fn matches_owner(
        &self,
        kind: ArchiveReferenceKind,
        operation: &str,
        binding: &str,
    ) -> bool {
        self.owner.kind == kind
            && self.owner.operation == operation
            && self.owner.binding == binding
    }
    pub fn archive_ids(&self) -> &[String] {
        &self.archives
    }
    pub fn contains_archive(&self, archive: &str) -> bool {
        self.archives.iter().any(|id| id == archive)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ArchivePhase {
    Reserved,
    Active,
    Retiring,
    Retired,
    Collected,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Archive {
    pub id: String,
    pub snapshot: String,
    pub generation: String,
    pub creator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_budget: Option<super::resource_budget::ResourceBudgetReference>,
    pub phase: ArchivePhase,
    pub directory: Option<String>,
    pub lease: PortableLeaseIdentity,
    pub receipt: Option<String>,
    pub retirement: Option<String>,
    #[serde(default)]
    pub baseline: Option<super::gc::Manifest>,
    #[serde(default)]
    pub derived: BTreeMap<String, super::derived::Derived>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_tree: Option<super::payload::PayloadAnchor>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub operation: String,
    pub snapshot: String,
    pub archive: String,
    pub reference_id: String,
    pub retired: bool,
    #[serde(default)]
    pub retirement: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reference {
    pub receipt: ArchiveReferenceReceipt,
    pub released: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveRetirementPhase {
    Prepared,
    Blocked,
    Retired,
    Collecting,
    Collected,
    Cancelled,
    OutcomeUnknown,
}
pub struct ArchiveRetirementView {
    pub operation_id: String,
    pub source_operation_id: String,
    pub archive_id: String,
    pub sequence: u64,
    pub phase: ArchiveRetirementPhase,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub owns_archive: bool,
    pub logical_retired: bool,
    pub retained_references: u64,
    pub collected_bytes: u64,
    pub failure_code: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Retirement {
    pub operation: String,
    pub request: String,
    pub archive: String,
    pub fingerprint: String,
    pub sequence: u64,
    pub phase: ArchiveRetirementPhase,
    pub cancel_revision: u64,
    pub acknowledged: u64,
    pub quarantine: Option<String>,
    pub removed_bytes: u64,
    pub tombstone: Option<String>,
    #[serde(default)]
    pub quarantined: bool,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub pending: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_plan: Option<super::payload::PayloadPlanAnchor>,
    #[serde(default)]
    pub payload_previous: Vec<super::payload::PayloadPlanAnchor>,
    #[serde(default)]
    pub payload_removed_bytes: u64,
    #[serde(default)]
    pub payload_removed_nodes: u32,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<super::retire::ExecutionAnchor>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Document {
    pub version: u8,
    pub scope: String,
    pub directory: String,
    pub mutation: PortableLeaseIdentity,
    pub sequence: u64,
    pub archives: BTreeMap<String, Archive>,
    pub requests: BTreeMap<String, Request>,
    pub references: BTreeMap<String, Reference>,
    pub retirements: BTreeMap<String, Retirement>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resource_groups: BTreeMap<String, super::resource_budget::Group>,
}
impl Document {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == VERSION
                && self.archives.len() <= MAX_ARCHIVES
                && self.requests.len() <= MAX_REFERENCES
                && self.references.len() <= MAX_REFERENCES
                && self.retirements.len() <= MAX_REFERENCES,
            "external_history_lifecycle_budget_exceeded"
        );
        digest(&self.scope)?;
        ensure!(
            self.resource_groups.len() <= MAX_ARCHIVES,
            "history_resource_metadata_budget_exceeded"
        );
        let mut charges = 0usize;
        let mut budget_members = std::collections::BTreeSet::new();
        for (key, group) in &self.resource_groups {
            group.validate(&self.scope, key)?;
            for member in group.member_ids() {
                ensure!(
                    budget_members.insert(member),
                    "history_resource_member_already_bound"
                );
            }
            charges = charges
                .checked_add(group.charge_count())
                .context("history_resource_metadata_budget_exceeded")?;
            ensure!(
                charges <= MAX_REFERENCES,
                "history_resource_metadata_budget_exceeded"
            );
        }
        for (id, archive) in &self.archives {
            archive_id(id)?;
            ensure!(id == &archive.id, "external_history_lifecycle_changed");
            digest(&archive.snapshot)?;
            operation_id(&archive.creator)?;
            ensure!(
                uuid::Uuid::parse_str(&archive.generation)
                    .is_ok_and(|id| id.to_string() == archive.generation),
                "external_history_lifecycle_changed"
            );
            ensure!(
                id == &format!(
                    "archive-{}",
                    super::hash(&("managed-archive/v2", &archive.snapshot, &archive.generation))?
                ),
                "external_history_lifecycle_changed"
            );
            if let Some(receipt) = &archive.receipt {
                digest(receipt)?;
            }
            if let Some(retirement) = &archive.retirement {
                operation_id(retirement)?;
            }
            if let Some(baseline) = &archive.baseline {
                baseline.validate()?;
            }
            ensure!(
                archive.derived.len() <= 64,
                "external_history_lifecycle_budget_exceeded"
            );
            for (name, derived) in &archive.derived {
                ensure!(name == &derived.name, "external_history_derived_changed");
                derived.validate()?;
            }
            ensure!(
                archive.phase == ArchivePhase::Reserved || archive.directory.is_some(),
                "external_history_lifecycle_changed"
            );
        }
        for (key, request) in &self.requests {
            operation_id(&request.operation)?;
            ensure!(
                key == &super::hash(&request.operation)?,
                "external_history_lifecycle_changed"
            );
            digest(&request.snapshot)?;
            digest(&request.reference_id)?;
            ensure!(
                self.references
                    .get(&request.reference_id)
                    .is_some_and(|reference| reference.receipt.owner.operation
                        == request.operation
                        && reference.receipt.archives.contains(&request.archive)),
                "external_history_lifecycle_changed"
            );
            ensure!(
                !request.retired || self.references[&request.reference_id].released,
                "external_history_lifecycle_changed"
            );
            ensure!(
                self.archives
                    .get(&request.archive)
                    .is_some_and(|archive| archive.snapshot == request.snapshot),
                "external_history_lifecycle_changed"
            );
            if let Some(id) = &request.retirement {
                ensure!(
                    self.retirements
                        .get(id)
                        .is_some_and(|entry| entry.request == request.operation
                            && entry.archive == request.archive
                            && request.retired == entry.tombstone.is_some()),
                    "external_history_lifecycle_changed"
                );
            }
        }
        for (id, reference) in &self.references {
            let receipt = &reference.receipt;
            ensure!(
                receipt.scope == self.scope
                    && receipt.reference_id == *id
                    && !receipt.archives.is_empty()
                    && receipt.archives.len() <= MAX_RESOURCES,
                "external_history_lifecycle_changed"
            );
            operation_id(&receipt.owner.operation)?;
            digest(&receipt.owner.binding)?;
            digest(&receipt.fingerprint)?;
            ensure!(
                reference.released
                    || receipt.archives.iter().all(|id| self
                        .archives
                        .get(id)
                        .is_some_and(|archive| archive.phase != ArchivePhase::Collected)),
                "external_history_lifecycle_changed"
            );
            ensure!(
                receipt.reference_id
                    == super::hash(&(receipt.owner.kind, &receipt.owner.operation))?
                    && receipt.fingerprint
                        == super::hash(&(&self.scope, &receipt.owner, &receipt.archives))?,
                "external_history_lifecycle_changed"
            );
            ensure!(
                receipt.archives.windows(2).all(|pair| pair[0] < pair[1])
                    && receipt
                        .archives
                        .iter()
                        .all(|id| self.archives.contains_key(id)),
                "external_history_lifecycle_changed"
            );
        }
        for (id, retirement) in &self.retirements {
            operation_id(id)?;
            ensure!(
                id == &retirement.operation
                    && self.archives.contains_key(&retirement.archive)
                    && retirement.acknowledged <= retirement.cancel_revision,
                "external_history_lifecycle_changed"
            );
            operation_id(&retirement.request)?;
            digest(&retirement.fingerprint)?;
            if let Some(execution) = &retirement.execution {
                digest(&execution.birth_sha256)?;
            }
            if let Some(tombstone) = &retirement.tombstone {
                digest(tombstone)?;
            }
            ensure!(
                retirement
                    .quarantine
                    .as_ref()
                    .is_none_or(|name| super::hash(&retirement.operation)
                        .is_ok_and(|digest| name == &format!("retired-{digest}")))
                    && retirement.removed.len() <= 16 + 64 * 17
                    && retirement.removed.windows(2).all(|pair| pair[0] < pair[1])
                    && self
                        .requests
                        .get(&super::hash(&retirement.request)?)
                        .is_some_and(|request| request.retirement.as_deref() == Some(id)
                            && request.archive == retirement.archive),
                "external_history_lifecycle_changed"
            );
            ensure!(
                retirement.payload_previous.len() <= 16,
                "external_history_payload_metadata_budget_exceeded"
            );
            for anchor in retirement
                .payload_previous
                .iter()
                .chain(retirement.payload_plan.iter())
            {
                ensure!(
                    uuid::Uuid::parse_str(&anchor.generation)
                        .is_ok_and(|id| id.to_string() == anchor.generation)
                        && anchor.directory.len() <= 256
                        && anchor.nodes <= 14_098
                        && anchor.metadata_bytes <= 64 * 1024 * 1024,
                    "external_history_payload_plan_changed"
                );
                digest(&anchor.digest)?;
            }
            let reserved = retirement
                .payload_previous
                .iter()
                .chain(retirement.payload_plan.iter())
                .try_fold(0u64, |bytes, anchor| {
                    bytes.checked_add(anchor.metadata_bytes)
                })
                .context("external_history_payload_metadata_budget_exceeded")?;
            ensure!(
                reserved <= 64 * 1024 * 1024,
                "external_history_payload_metadata_budget_exceeded"
            );
            ensure!(
                retirement.payload_plan.as_ref().map_or(
                    retirement.payload_removed_nodes == 0 && retirement.payload_removed_bytes == 0,
                    |anchor| retirement.payload_removed_nodes <= anchor.nodes
                        && retirement.payload_removed_bytes <= 24 * 1024 * 1024 * 1024
                ),
                "external_history_payload_progress_changed"
            );
            if !retirement.removed.is_empty() || retirement.pending.is_some() {
                let entries = self.archives[&retirement.archive].collection_entries()?;
                ensure!(
                    retirement
                        .removed
                        .iter()
                        .all(|name| entries.contains_key(name))
                        && retirement
                            .pending
                            .as_ref()
                            .is_none_or(|name| entries.contains_key(name)),
                    "external_history_lifecycle_changed"
                );
                ensure!(
                    retirement.removed_bytes
                        == retirement
                            .removed
                            .iter()
                            .map(|name| entries[name])
                            .sum::<u64>(),
                    "external_history_lifecycle_changed"
                );
            } else {
                ensure!(
                    retirement.removed_bytes == 0,
                    "external_history_lifecycle_changed"
                );
            }
        }
        Ok(())
    }
}
pub(super) fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "external_history_lifecycle_invalid_identity"
    );
    Ok(())
}
pub(super) fn operation_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "external_history_lifecycle_invalid_operation"
    );
    Ok(())
}
pub(super) fn archive_id(value: &str) -> Result<()> {
    digest(
        value
            .strip_prefix("archive-")
            .ok_or_else(|| anyhow::anyhow!("external_history_lifecycle_invalid_identity"))?,
    )
}
