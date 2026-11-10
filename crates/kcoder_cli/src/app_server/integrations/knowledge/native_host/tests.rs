use super::*;
use kcoder_config::PrivateDirectory;

struct Fixture {
    _root: tempfile::TempDir,
    profile: std::path::PathBuf,
    context: NativeIntegrationContext,
}
fn fixture() -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(root.path())?;
    parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    let profile = root.path().join("profile");
    let context = NativeIntegrationContext::capture(
        &profile,
        &root.path().join("workspace"),
        "transport-only",
        "config-1",
    )?;
    Ok(Fixture {
        _root: root,
        profile,
        context,
    })
}
fn settings() -> KnowledgeIntegrationSettings {
    KnowledgeIntegrationSettings {
        business_automation_enabled: true,
        publications_enabled: true,
        ..Default::default()
    }
}

#[tokio::test]
async fn retired_connection_source_listing_is_unavailable_without_initializing_storage()
-> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let before = names(&f.profile)?;
    let request = request(&host, None, json!({}));
    let reply = host
        .automation(
            "listConnectionEventSources",
            &request,
            false,
            1000,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(reply.status, IntegrationStatus::Unavailable);
    assert!(reply.result.as_ref().is_none());
    assert_eq!(names(&f.profile)?, before);
    assert!(host.observe_automation()?.is_none());
    let denied = NativeKnowledgeHost::new(&f.context, settings())?.with_policy(Arc::new(Denied));
    assert_eq!(
        denied
            .automation(
                "listConnectionEventSources",
                &request,
                false,
                1001,
                &CancellationToken::new()
            )
            .await
            .status,
        IntegrationStatus::Unavailable
    );
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}

#[tokio::test]
async fn quarantine_read_is_metadata_only_and_does_not_initialize_an_empty_store() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let before = names(&f.profile)?;
    let reply = host
        .automation(
            "listQuarantinedEvents",
            &request(&host, None, json!({})),
            false,
            1000,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(reply.status, IntegrationStatus::Completed);
    assert_eq!(
        reply.result.as_ref().unwrap()["page"],
        json!({"items":[],"nextCursor":null})
    );
    assert_eq!(names(&f.profile)?, before);
    assert!(host.observe_automation()?.is_none());
    let denied = NativeKnowledgeHost::new(&f.context, settings())?.with_policy(Arc::new(Denied));
    let rejected = denied
        .automation(
            "listQuarantinedEvents",
            &request(&denied, None, json!({})),
            false,
            1001,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(rejected.status, IntegrationStatus::Rejected);
    assert!(rejected.result.as_ref().is_none());
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}
fn request(
    host: &NativeKnowledgeHost,
    operation: Option<&str>,
    payload: Value,
) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: host.scope().clone(),
        operation_id: operation.map(str::to_owned),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    }
}
fn draft() -> AutomationSubscriptionDraft {
    AutomationSubscriptionDraft {
        id: "real-personal-subscription".into(),
        title: "Native weekly report".into(),
        workflow_id: "builtin-office-weekly-report".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"native-fixed-input","revision":"1"}]}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 5000,
        period_budget: None,
        maximum_runtime_seconds: 300,
        delivery: AutomationDestination::Studio,
    }
}

