use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerResourcesParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServerIdleShutdownParams {
    pub instance_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResourceActivity {
    pub resident_threads: Option<usize>,
    pub running_turns: Option<usize>,
    pub terminal_sessions: Option<usize>,
    pub browser_sessions: Option<usize>,
    pub pending_service_requests: Option<usize>,
    pub history_refresh_active: Option<bool>,
    pub pending_tasks: Option<usize>,
    pub running_tasks: Option<usize>,
    pub pending_approvals: Option<usize>,
    pub pending_questions: Option<usize>,
    pub queued_followups: Option<usize>,
    pub pending_goal_continuations: Option<usize>,
    pub cached_scheduled_jobs: Option<usize>,
    pub pending_automation_requests: Option<usize>,
    pub automation_subscribed: Option<bool>,
    pub registered_background_jobs: Option<usize>,
    pub background_cancellation_markers: Option<usize>,
    pub registered_prefires: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResourcesResult {
    pub process_id: u32,
    pub instance_id: String,
    pub sampled_at_ms: u64,
    pub resident_bytes: Option<u64>,
    pub memory_source: String,
    pub includes_children: bool,
    /// False means the observation cannot authorize process reclamation.
    pub activity_complete: bool,
    pub reclaimable: Option<bool>,
    #[serde(default)]
    pub activity: ServerResourceActivity,
}
