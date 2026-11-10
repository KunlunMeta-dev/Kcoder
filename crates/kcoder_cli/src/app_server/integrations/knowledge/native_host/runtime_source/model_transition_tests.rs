//! Actual native source, child acceptance, failed Provider and original State budget composition.
use super::*;
use kcoder_engine::ClientModelConfiguration;
use kcoder_state::integrations::core::budgets::{BudgetPhase, BudgetUsageCoverage};
use std::sync::RwLock;

type BeforeError = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

struct FailedModel {
    calls: Arc<AtomicUsize>,
    partial: bool,
    before_error: BeforeError,
}
impl Provider for FailedModel {
    fn name(&self) -> &'static str {
        "actual-native-transition-failure"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(action) = self.before_error.lock().unwrap().take() {
            action();
        }
        let failure = ApiErrorKind::Api {
            error_type: "overloaded_error".into(),
            message: "private diagnostic is not native authorization".into(),
        };
        if self.partial {
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "already published partial output".into(),
                    },
                }),
                Err(failure),
            ])))
        } else {
            Err(failure)
        }
    }
}
struct ActualModelCatalog {
    settings: Arc<RwLock<kcoder_config::Settings>>,
    first: Arc<dyn Provider>,
    next: Arc<dyn Provider>,
}
impl ClientModelConfiguration for ActualModelCatalog {
    fn settings(&self, selection: &str) -> Result<kcoder_config::Settings> {
        let mut settings = self.settings.read().unwrap().clone();
        let (provider, model) = selection
            .split_once("::")
            .context("actual qualified model required")?;
        settings.apply_discovered_model(provider, model)?;
        Ok(settings)
    }
    fn provider(&self, settings: &kcoder_config::Settings) -> Result<Arc<dyn Provider>> {
        match settings.active_provider.as_deref() {
            Some("A") => Ok(self.first.clone()),
            Some("B") => Ok(self.next.clone()),
            _ => anyhow::bail!("actual configured model unavailable"),
        }
    }
    fn catalog_settings(&self) -> Result<Option<kcoder_config::Settings>> {
        Ok(Some(self.settings.read().unwrap().clone()))
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Case {
    Auto,
    InitialSecond,
    Legacy,
    Explicit,
    Verifier,
    Partial,
    ChangedPolicy,
    DisabledSource,
    Budget,
    Deadline,
}

#[tokio::test]
async fn persisted_auto_uses_actual_failed_child_and_same_native_budget_without_refunding_unknown()
-> Result<()> {
    run_case(Case::Auto).await
}
#[tokio::test]
async fn omitted_legacy_intent_cannot_authorize_native_model_transition() -> Result<()> {
    run_case(Case::Legacy).await
}
#[tokio::test]
async fn explicit_model_intent_cannot_authorize_native_model_transition() -> Result<()> {
    run_case(Case::Explicit).await
}
#[tokio::test]
async fn verifier_locked_intent_cannot_authorize_native_model_transition() -> Result<()> {
    run_case(Case::Verifier).await
}
#[tokio::test]
async fn initial_auto_selection_uses_owned_factory_without_changing_peer_model() -> Result<()> {
    run_case(Case::InitialSecond).await
}
#[tokio::test]
async fn published_partial_output_cannot_authorize_native_model_transition() -> Result<()> {
    run_case(Case::Partial).await
}
#[tokio::test]
async fn current_policy_change_denies_original_auto_transition() -> Result<()> {
    run_case(Case::ChangedPolicy).await
}
#[tokio::test]
async fn disabled_original_subscription_denies_auto_transition() -> Result<()> {
    run_case(Case::DisabledSource).await
}
#[tokio::test]
async fn next_actual_native_reservation_cannot_refund_failed_unknown_to_fit_budget() -> Result<()> {
    run_case(Case::Budget).await
}
#[tokio::test]
async fn original_native_deadline_cannot_be_extended_by_model_transition() -> Result<()> {
    run_case(Case::Deadline).await
}

async fn run_case(case: Case) -> Result<()> {
    let mut f = Fixture::new()?;
    let first_calls = Arc::new(AtomicUsize::new(0));
    let next_calls = Arc::new(AtomicUsize::new(0));
    let before_error = Arc::new(Mutex::new(None));
    let first: Arc<dyn Provider> = Arc::new(FailedModel {
        calls: first_calls.clone(),
        partial: case == Case::Partial,
        before_error: before_error.clone(),
    });
    let next: Arc<dyn Provider> = Arc::new(SourceProvider {
        calls: next_calls.clone(),
        builtin_output: false,
        invalid_final_once: std::sync::atomic::AtomicBool::new(false),
    });
    let mut settings = f.engine.settings.read().unwrap().clone();
    settings.providers = serde_json::from_value(json!({
        "A":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"one","context_window_tokens":128000,"max_output_tokens":512,"output_headroom_tokens":512},
        "B":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"two","context_window_tokens":128000,"max_output_tokens":512,"output_headroom_tokens":512}
    }))?;
    settings.integrations.core = serde_json::from_value(json!({"modelPolicies":[{
        "id":"owned-original-auto","candidates":[{"provider":"A","model":"one"},{"provider":"B","model":"two"}]
    }]}))?;
    if case == Case::InitialSecond {
        settings.integrations.core.model_policies[0].candidates[0].enabled = false;
    }
    settings.apply_discovered_model("A", "one")?;
    settings.history_enabled = false;
    settings.training_mode = false;
    settings.max_retries = 1;
    settings.retry_base_delay_ms = 1;
    settings.max_tokens = Some(512);
    settings.session_memory.enabled = false;
    settings.memory.structured_enabled = false;
    let selection = match case {
        Case::Legacy => None,
        Case::Explicit => Some(IntegrationModelSelectionIntent::Explicit {
            provider: "A".into(),
            model: "one".into(),
        }),
        Case::Verifier => Some(IntegrationModelSelectionIntent::VerifierLocked {
            provider: "A".into(),
            model: "one".into(),
            configuration_revision: kcoder_engine::model_configuration_summary(
                &settings,
                kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
            )?
            .revision,
        }),
        _ => Some(IntegrationModelSelectionIntent::AutoPolicy {
            id: "owned-original-auto".into(),
            version: settings.integrations.core.model_policies[0].version()?,
        }),
    };
    let catalog = Arc::new(RwLock::new(settings.clone()));
    f.engine = actual_engine_with_provider(&f, settings, first.clone())?
        .with_client_model_configuration(Arc::new(ActualModelCatalog {
            settings: catalog.clone(),
            first,
            next,
        }));
    f.native
        .refresh_configuration_revision(f.engine.active_model_configuration_summary()?.revision)?;
    f.publication(true)?;
    let definition = fixed_graph(&f)?;
    let draft = AutomationSubscriptionDraft {
        id: "real-runtime-subscription".into(),
        title: "Actual native original AUTO".into(),
        workflow_id: definition.id,
        workflow_version: 1,
        model_selection: selection,
        inputs: json!({"sourceRefs":[{"kind":"publication","id":"runtime-publication","revision":"1"}]}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: if case == Case::Budget { 6500 } else { 50_000 },
        period_budget: None,
        // Long enough that a loaded debug build reaches the first call before
        // the deadline; the failing call then sleeps past it.
        maximum_runtime_seconds: if case == Case::Deadline { 3 } else { 30 },
        delivery: AutomationDestination::Studio,
    };
    let (host, request) = f.run_draft(draft).await?;
    if case == Case::ChangedPolicy {
        *before_error.lock().unwrap() = Some(Box::new(move || {
            catalog.write().unwrap().integrations.core.model_policies[0].enabled = false;
        }));
    } else if case == Case::DisabledSource {
        let automation = host
            .observe_automation()?
            .context("actual source missing")?;
        *before_error.lock().unwrap() = Some(Box::new(move || {
            automation
                .store
                .set_subscription_enabled(
                    "disable-original-at-provider-failure",
                    "real-runtime-subscription",
                    1,
                    false,
                    None,
                    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap(),
                )
                .unwrap();
        }));
    } else if case == Case::Deadline {
        *before_error.lock().unwrap() = Some(Box::new(|| {
            std::thread::sleep(Duration::from_millis(3100));
        }));
    }
    let peer = f.engine.clone();
    let peer_before = serde_json::to_vec(&*peer.settings.read().unwrap())?;
    let profile_before = std::fs::read(f.profile.join("settings.json"))?;
    let mut manager = manager(
        f.engine.clone(),
        &f._root.path().join("original-auto-history.jsonl"),
    )
    .await?;
    let result = async {
        let prepared = prepare_native_automation_runtime_for_resident(
            &f.native,
            &manager,
            &f.engine.session_id(),
            host,
            &request,
            None,
            &CancellationToken::new(),
        )?;
        let mut driver = NativeRuntimeDriver::initialize(&f.native, "original-auto-runtime")?;
        ensure!(matches!(
            driver.accept_task(&f.native, &request, prepared.task.clone())?,
            RuntimeSubmission::Queued
        ));
        let NativeRuntimeCommand::Configure { ticket, .. } = driver
            .next_command(&f.native)?
            .context("actual configure missing")?
        else {
            anyhow::bail!("actual wrong configure stage")
        };
        driver.configure_command(
            &f.native,
            &ticket,
            &mut manager,
            Some(prepared.authority.installer()),
        )?;
        let NativeRuntimeCommand::StartWorkflow {
            ticket, thread_id, ..
        } = driver
            .next_command(&f.native)?
            .context("actual workflow missing")?
        else {
            anyhow::bail!("actual wrong workflow stage")
        };
        let engine = manager
            .engine(&thread_id)
            .context("actual original engine missing")?;
        let job = driver.prepare_workflow_launch(
            &f.native,
            &ticket,
            engine,
            Some(prepared.authority.clone()),
        )?;
        driver.observe_workflow_launch(&f.native, &ticket, job.run().await)?;
        let operation = request.operation_id.as_deref().unwrap();
        let task = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                driver.refresh_workflow(&f.native, operation)?;
                let task = driver.read_task(&f.native, operation)?;
                if matches!(
                    task.state,
                    IntegrationTaskState::Completed
                        | IntegrationTaskState::Failed
                        | IntegrationTaskState::Cancelled
                ) {
                    break Ok::<_, anyhow::Error>(task);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
        let diagnostic = runtime_diagnostic(&f, &task, &next_calls);
        eprintln!(
            "actual native AUTO composition: {diagnostic}; firstCalls={}",
            first_calls.load(Ordering::SeqCst)
        );
        prepared
            .authority
            .observe_task(&f.native, &request, &task)?;
        let calls = prepared.authority.observed_native_model_calls_for_test()?;
        let (slot, policy) = prepared.authority.observed_native_budget_for_test()?;
        ensure!(
            policy.limits.concurrent_calls == Some(1),
            "actual original concurrency limit changed"
        );
        if case == Case::InitialSecond {
            ensure!(
                first_calls.load(Ordering::SeqCst) == 0
                    && next_calls.load(Ordering::SeqCst) == 2
                    && task.state == IntegrationTaskState::Completed
                    && calls.len() == 2
                    && policy.charged.tokens == 280
                    && policy.active_calls == 0
                    && policy.active_tasks == 0,
                "initial owned Auto selection did not retain native source and budget: {diagnostic}"
            );
            ensure!(
                serde_json::to_vec(&*peer.settings.read().unwrap())? == peer_before
                    && peer.model_name() == "one"
                    && std::fs::read(f.profile.join("settings.json"))? == profile_before,
                "initial Auto changed the peer or profile"
            );
            return Ok(());
        }
        let old_calls = first_calls.load(Ordering::SeqCst);
        ensure!(
            old_calls == 1,
            "old failed model was called {old_calls} times (0: not reached, >1: replayed): {diagnostic}"
        );
        let failed = calls
            .first()
            .context("actual old native reservation missing")?;
        ensure!(
            failed.coverage == BudgetUsageCoverage::Unreported
                && failed.known_usage.tokens == 0
                && failed.charged.tokens == failed.estimate.tokens
                && failed.charged.model_calls == failed.estimate.model_calls
                && failed.charged.run_millis >= failed.estimate.run_millis
                && failed.charged.tokens > 0
                && !failed.cost_known,
            "unknown failed request was refunded or reported as measured zero"
        );
        if case == Case::Auto {
            ensure!(
                task.state == IntegrationTaskState::Completed
                    && next_calls.load(Ordering::SeqCst) == 2,
                "actual AUTO did not complete original source graph: {diagnostic}"
            );
            ensure!(
                calls.len() == 3
                    && failed.phase == BudgetPhase::Terminal
                    && failed.execution_confirmed_terminal,
                "closed failed native request did not retain its receipt"
            );
            ensure!(
                calls.iter().all(
                    |call| call.task.root_operation_id == slot.task.root_operation_id
                        && call.task.parent_reservation_id.as_deref() == Some(&slot.reservation_id)
                        && call.task.root_task == failed.task.root_task
                        && call.task.actor_attempt_id == failed.task.actor_attempt_id
                ),
                "model transition changed original run, slot or child actor"
            );
            ensure!(
                policy.charged.tokens == failed.estimate.tokens + 280
                    && policy.charged.model_calls == 3
                    && policy.unknown_cost_reservations == 3
                    && policy.active_calls == 0
                    && policy.active_tasks == 0,
                "actual same-store accounting lost prior unknown charge"
            );
        } else if case == Case::Budget {
            ensure!(
                task.state == IntegrationTaskState::Failed
                    && next_calls.load(Ordering::SeqCst) == 0
                    && calls.len() == 1
                    && failed.phase == BudgetPhase::Terminal
                    && failed.execution_confirmed_terminal
                    && policy.active_calls == 0
                    && policy.charged.tokens == failed.estimate.tokens,
                "a second actual call bypassed original held budget: {diagnostic}"
            );
        } else {
            ensure!(
                task.state == IntegrationTaskState::Failed
                    && next_calls.load(Ordering::SeqCst) == 0
                    && calls.len() == 1,
                "unapproved/partial/revoked transition invoked another model: {diagnostic}"
            );
            ensure!(
                !failed.execution_confirmed_terminal
                    && failed.phase == BudgetPhase::Dispatched
                    && policy.active_calls == 1
                    && policy.charged.tokens == failed.estimate.tokens,
                "denied transition discarded the old unknown execution receipt"
            );
        }
        ensure!(
            matches!(
                driver.accept_task(&f.native, &request, prepared.task)?,
                RuntimeSubmission::Known(_)
            ) && driver.next_command(&f.native)?.is_none(),
            "original operation was replayed"
        );
        ensure!(
            serde_json::to_vec(&*peer.settings.read().unwrap())? == peer_before
                && std::fs::read(f.profile.join("settings.json"))? == profile_before,
            "native selection changed peer settings or user profile"
        );
        Ok(())
    }
    .await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    result
}
