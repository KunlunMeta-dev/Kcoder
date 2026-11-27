use super::*;
use crate::batch::ReceivedBatchBinding;
use kcoder_types::migration::MigrationSourceKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceivedProjectMapping {
    CurrentWorkspace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedAdoptionSelection {
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mapping: Option<ReceivedProjectMapping>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceivedAdoptionPhase {
    Prepared,
    Scanning,
    PreviewReady,
    CancelRequested,
    Cancelled,
    Interrupted,
    Failed,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceivedAdoptionWorkerState {
    Running,
    Stopped,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedAdoptionControl {
    pub sequence: u64,
    pub cancel_watermark: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceivedAdoptionScope {
    User,
    CurrentWorkspace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedAdoptionJob {
    pub source: MigrationSourceKind,
    pub job_id: String,
    pub target_scope: ReceivedAdoptionScope,
    pub preview_ready: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedAdoptionState {
    pub adoption_id: String,
    pub request_id: String,
    pub phase: ReceivedAdoptionPhase,
    pub worker_state: ReceivedAdoptionWorkerState,
    pub control: Option<ReceivedAdoptionControl>,
    pub cancel_requested: Option<bool>,
    pub jobs: Vec<ReceivedAdoptionJob>,
    pub total_sources: u32,
    pub completed_sources: u32,
    pub blocked_items: u32,
    pub error_code: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    pub request: String,
    pub adoption: String,
    pub receipt: TransferReceipt,
    pub selections: Vec<ReceivedAdoptionSelection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_mappings: Vec<super::instructions::SealedInstructionMapping>,
    pub project: Option<ReceivedProjectTarget>,
    pub profile: std::path::PathBuf,
    pub profile_identity: String,
    pub target: TransferAuthority,
    pub groups: Vec<Group>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Group {
    pub source: MigrationSourceKind,
    pub project: bool,
    pub entries: Vec<String>,
    pub job_id: String,
}
impl Intent {
    pub fn proof(&self, index: usize) -> Result<ReceivedBatchBinding> {
        let group = self
            .groups
            .get(index)
            .context("source_transfer_adoption_changed")?;
        Ok(ReceivedBatchBinding {
            request_id: self.request.clone(),
            adoption_id: self.adoption.clone(),
            binding_digest: digest(self)?,
            group: index.try_into()?,
            project: if group.project {
                self.project.clone()
            } else {
                None
            },
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Publication {
    pub identity: kcoder_config::PortableLeaseIdentity,
    pub sha256: String,
    pub blocked: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    pub version: u8,
    pub intent: Intent,
    pub phase: ReceivedAdoptionPhase,
    pub completed_sources: u32,
    pub blocked_items: u32,
    pub error_code: Option<String>,
    pub publications: Vec<Option<Publication>>,
    pub published: Vec<bool>,
}
