use super::*;
use kcoder_permissions::{PermissionRequestContext, PermissionResponse, PermissionRisk};
/// A reply from a client that did not negotiate `interactionBindingV1`.
fn resolve_legacy_reply(
    response: &Value,
    pending_approvals: &PendingApprovalResponses,
    pending_questions: &PendingQuestionResponses,
) -> InteractionReply {
    resolve_server_response(
        response,
        pending_approvals,
        pending_questions,
        &Arc::new(StdMutex::new(InteractionReceipts::default())),
        false,
    )
}

fn permission_request_context(tool_name: &str, input: Value) -> PermissionRequestContext {
    PermissionRequestContext {
        tool_name: tool_name.into(),
        description: "执行测试操作".into(),
        input,
        risk: PermissionRisk::Medium,
        detail_lines: vec!["需要客户端明确确认".into()],
    }
}

fn test_permission_prompt(
    mode: kcoder_config::PermissionMode,
) -> (
    AppServerPermissionPrompt,
    mpsc::Receiver<Value>,
    PendingApprovalResponses,
) {
    let (outbound_tx, outbound_rx) = mpsc::channel(4);
    let pending = Arc::new(StdMutex::new(HashMap::new()));
    let prompt = AppServerPermissionPrompt {
        mode,
        receipts: Arc::new(StdMutex::new(InteractionReceipts::default())),
        outbound_tx,
        pending: Arc::clone(&pending),
        next_id: Arc::new(AtomicU64::new(2_000_000)),
        context: Arc::new(StdMutex::new(Some(ApprovalContext {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
        }))),
        artifact_dir: Arc::new(StdMutex::new(None)),
        response_timeout: DEFAULT_APPROVAL_RESPONSE_TIMEOUT,
    };
    (prompt, outbound_rx, pending)
}

include!("protocol_io.rs");
include!("approvals_questions.rs");
include!("projection_background.rs");
include!("provider_failure.rs");
include!("git_file_changes.rs");
include!("thread_history.rs");
include!("agent_artifacts.rs");
include!("thread_metadata_journal.rs");
include!("transcript_artifact_journal.rs");
include!("resume_checkpoint.rs");
include!("goal_lifecycle.rs");
include!("worktree_registry.rs");
include!("run_projection.rs");
include!("turn_submission.rs");
include!("interaction_receipts.rs");

/// Same prompt fixture as [`test_permission_prompt`], exposing the shared
/// interaction ledger so reply receipt semantics can be asserted.
fn test_permission_prompt_with_receipts(
    mode: kcoder_config::PermissionMode,
) -> (
    AppServerPermissionPrompt,
    mpsc::Receiver<Value>,
    PendingApprovalResponses,
    Arc<StdMutex<InteractionReceipts>>,
) {
    let (prompt, outbound_rx, pending) = test_permission_prompt(mode);
    let receipts = Arc::clone(&prompt.receipts);
    (prompt, outbound_rx, pending, receipts)
}

#[test]
fn background_followup_queue_claims_per_run_not_per_id() {
    let mut queue = BackgroundFollowupQueue::default();
    assert!(queue.claim_run("job-1", Some(10)));
    assert!(!queue.claim_run("job-1", Some(10)), "same run must dedupe");
    assert!(
        queue.claim_run("job-1", Some(20)),
        "a respawned run must be able to wake the thread again"
    );
    // `None` is only reachable for tasks that never started a run; the respawn
    // path always stamps `Some` (pinned in the final report — the `(id, None)`
    // key must never absorb a fresh run).
    assert!(queue.claim_run("job-2", None));
    assert!(!queue.claim_run("job-2", None));
}
