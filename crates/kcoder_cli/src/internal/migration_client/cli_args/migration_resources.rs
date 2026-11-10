//! Initial target storage limits are separate from source-read, parser and model budgets.
use anyhow::{Result, ensure};
use clap::Args;
use kcoder_types::migration_resource::MigrationResourceLimits;

#[derive(Debug, Clone, Default, Args)]
pub struct MigrationResourceArgs {
    /// Initial combined target payload byte limit; independent hard bounds still apply.
    #[arg(long, value_name = "BYTES")]
    pub resource_max_total_bytes: Option<u64>,
    /// Initial combined target payload file limit; does not change parser part limits.
    #[arg(long, value_name = "FILES")]
    pub resource_max_payload_files: Option<u32>,
    /// Minimum free target filesystem bytes required before managed writes.
    #[arg(long, value_name = "BYTES")]
    pub resource_min_free_bytes: Option<u64>,
    /// Minimum free target filesystem file nodes, where supported by the target.
    #[arg(long, value_name = "NODES")]
    pub resource_min_free_file_nodes: Option<u32>,
}

impl MigrationResourceArgs {
    pub fn limits(&self) -> Result<Option<MigrationResourceLimits>> {
        if self.resource_max_total_bytes.is_none()
            && self.resource_max_payload_files.is_none()
            && self.resource_min_free_bytes.is_none()
            && self.resource_min_free_file_nodes.is_none()
        {
            return Ok(None);
        }
        let mut limits = MigrationResourceLimits::default();
        if let Some(value) = self.resource_max_total_bytes {
            limits.max_total_bytes = value;
        }
        if let Some(value) = self.resource_max_payload_files {
            limits.max_payload_files = value;
        }
        if let Some(value) = self.resource_min_free_bytes {
            limits.min_free_bytes = value;
        }
        if let Some(value) = self.resource_min_free_file_nodes {
            limits.min_free_file_nodes = value;
        }
        ensure!(limits.is_supported(), "migration_invalid_resource_limits");
        Ok(Some(limits))
    }
}
