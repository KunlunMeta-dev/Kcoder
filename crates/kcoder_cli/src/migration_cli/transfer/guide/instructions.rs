//! Explicit instruction grants use the original source child and normal received/batch journals.
use super::*;
#[path = "instructions/capture.rs"]
mod capture;
#[path = "instructions/mapping.rs"]
mod mapping;
#[path = "instructions/preview.rs"]
mod preview;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Capture {
    pub session_id: String,
    pub params: MigrationInstructionCaptureParams,
    pub dispatched: bool,
}

impl Guide {
    async fn instruction_client(&self) -> Result<runtime::Client> {
        self.scope(false).await?;
        let (base, authorization) = self.client.runtime_authority()?;
        let client = runtime::Client::connect(
            &base,
            &authorization,
            &self.rpc_marker,
            &self.draft.target.target_id,
            self.draft.target.workspace_path.as_deref(),
        )
        .await?;
        if let Err(error) = client.require(CAPABILITY_MIGRATION_INSTRUCTION_SOURCES_V1) {
            let _ = client.close().await;
            return Err(error);
        }
        Ok(client)
    }
}
