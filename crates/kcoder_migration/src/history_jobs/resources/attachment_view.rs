//! Native-only attachment observations contain no group authority or source path.
use kcoder_types::migration_resource::MigrationResourceLimits;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceAttachmentPhase {
    NotApplicable,
    Untracked,
    Pending,
    Attached,
    Tracked,
    ParentOwned,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceAttachmentIntent {
    pub expected_sequence: u64,
    pub plan_id: Option<String>,
    pub initial_limits: MigrationResourceLimits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceAttachmentObservation {
    pub job_id: String,
    pub owner_job_id: Option<String>,
    pub current_sequence: u64,
    pub current_plan_id: Option<String>,
    pub phase: ResourceAttachmentPhase,
    pub original_intent: Option<ResourceAttachmentIntent>,
    pub issue_code: Option<&'static str>,
}

impl ResourceAttachmentObservation {
    pub(super) fn unknown(mut self, code: &'static str) -> Self {
        self.phase = ResourceAttachmentPhase::Unknown;
        self.issue_code = Some(code);
        self
    }
}
