//! Private accounting facts. Reservations retain their charge until an explicit native outcome.
use super::*;
use std::collections::BTreeMap;
mod policy;
mod streaming;
pub use policy::{ResourcePolicyObservation, ResourcePolicyReceipt};

pub(super) const MAX_CHARGES: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceBudgetReference {
    pub(super) scope: String,
    pub(super) group: String,
    pub(super) owner: String,
    pub(super) binding: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Archive,
    EmbeddedAttachment,
    LocalAttachment,
    DerivedIndex,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceCharge {
    pub member: String,
    pub kind: ResourceKind,
    pub identity: String,
    pub maximum_bytes: u64,
    pub maximum_files: u32,
}
impl ResourceCharge {
    fn key(&self) -> Result<String> {
        super::hash(&(&self.member, self.kind, &self.identity))
    }
    fn validate(&self) -> Result<()> {
        operation_id(&self.member)?;
        digest(&self.identity)?;
        ensure!(
            self.identity
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "history_resource_invalid_charge"
        );
        ensure!(
            self.maximum_bytes <= MAX_MIGRATION_RESOURCE_BYTES
                && self.maximum_files > 0
                && self.maximum_files <= MAX_MIGRATION_RESOURCE_FILES,
            "history_resource_invalid_charge"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceReservation {
    pub(super) budget: ResourceBudgetReference,
    pub(super) key: String,
    pub(super) charge: ResourceCharge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceOutcome {
    Reserved,
    Streaming {
        bytes: u64,
    },
    Committed {
        bytes: u64,
        files: u32,
        receipt_sha256: String,
    },
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceBudgetUsage {
    pub limits: MigrationResourceLimits,
    pub reserved_bytes: u64,
    pub committed_bytes: u64,
    pub reserved_files: u32,
    pub committed_files: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChargeRecord {
    charge: ResourceCharge,
    outcome: ResourceOutcome,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    streaming: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Group {
    reference: ResourceBudgetReference,
    limits: MigrationResourceLimits,
    members: Vec<String>,
    entries: BTreeMap<String, ChargeRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    policy_changes: Vec<ResourcePolicyReceipt>,
}

pub(super) fn validate_limits(limits: &MigrationResourceLimits) -> Result<()> {
    ensure!(limits.is_supported(), "history_resource_invalid_limits");
    Ok(())
}

impl Group {
    pub(crate) fn charge_count(&self) -> usize {
        self.entries.len()
    }
    pub(crate) fn member_ids(&self) -> &[String] {
        &self.members
    }
    pub(crate) fn contains_member(&self, operation: &str) -> bool {
        self.members
            .binary_search_by(|member| member.as_str().cmp(operation))
            .is_ok()
    }
    pub(super) fn overlaps_members(&self, other: &Self) -> bool {
        self.members
            .iter()
            .any(|member| other.members.binary_search(member).is_ok())
    }
    pub(super) fn new(
        scope: &str,
        owner: &str,
        mut members: Vec<String>,
        limits: MigrationResourceLimits,
    ) -> Result<Self> {
        validate_limits(&limits)?;
        digest(scope)?;
        operation_id(owner)?;
        members.sort();
        ensure!(
            !members.is_empty()
                && members.len() <= 64
                && !members.windows(2).any(|pair| pair[0] == pair[1]),
            "history_resource_invalid_members"
        );
        for member in &members {
            operation_id(member)?;
        }
        let reference = ResourceBudgetReference {
            scope: scope.into(),
            group: super::hash(&("history-resource-group/v1", scope, owner))?,
            owner: owner.into(),
            binding: super::hash(&(&limits, &members))?,
        };
        Ok(Self {
            reference,
            limits,
            members,
            entries: BTreeMap::new(),
            policy_changes: Vec::new(),
        })
    }
    pub(super) fn baseline_limits(&self) -> &MigrationResourceLimits {
        &self.limits
    }
    pub(in crate::external_history::lifecycle) fn reference(&self) -> &ResourceBudgetReference {
        &self.reference
    }
    pub(crate) fn validate(&self, scope: &str, key: &str) -> Result<()> {
        let expected = Self::new(
            scope,
            &self.reference.owner,
            self.members.clone(),
            self.limits.clone(),
        )?;
        ensure!(
            expected.reference == self.reference
                && expected.members == self.members
                && self.reference.group == key
                && self.entries.len() <= MAX_CHARGES,
            "history_resource_binding_changed"
        );
        for (key, entry) in &self.entries {
            entry.charge.validate()?;
            ensure!(
                self.members.contains(&entry.charge.member) && entry.charge.key()? == *key,
                "history_resource_binding_changed"
            );
            ensure!(
                !entry.streaming || entry.charge.kind != ResourceKind::Archive,
                "history_resource_reservation_mode_changed"
            );
            match entry.outcome {
                ResourceOutcome::Reserved => ensure!(
                    !entry.streaming,
                    "history_resource_reservation_mode_changed"
                ),
                ResourceOutcome::Streaming { bytes } => ensure!(
                    entry.streaming && bytes <= entry.charge.maximum_bytes,
                    "history_resource_reservation_changed"
                ),
                _ => {}
            }
            if let ResourceOutcome::Committed {
                bytes,
                files,
                receipt_sha256,
            } = &entry.outcome
            {
                digest(receipt_sha256)?;
                ensure!(
                    *bytes <= entry.charge.maximum_bytes
                        && *files > 0
                        && *files <= entry.charge.maximum_files,
                    "history_resource_receipt_changed"
                );
            }
        }
        self.validate_policy()?;
        self.usage()?;
        Ok(())
    }
    pub(super) fn require(&self, reference: &ResourceBudgetReference) -> Result<()> {
        ensure!(self.reference == *reference, "history_resource_wrong_scope");
        Ok(())
    }
    pub(super) fn usage(&self) -> Result<ResourceBudgetUsage> {
        let mut usage = ResourceBudgetUsage {
            limits: self.effective_limits().clone(),
            reserved_bytes: 0,
            committed_bytes: 0,
            reserved_files: 0,
            committed_files: 0,
        };
        for entry in self.entries.values() {
            match entry.outcome {
                ResourceOutcome::Reserved | ResourceOutcome::Streaming { .. } => {
                    let bytes = match entry.outcome {
                        ResourceOutcome::Streaming { bytes } => bytes,
                        _ => entry.charge.maximum_bytes,
                    };
                    usage.reserved_bytes = usage
                        .reserved_bytes
                        .checked_add(bytes)
                        .context("history_resource_budget_exceeded")?;
                    usage.reserved_files = usage
                        .reserved_files
                        .checked_add(entry.charge.maximum_files)
                        .context("history_resource_file_budget_exceeded")?;
                }
                ResourceOutcome::Committed { bytes, files, .. } => {
                    usage.committed_bytes = usage
                        .committed_bytes
                        .checked_add(bytes)
                        .context("history_resource_budget_exceeded")?;
                    usage.committed_files = usage
                        .committed_files
                        .checked_add(files)
                        .context("history_resource_file_budget_exceeded")?;
                }
                ResourceOutcome::Abandoned => {}
            }
        }
        ensure!(
            usage
                .reserved_bytes
                .checked_add(usage.committed_bytes)
                .is_some_and(|total| total <= self.effective_limits().max_total_bytes),
            "history_resource_budget_exceeded"
        );
        ensure!(
            usage
                .reserved_files
                .checked_add(usage.committed_files)
                .is_some_and(|total| total <= self.effective_limits().max_payload_files),
            "history_resource_file_budget_exceeded"
        );
        Ok(usage)
    }
    pub(super) fn existing(
        &self,
        charge: &ResourceCharge,
    ) -> Result<Option<(ResourceReservation, ResourceOutcome)>> {
        charge.validate()?;
        ensure!(
            self.members.contains(&charge.member),
            "history_resource_member_not_authorized"
        );
        let key = charge.key()?;
        let Some(entry) = self.entries.get(&key) else {
            return Ok(None);
        };
        ensure!(
            entry.charge == *charge,
            "history_resource_reservation_changed"
        );
        Ok(Some((
            ResourceReservation {
                budget: self.reference.clone(),
                key,
                charge: charge.clone(),
            },
            entry.outcome.clone(),
        )))
    }
    pub(super) fn reserve(
        &mut self,
        charge: ResourceCharge,
        space: AvailableStorage,
    ) -> Result<(ResourceReservation, ResourceOutcome, bool)> {
        charge.validate()?;
        ensure!(
            self.members.contains(&charge.member),
            "history_resource_member_not_authorized"
        );
        let key = charge.key()?;
        let reservation = ResourceReservation {
            budget: self.reference.clone(),
            key: key.clone(),
            charge: charge.clone(),
        };
        if let Some(existing) = self.entries.get(&key) {
            ensure!(
                !existing.streaming,
                "history_resource_reservation_mode_changed"
            );
            ensure!(
                existing.charge == charge,
                "history_resource_reservation_changed"
            );
            ensure!(
                existing.outcome != ResourceOutcome::Abandoned,
                "history_resource_reservation_abandoned"
            );
            return Ok((reservation, existing.outcome.clone(), false));
        }
        ensure!(
            self.entries.len() < MAX_CHARGES,
            "history_resource_metadata_budget_exceeded"
        );
        let before = self.usage()?;
        ensure!(
            before
                .reserved_bytes
                .checked_add(before.committed_bytes)
                .and_then(|sum| sum.checked_add(charge.maximum_bytes))
                .is_some_and(|sum| sum <= self.effective_limits().max_total_bytes),
            "history_resource_budget_exceeded"
        );
        ensure!(
            before
                .reserved_files
                .checked_add(before.committed_files)
                .and_then(|sum| sum.checked_add(charge.maximum_files))
                .is_some_and(|sum| sum <= self.effective_limits().max_payload_files),
            "history_resource_file_budget_exceeded"
        );
        ensure!(
            before
                .reserved_bytes
                .checked_add(charge.maximum_bytes)
                .and_then(|sum| sum.checked_add(self.effective_limits().min_free_bytes))
                .is_some_and(|needed| space.bytes >= needed),
            "history_resource_disk_space_insufficient"
        );
        if let Some(nodes) = space.file_nodes {
            let needed = u64::from(before.reserved_files)
                + u64::from(charge.maximum_files)
                + u64::from(self.effective_limits().min_free_file_nodes);
            ensure!(nodes >= needed, "history_resource_disk_nodes_insufficient");
        }
        self.entries.insert(
            key,
            ChargeRecord {
                charge,
                outcome: ResourceOutcome::Reserved,
                streaming: false,
            },
        );
        Ok((reservation, ResourceOutcome::Reserved, true))
    }
    fn entry(&mut self, reservation: &ResourceReservation) -> Result<&mut ChargeRecord> {
        self.require(&reservation.budget)?;
        let entry = self
            .entries
            .get_mut(&reservation.key)
            .context("history_resource_reservation_missing")?;
        ensure!(
            entry.charge == reservation.charge,
            "history_resource_reservation_changed"
        );
        Ok(entry)
    }
    pub(super) fn outcome(&self, reservation: &ResourceReservation) -> Result<ResourceOutcome> {
        self.require(&reservation.budget)?;
        let entry = self
            .entries
            .get(&reservation.key)
            .context("history_resource_reservation_missing")?;
        ensure!(
            entry.charge == reservation.charge,
            "history_resource_reservation_changed"
        );
        Ok(entry.outcome.clone())
    }
    pub(super) fn settle(
        &mut self,
        reservation: &ResourceReservation,
        bytes: u64,
        files: u32,
        receipt_sha256: &str,
    ) -> Result<bool> {
        digest(receipt_sha256)?;
        let entry = self.entry(reservation)?;
        ensure!(
            bytes <= entry.charge.maximum_bytes && files > 0 && files <= entry.charge.maximum_files,
            "history_resource_receipt_changed"
        );
        let next = ResourceOutcome::Committed {
            bytes,
            files,
            receipt_sha256: receipt_sha256.into(),
        };
        if entry.outcome == next {
            return Ok(false);
        }
        ensure!(
            match entry.outcome {
                ResourceOutcome::Reserved => !entry.streaming,
                ResourceOutcome::Streaming { bytes: reserved } =>
                    entry.streaming && bytes <= reserved,
                _ => false,
            },
            "history_resource_receipt_changed"
        );
        entry.outcome = next;
        Ok(true)
    }
    pub(super) fn abandon(&mut self, reservation: &ResourceReservation) -> Result<bool> {
        let entry = self.entry(reservation)?;
        if entry.outcome == ResourceOutcome::Abandoned {
            return Ok(false);
        }
        ensure!(
            matches!(
                entry.outcome,
                ResourceOutcome::Reserved | ResourceOutcome::Streaming { .. }
            ),
            "history_resource_already_committed"
        );
        entry.outcome = ResourceOutcome::Abandoned;
        Ok(true)
    }
}
