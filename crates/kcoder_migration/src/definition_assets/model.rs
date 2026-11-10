use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, imported_context::ImportedContextScope};
use kcoder_types::{
    migration::MigrationSourceKind, migration_definitions::MigrationDefinitionReport,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoreBinding {
    pub(super) instance: String,
    pub(super) profile_identity: String,
    pub(super) parent_identity: String,
    pub(super) directory_identity: String,
    pub(super) birth: PortableLeaseIdentity,
    pub(super) lock: PortableLeaseIdentity,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DefinitionRecord {
    pub(crate) id: String,
    pub(crate) operation_id: String,
    pub(crate) name: String,
    pub(crate) scope: ImportedContextScope,
    pub(crate) source: MigrationSourceKind,
    pub(crate) source_revision: String,
    pub(crate) report: MigrationDefinitionReport,
    /// This is inert private source data, never installed as a script or an Engine prompt.
    pub(crate) data: String,
}
impl DefinitionRecord {
    pub(crate) fn digest(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.id.starts_with("def-")
                && self.id.len() == 36
                && self.operation_id.starts_with("plan-")
                && self.operation_id.len() == 37,
            "migration_definition_record_invalid"
        );
        ensure!(
            !self.name.trim().is_empty()
                && self.name.len() <= 256
                && !self.name.chars().any(char::is_control),
            "migration_definition_record_invalid"
        );
        ensure!(
            self.report.requires_review
                && !self.report.execution_allowed
                && self.report.fields.len() <= 1024,
            "migration_definition_record_invalid"
        );
        ensure!(
            self.report
                .fields
                .iter()
                .enumerate()
                .all(|(n, row)| row.ordinal == n as u32),
            "migration_definition_record_invalid"
        );
        ensure!(
            self.data.len() <= 6 * 1024 * 1024,
            "migration_definition_store_budget_exceeded"
        );
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    record_id: String,
    digest: String,
    pub(super) undone: bool,
}
impl Receipt {
    pub(super) fn new(record: &DefinitionRecord) -> Result<Self> {
        Ok(Self {
            record_id: record.id.clone(),
            digest: record.digest()?,
            undone: false,
        })
    }
    pub(super) fn check(&self, record: &DefinitionRecord) -> Result<()> {
        ensure!(
            self.record_id == record.id && self.digest == record.digest()?,
            "migration_receipt_conflict"
        );
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct State {
    pub(super) version: u32,
    pub(super) instance: String,
    pub(super) profile_identity: String,
    pub(super) records: BTreeMap<String, DefinitionRecord>,
    pub(super) receipts: BTreeMap<String, Receipt>,
}
impl State {
    pub(super) fn empty(instance: String, profile_identity: String) -> Self {
        Self {
            version: 1,
            instance,
            profile_identity,
            records: BTreeMap::new(),
            receipts: BTreeMap::new(),
        }
    }
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && self.records.len() <= 4096 && self.receipts.len() <= 8192,
            "migration_definition_store_invalid"
        );
        for (id, record) in &self.records {
            record.validate()?;
            ensure!(id == &record.id, "migration_definition_store_invalid");
            let receipt = self
                .receipts
                .get(&record.operation_id)
                .ok_or_else(|| anyhow::anyhow!("migration_definition_store_invalid"))?;
            receipt.check(record)?;
            ensure!(!receipt.undone, "migration_definition_store_invalid");
        }
        Ok(())
    }
}
