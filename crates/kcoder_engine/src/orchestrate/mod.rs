pub mod continuation;
pub mod input;
pub mod notification;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrchestrateProvenance {
    Goal,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestrateRuntimeContext {
    pub provenance: OrchestrateProvenance,
    pub work_id: Option<String>,
    pub policy_profile: &'static str,
}