#[tokio::test]
async fn live_automation_writer_is_retryable_busy_and_original_subscription_remains_readable()
-> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let mut save = request(
        &host,
        Some("explicit-save-before-contention"),
        json!({"draft":draft(),"consentRef":"explicit-subscription-action"}),
    );
    save.expected_revision = Some("0".into());
    let saved = host
        .automation(
            "saveSubscription",
            &save,
            true,
            1000,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(saved.status, IntegrationStatus::Completed);
    let namespace =
        NativeDomainGuard::observe(f.context.profile()?, host.scope(), NativeDomain::Automation)?
            .unwrap();
    let directory = namespace
        .directory(f.context.profile()?)?
        .open_child(OsStr::new("store"), false)?;
    let identity = directory.portable_regular_identity(OsStr::new("automations.lock"))?;
    let writer = directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    let read = request(&host, None, json!({}));
    let busy = host
        .automation(
            "listSubscriptions",
            &read,
            false,
            1001,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(busy.status, IntegrationStatus::Unavailable);
    assert!(busy.result.as_ref().is_none());
    assert_eq!(busy.error.as_ref().unwrap().code, "AUTOMATION_BUSY");
    assert_eq!(
        busy.error.as_ref().unwrap().recovery,
        IntegrationRecovery::RetryRead
    );
    drop(writer);
    let recovered = host
        .automation(
            "listSubscriptions",
            &read,
            false,
            1002,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(recovered.status, IntegrationStatus::Completed);
    let page = &recovered.result.as_ref().unwrap()["page"];
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["items"][0]["draft"]["id"],
        "real-personal-subscription"
    );
    Ok(())
}
fn names(root: &std::path::Path) -> Result<Vec<std::ffi::OsString>> {
    let mut entries = std::fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

struct Denied;
impl KnowledgePolicyEvaluator for Denied {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Deny,
            policy_revision: "actual-denial-fixture".into(),
            reason_code: "denied".into(),
        })
    }
}
#[tokio::test]
async fn denied_read_does_not_become_an_empty_authorized_store() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?.with_policy(Arc::new(Denied));
    let before = names(&f.profile)?;
    let cancel = CancellationToken::new();
    for (port, method) in [
        (IntegrationPort::Knowledge, "listPublications"),
        (IntegrationPort::Automation, "listSubscriptions"),
    ] {
        let result = host
            .dispatch(
                port,
                method,
                &request(&host, None, json!({})),
                false,
                1000,
                &cancel,
            )
            .await;
        assert_eq!(result.status, IntegrationStatus::Rejected);
        assert!(result.result.as_ref().is_none());
    }
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}

#[tokio::test]
async fn preview_never_repairs_a_damaged_user_workflow_library_lock() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let directory = host
        .native
        .profile()?
        .create_private_child(OsStr::new("workflow-library"))?;
    directory.atomic_replace(OsStr::new("library.json"), b"{}")?;
    let before = names(&f.profile.join("workflow-library"))?;
    let mut input = draft();
    input.workflow_id = "real-user-saved-definition".into();
    let response = host
        .automation(
            "previewSubscription",
            &request(&host, None, json!({"draft":input,"consentRef":"preview"})),
            false,
            1000,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(response.status, IntegrationStatus::Unavailable);
    assert_eq!(names(&f.profile.join("workflow-library"))?, before);
    assert!(!f.profile.join("workflow-library/library.lock").exists());
    Ok(())
}

#[tokio::test]
async fn native_lists_templates_and_preview_are_pure_after_authentication() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let before = names(&f.profile)?;
    let cancel = CancellationToken::new();
    for method in ["listSubscriptions", "listAutomationRuns", "listTemplates"] {
        let payload = if method == "listTemplates" {
            json!({"locale":"zh-CN"})
        } else {
            json!({})
        };
        let result = host
            .automation(method, &request(&host, None, payload), false, 1000, &cancel)
            .await;
        assert_eq!(result.status, IntegrationStatus::Completed);
    }
    let preview = host
        .automation(
            "previewSubscription",
            &request(
                &host,
                None,
                json!({"draft":draft(),"consentRef":"preview-only"}),
            ),
            false,
            1000,
            &cancel,
        )
        .await;
    assert_eq!(preview.status, IntegrationStatus::Completed);
    assert_eq!(
        preview.result.as_ref().unwrap()["createsSubscription"],
        false
    );
    assert_eq!(names(&f.profile)?, before);
    assert!(!f.profile.join("workflow-library").exists());
    assert!(host.observe_automation()?.is_none());
    Ok(())
}

