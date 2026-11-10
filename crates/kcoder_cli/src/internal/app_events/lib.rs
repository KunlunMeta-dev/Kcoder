//! App-server notification projection and background event delivery.

use anyhow::Result;
use kcoder_app_protocol::{
    AgentSteerAppliedParams, AgentSteerResult, AgentSteerStatus, AgentSummary, method,
};
use kcoder_cli_support::engine_event_json;
use kcoder_engine::{BackgroundJobEvent, EngineEvent, QueryEngine};
use kcoder_host_transport::protocol_io::{notification, send};
use kcoder_state::{AgentMessageStatus, Task, TaskDelivery, TaskKind, TaskStatus};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;

#[path = "../../app_server/background_delivery.rs"]
pub mod background_delivery;
#[path = "../../app_server/foreground_events.rs"]
pub mod foreground_events;
#[path = "../../app_server/notification_projection.rs"]
pub mod notification_projection;
#[path = "../../app_server/request_origin.rs"]
pub mod request_origin;
#[path = "../../app_server/resident_turn.rs"]
pub mod resident_turn;
#[path = "../../app_server/turn_execution.rs"]
pub mod turn_execution;
#[path = "turn_tasks.rs"]
pub mod turn_tasks;
#[cfg(test)]
use background_delivery::*;
use notification_projection::*;

#[derive(Clone)]
pub struct BackgroundTurnProjection {
    pub thread_id: String,
    pub turn_id: String,
    pub projection: Arc<Mutex<StreamProjection>>,
}

#[derive(Default)]
pub struct BackgroundProjectionState {
    pub active: Option<BackgroundTurnProjection>,
    pub jobs: HashMap<String, BackgroundTurnProjection>,
    pub tool_calls: HashMap<String, BackgroundTurnProjection>,
    pub job_tools: HashMap<String, String>,
    pub pending: HashMap<String, Vec<EngineEvent>>,
    pub associated_jobs: HashSet<String>,
    pub terminal_jobs: HashSet<String>,
    current_runs: HashMap<String, String>,
    last_contexts: HashMap<String, BackgroundTurnProjection>,
    forwarded_events: HashSet<String>,
    forwarded_order: std::collections::VecDeque<String>,
    steer_response_gates: HashMap<String, AgentSteerResponseGate>,
    steer_correlations: HashMap<String, AgentSteerCorrelation>,
}

#[derive(Default)]
struct AgentSteerResponseGate {
    client_message_id: Option<String>,
    deferred_applied: Vec<(Option<BackgroundTurnProjection>, EngineEvent)>,
}

struct AgentSteerCorrelation {
    agent_id: String,
    client_message_id: Option<String>,
}

pub struct StreamProjection {
    pub native_child_sources: bool,
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub sequence: Arc<AtomicU64>,
    pub next_item: u64,
    pub item_namespace: String,
    pub assistant_item: Option<String>,
    pub turn_terminal: bool,
}

#[derive(Default)]
pub struct BackgroundFollowups {
    pub queue: Mutex<BackgroundFollowupQueue>,
    pub notify: tokio::sync::Notify,
}

#[derive(Default)]
pub struct BackgroundFollowupQueue {
    pub pending: BTreeMap<String, String>,
    /// `(agent id, run_started_at_ms)`. A respawned agent (`SendMessage`)
    /// starts a fresh run and must be able to wake the thread again. The
    /// field type mirrors `Task::run_started_at_ms` (`Option<u64>`,
    /// `kcoder_state/src/model.rs:180`) so call sites pass it through
    /// without conversion.
    pub claimed_terminal_ids: HashSet<(String, Option<u64>)>,
}

impl BackgroundFollowupQueue {
    /// Insert a wake-up claim for one terminal run. Returns false when this
    /// exact run was already claimed.
    pub fn claim_run(&mut self, id: &str, run_started_at_ms: Option<u64>) -> bool {
        self.claimed_terminal_ids
            .insert((id.to_string(), run_started_at_ms))
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[path = "client_turn_counter.rs"]
pub mod client_turn_counter;
