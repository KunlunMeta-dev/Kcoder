//! Private creation phases stay distinct from the ordinary published job's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchCreationStage {
    Capturing,
    Prepared,
    Published,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchCreationWorkerState {
    Running,
    Stopped,
    Unknown,
}

/// Native observation only; Host projections must use their shared allowlisted DTO.
pub struct BatchCreationObservation {
    pub request_id: String,
    pub job_id: String,
    pub stage: BatchCreationStage,
    pub worker_state: BatchCreationWorkerState,
    pub control_revision: Option<u64>,
    pub cancel_requested: Option<bool>,
    pub job: Option<crate::store::MigrationJob>,
}
