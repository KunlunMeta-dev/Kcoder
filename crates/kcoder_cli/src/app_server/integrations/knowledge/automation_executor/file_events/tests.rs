use super::super::super::KnowledgePolicyEvaluator;
use super::*;
use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;
use std::{
    fs::{File, FileTimes},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct Policy;
impl KnowledgePolicyEvaluator for Policy {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Allow,
            policy_revision: "fixture".into(),
            reason_code: "fixture".into(),
        })
    }
}
struct Runtime {
    calls: AtomicUsize,
}
#[async_trait::async_trait]
impl KnowledgeDependencyPort for Runtime {
    fn registered(&self, port: IntegrationPort, _: &str) -> bool {
        port == IntegrationPort::Runtime
    }
    async fn call(
        &self,
        _: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        assert_eq!(method, "acceptTask");
        self.calls.fetch_add(1, Ordering::SeqCst);
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            status: IntegrationStatus::Accepted,
            entity_revision: IntegrationNullable::Null,
            observed_at: "2026-10-24T00:00:00Z".into(),
            error: IntegrationNullable::Null,
            result: IntegrationNullable::Value(
                json!({"threadId":"native-thread","turnId":"native-turn",
                "state":"queued"})
                .as_object()
                .unwrap()
                .clone(),
            ),
        }
    }
}
struct Fixture {
    root: tempfile::TempDir,
    scope: IntegrationScope,
    store: AutomationStore,
    workflows: WorkflowStore,
    source: ApprovedFileEventSource,
    request: IntegrationRequest,
}
fn write_at(path: &std::path::Path, bytes: &[u8], at: u64) -> Result<()> {
    std::fs::write(path, bytes)?;
    File::options()
        .write(true)
        .open(path)?
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(at)))?;
    Ok(())
}
fn fixture() -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    write_at(
        &root.path().join("selected.txt"),
        b"NEVER_EXECUTE_THIS_SOURCE_TEXT",
        1000,
    )?;
    std::fs::write(
        root.path().join("unselected.txt"),
        b"private unselected material",
    )?;
    let scope: IntegrationScope =
        serde_json::from_value(json!({"accountId":"file-owner","targetId":"file-target",
        "workspaceId":null,"identityGeneration":"1","targetRevision":"1"}))?;
    let workflows = WorkflowStore::new(root.path().join("workflows"));
    let mut definition = workflows.create("File event workflow", "")?;
    definition=workflows.upsert_node(&definition.id,definition.revision,serde_json::from_value(json!({
        "id":"step","title":"Process selected revision","prompt":"Read only approved native input references","maxTurns":1}))?)?;
    definition = workflows.save(&definition.id, definition.revision)?;
    let store = AutomationStore::create(&root.path().join("automation"), &scope)?;
    let draft = AutomationSubscriptionDraft {
        id: "file-subscription".into(),
        title: "Selected file".into(),
        workflow_id: definition.id,
        workflow_version: definition.saved_version.unwrap(),
        model_selection: None,
        inputs: json!({}),
        schedule: None,
        event_source: Some("approved-files".into()),
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 30,
        delivery: AutomationDestination::Studio,
    };
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "fixture-consent", &draft)?;
    store.save_subscription("save", 0, draft, &consent, None, 1000)?;
    let source = ApprovedFileEventSource::from_authorized_files(
        &scope,
        "approved-files",
        directory,
        vec![("approved-resource".into(), "selected.txt".into())],
    )?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "file-tick".into(),
        scope: scope.clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: Default::default(),
    };
    Ok(Fixture {
        root,
        scope,
        store,
        workflows,
        source,
        request,
    })
}
#[tokio::test]
async fn actual_selected_file_revision_is_durable_inert_on_replay_and_never_executed() -> Result<()>
{
    let mut f = fixture()?;
    let policy = Policy;
    let runtime = Runtime {
        calls: AtomicUsize::new(0),
    };
    let cancel = CancellationToken::new();
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 1000,
        explicit_user_action: false,
        policy: &policy,
    };
    let first = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        None,
        0,
        &cancel,
    )
    .await?;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].status, IntegrationStatus::Completed);
    let run: AutomationRun =
        serde_json::from_value(first[0].result.as_ref().unwrap()["run"].clone())?;
    assert_eq!(run.status, AutomationRunStatus::Accepted);
    assert!(
        process_selected_file_events(
            &f.request,
            &ctx,
            &f.store,
            &f.workflows,
            &runtime,
            &f.source,
            None,
            0,
            &cancel
        )
        .await?
        .is_empty()
    );
    f.store = AutomationStore::open(&f.root.path().join("automation"), &f.scope)?;
    assert!(
        process_selected_file_events(
            &f.request,
            &ctx,
            &f.store,
            &f.workflows,
            &runtime,
            &f.source,
            None,
            0,
            &cancel
        )
        .await?
        .is_empty()
    );
    f.store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Controlled runtime output".into()),
        vec![],
        1000,
    )?;
    write_at(
        &f.root.path().join("selected.txt"),
        b"second actual revision",
        11_000,
    )?;
    let ctx = KnowledgeHostContext {
        now_ms: 11_000,
        ..ctx
    };
    let second = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        None,
        0,
        &cancel,
    )
    .await?;
    assert_eq!(second.len(), 1);
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 2);
    let facts = f.store.read_run_trigger_facts(&run.id)?;
    assert_eq!(facts["resourceRef"], "approved-resource");
    assert!(
        facts["contentRevision"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    let ledger = std::fs::read_to_string(f.root.path().join("automation/automations.json"))?;
    assert!(!ledger.contains("NEVER_EXECUTE_THIS_SOURCE_TEXT"));
    assert!(!ledger.contains("selected.txt"));
    assert!(!ledger.contains("private unselected material"));
    Ok(())
}
#[tokio::test]
async fn replacement_oversize_and_self_produced_events_never_reach_runtime() -> Result<()> {
    let f = fixture()?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 1000,
        explicit_user_action: false,
        policy: &policy,
    };
    let runtime = Runtime {
        calls: AtomicUsize::new(0),
    };
    let cancel = CancellationToken::new();
    let result = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        Some("file-subscription"),
        1,
        &cancel,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("LOOP_REJECTED"));
    write_at(
        &f.root.path().join("selected.txt"),
        &vec![0; MAX_FILE_BYTES + 1],
        1000,
    )?;
    let result = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        None,
        0,
        &cancel,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("FILE_TOO_LARGE"));
    std::fs::rename(
        f.root.path().join("selected.txt"),
        f.root.path().join("original.txt"),
    )?;
    write_at(
        &f.root.path().join("selected.txt"),
        b"different inode",
        1000,
    )?;
    let result = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        None,
        0,
        &cancel,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("OBJECT_CHANGED"));
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 0);
    assert!(f.store.list_runs(None)?.items.is_empty());
    Ok(())
}
#[tokio::test]
async fn one_file_event_gives_distinct_stable_intents_to_two_explicit_subscriptions() -> Result<()>
{
    let f = fixture()?;
    let mut second = f.store.read_subscription("file-subscription")?.draft;
    second.id = "second-file-subscription".into();
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&f.scope, "second-consent", &second)?;
    f.store
        .save_subscription("save-second", 0, second, &consent, None, 1000)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 1000,
        explicit_user_action: false,
        policy: &policy,
    };
    let runtime = Runtime {
        calls: AtomicUsize::new(0),
    };
    let cancel = CancellationToken::new();
    let results = process_selected_file_events(
        &f.request,
        &ctx,
        &f.store,
        &f.workflows,
        &runtime,
        &f.source,
        None,
        0,
        &cancel,
    )
    .await?;
    assert_eq!(results.len(), 2);
    assert_ne!(results[0].operation_id, results[1].operation_id);
    let runs = f.store.list_runs(None)?.items;
    assert_eq!(runs.len(), 2);
    assert_ne!(runs[0].native_operation_id, runs[1].native_operation_id);
    assert!(
        process_selected_file_events(
            &f.request,
            &ctx,
            &f.store,
            &f.workflows,
            &runtime,
            &f.source,
            None,
            0,
            &cancel
        )
        .await?
        .is_empty()
    );
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 2);
    Ok(())
}

#[cfg(unix)]
#[test]
fn source_binding_rejects_path_escape_symlink_and_hardlink_aliases() -> Result<()> {
    let f = fixture()?;
    std::os::unix::fs::symlink("selected.txt", f.root.path().join("symbolic.txt"))?;
    std::fs::hard_link(
        f.root.path().join("selected.txt"),
        f.root.path().join("alias.txt"),
    )?;
    for name in ["../selected.txt", "symbolic.txt", "alias.txt"] {
        assert!(
            ApprovedFileEventSource::from_authorized_files(
                &f.scope,
                "files",
                PrivateDirectory::open_existing(f.root.path())?,
                vec![("resource".into(), name.into())]
            )
            .is_err()
        );
    }
    assert!(f.store.list_runs(None)?.items.is_empty());
    Ok(())
}