#[tokio::test]
async fn explicit_native_save_uses_real_guarded_store_and_reopens_same_owner() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let create = request(
        &host,
        Some("original-save"),
        json!({"draft":draft(),"consentRef":"explicit-native-ui"}),
    );
    let cancel = CancellationToken::new();
    assert_eq!(
        host.automation("saveSubscription", &create, false, 1000, &cancel)
            .await
            .status,
        IntegrationStatus::Rejected
    );
    assert!(host.observe_automation()?.is_none());
    let saved = host
        .automation("saveSubscription", &create, true, 1000, &cancel)
        .await;
    assert_eq!(saved.status, IntegrationStatus::Completed);
    let owned = host.observe_automation()?.unwrap();
    assert_eq!(
        owned
            .store
            .read_subscription(&draft().id)?
            .draft
            .workflow_version,
        1
    );
    assert!(owned.store.list_runs(None)?.items.is_empty());
    let reopened = NativeKnowledgeHost::new(&f.context, settings())?;
    let listed = reopened
        .automation(
            "listSubscriptions",
            &request(&reopened, None, json!({})),
            false,
            2000,
            &cancel,
        )
        .await;
    assert_eq!(
        listed.result.as_ref().unwrap()["page"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        reopened
            .automation("saveSubscription", &create, true, 3000, &cancel)
            .await
            .status,
        IntegrationStatus::Completed
    );
    Ok(())
}

#[tokio::test]
async fn unknown_methods_foreign_scope_external_destination_or_event_provider_never_create_store()
-> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let before = names(&f.profile)?;
    let cancel = CancellationToken::new();
    let mut foreign = request(
        &host,
        Some("save"),
        json!({"draft":draft(),"consentRef":"explicit"}),
    );
    foreign.scope.account_id = "caller-json-is-not-authority".into();
    assert_eq!(
        host.automation("saveSubscription", &foreign, true, 1000, &cancel)
            .await
            .status,
        IntegrationStatus::Rejected
    );
    assert_eq!(
        host.automation(
            "triggerApprovedSubscription",
            &request(&host, Some("trigger"), json!({})),
            true,
            1000,
            &cancel
        )
        .await
        .status,
        IntegrationStatus::Unavailable
    );
    let mut external = draft();
    external.delivery = AutomationDestination::Channel {
        destination_ref: "arbitrary-channel".into(),
        destination_revision: "1".into(),
    };
    assert_eq!(
        host.automation(
            "saveSubscription",
            &request(
                &host,
                Some("external-save"),
                json!({"draft":external,"consentRef":"explicit"})
            ),
            true,
            1000,
            &cancel
        )
        .await
        .status,
        IntegrationStatus::Unavailable
    );
    let mut event = draft();
    event.schedule = None;
    event.event_source = Some("unverified-application-source".into());
    assert_eq!(
        host.automation(
            "saveSubscription",
            &request(
                &host,
                Some("event-save"),
                json!({"draft":event,"consentRef":"explicit"})
            ),
            true,
            1000,
            &cancel
        )
        .await
        .status,
        IntegrationStatus::Unavailable
    );
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}

#[tokio::test]
async fn missing_or_replaced_owned_namespace_is_not_recreated_by_dispatch() -> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let cancel = CancellationToken::new();
    let save = request(
        &host,
        Some("save"),
        json!({"draft":draft(),"consentRef":"explicit"}),
    );
    assert_eq!(
        host.automation("saveSubscription", &save, true, 1000, &cancel)
            .await
            .status,
        IntegrationStatus::Completed
    );
    let owned = host.observe_automation()?.unwrap();
    let namespace = f.profile.join(owned.guard.namespace_id());
    std::fs::rename(&namespace, f.profile.join("original-automation"))?;
    let profile = host.native.profile()?;
    profile.create_private_child(OsStr::new(owned.guard.namespace_id()))?;
    let result = host
        .automation(
            "listSubscriptions",
            &request(&host, None, json!({})),
            false,
            2000,
            &cancel,
        )
        .await;
    assert_eq!(result.status, IntegrationStatus::Unavailable);
    assert!(std::fs::read_dir(namespace)?.next().is_none());
    assert_eq!(
        host.automation("saveSubscription", &save, true, 2000, &cancel)
            .await
            .status,
        IntegrationStatus::Unavailable
    );
    Ok(())
}

