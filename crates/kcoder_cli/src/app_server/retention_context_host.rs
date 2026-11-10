//! Connection-side selection of the Engine workspace for retention authority capture.

use anyhow::Result;
use kcoder_engine::QueryEngine;

pub(crate) use kcoder_attachment_retention::retention_context::RetentionLaunchConfiguration;
pub(super) use kcoder_attachment_retention::retention_context::{
    VerifiedRetentionAuthority, has_private_authority,
};

pub(super) fn capture(
    configuration: RetentionLaunchConfiguration,
    engine: &QueryEngine,
) -> Result<VerifiedRetentionAuthority> {
    VerifiedRetentionAuthority::capture(
        configuration,
        &engine.cwd,
        engine.durable_client_storage_root().is_some(),
    )
}
