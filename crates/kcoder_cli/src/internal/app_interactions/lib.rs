//! Bound App Server approvals, questions and terminal receipts.

use kcoder_app_protocol::{ApprovalResponse, QuestionResponse};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex, atomic::AtomicU64},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

#[path = "async_questions.rs"]
pub mod async_questions;
#[path = "../../app_server/interaction_requests.rs"]
pub mod interaction_requests;

pub const DEFAULT_APPROVAL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(debug_assertions)]
const E2E_APPROVAL_TIMEOUT_ENV: &str = "KCODER_E2E_APPROVAL_TIMEOUT_MS";

#[derive(Clone)]
pub struct QuestionContext {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

pub type PendingQuestionResponses =
    Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<QuestionResponse, String>>>>>;

pub type PendingApprovalResponses =
    Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<ApprovalResponse, String>>>>>;

#[derive(Clone)]
pub struct ApprovalContext {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone)]
pub struct AppServerPermissionPrompt {
    pub tool_call_id: Option<String>,
    pub tool_call_identity_enabled: bool,
    pub mode: kcoder_config::PermissionMode,
    pub outbound_tx: mpsc::Sender<Value>,
    pub pending: PendingApprovalResponses,
    pub receipts: Arc<StdMutex<InteractionReceipts>>,
    pub next_id: Arc<AtomicU64>,
    pub context: Arc<StdMutex<Option<ApprovalContext>>>,
    pub artifact_dir: Arc<StdMutex<Option<PathBuf>>>,
    pub response_timeout: Duration,
}

/// Outcome of a reply frame (S5/R046).
pub enum InteractionReply {
    /// Delivered to the waiting tool.
    Delivered,
    /// A pending interaction matched, but the reply did not name it correctly.
    Misattributed,
    /// Nothing pending and nothing recorded for this transport id.
    Unmatched,
}

/// Identity fields captured from a parsed reply and required in its response.
#[derive(Clone, Copy)]
pub struct ReplyBinding<'a> {
    pub interaction_id: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
}

/// Upper bound of remembered interaction resolutions per connection.
pub const INTERACTION_RECEIPT_LIMIT: usize = 1024;

/// Identity of one interaction the connection is waiting on.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct InteractionBinding {
    /// Server-issued interaction id (`approval-…` / `question-…`).
    pub interaction_id: String,
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub kind: kcoder_app_protocol::InteractionStatusKindV1,
}

struct OutstandingInteraction {
    binding: InteractionBinding,
    /// The exact request notification, replayed when a reply cannot be attributed.
    request: Value,
}

struct ResolvedInteraction {
    binding: Option<InteractionBinding>,
    notification: Value,
}

/// Bounded per-connection ledger of interaction resolutions (S5/R046).
///
/// Today a client only echoes the JSON-RPC transport id, so a repeated reply
/// must replay the terminal answer it may have missed. A reply that matches no
/// pending interaction is never treated as an accepted decision, and is counted
/// so the drop stays observable instead of silent.
#[derive(Default)]
pub struct InteractionReceipts {
    pub app_server_epoch: String,
    resolved: VecDeque<(u64, ResolvedInteraction)>,
    outstanding: HashMap<u64, OutstandingInteraction>,
    duplicate_replies: u64,
    unmatched_replies: u64,
    misattributed_replies: u64,
}

#[derive(Clone)]
pub struct AppServerQuestioner {
    pub outbound_tx: mpsc::Sender<Value>,
    pub pending: PendingQuestionResponses,
    pub receipts: Arc<StdMutex<InteractionReceipts>>,
    pub next_id: Arc<AtomicU64>,
    pub context: Arc<StdMutex<Option<QuestionContext>>>,
}