#[test]
fn opaque_delivery_use_binds_original_consent_content_and_current_revision_but_preserves_paused_receipt_reads()
-> Result<()> {
    use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.context, settings())?;
    let owned = host.initialize_automation("explicit-delivery-fixture-init")?;
    let mut selected = draft();
    selected.schedule = None;
    selected.event_source = Some("explicit-proof-fixture-source".into());
    selected.delivery = AutomationDestination::Channel {
        destination_ref: "existing-destination".into(),
        destination_revision: "7".into(),
    };
    let consent = ApprovedAutomationConsent::from_explicit_user_action(
        host.scope(),
        "explicit-proof-fixture-consent",
        &selected,
    )?;
    owned.store.save_subscription(
        "explicit-proof-fixture-save",
        0,
        selected.clone(),
        &consent,
        None,
        100,
    )?;
    let run = owned.store.prepare_run(
        &selected.id,
        1,
        "original-fixture-event",
        json!({}),
        None,
        200,
    )?;
    owned.store.record_native_acceptance(
        &run.id,
        "original-fixture-thread",
        Some("original-fixture-turn"),
        201,
    )?;
    owned.store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Declared proof fixture output".into()),
        vec![],
        202,
    )?;
    let run = owned.store.record_delivery(
        &run.id,
        &format!("delivery-{}", run.id),
        AutomationDeliveryStatus::Pending,
        203,
    )?;
    let delivery_id = run.delivery_id.as_deref().unwrap();
    let operation = format!("submit-{delivery_id}");
    let original = request(
        &host,
        Some(&operation),
        json!({"deliveryId":delivery_id,
        "destinationRef":{"id":"existing-destination","revision":"7"},"content":{"text":run.output,"artifactRefs":[]},
        "parentOperationId":run.native_operation_id,"subscriptionRef":{"id":run.subscription_id,"revision":"1"}}),
    );
    let cancel = CancellationToken::new();
    let proof = host.delivery_use("submitDelivery", &original, false, &cancel)?;
    proof.verify_current(&f.context)?;
    assert_eq!(
        proof.original_payload()?,
        Value::Object(original.payload.clone())
    );
    assert_eq!(proof.destination_ref().revision, "7");
    let mut forged = original.clone();
    forged.payload.insert(
        "content".into(),
        json!({"text":"different effect","artifactRefs":[]}),
    );
    assert!(
        host.delivery_use("submitDelivery", &forged, false, &cancel)
            .is_err()
    );
    owned.store.set_subscription_enabled(
        "pause-original-subscription",
        &selected.id,
        1,
        false,
        None,
        204,
    )?;
    assert!(proof.verify_current(&f.context).is_err());
    let read = request(&host, None, json!({"deliveryId":delivery_id}));
    let original_read = host.delivery_use("readDelivery", &read, false, &cancel)?;
    original_read.verify_current(&f.context)?;
    assert_eq!(
        original_read.original_payload()?,
        Value::Object(original.payload.clone())
    );
    let control = request(
        &host,
        Some("explicit-original-cancel"),
        json!({"deliveryId":delivery_id}),
    );
    assert!(
        host.delivery_use("cancelDelivery", &control, false, &cancel)
            .is_err()
    );
    host.delivery_use("cancelDelivery", &control, true, &cancel)?
        .verify_current(&f.context)?;
    host.invalidate_runtime_sources();
    assert!(original_read.verify_current(&f.context).is_err());
    assert_eq!(
        owned.store.read_run(&run.id)?.status,
        AutomationRunStatus::Completed
    );
    Ok(())
}
