use super::*;
use kcoder_config::storage::{StorageResolveInput, resolve_storage_paths};
use kcoder_native_journal::NativeOperations;
use kcoder_native_scope::NativeDomainGuard;
use kcoder_state::integrations::core::{
    budgets::*,
    remote_delegations::{NativeRemotePlan, NativeRemoteStage, NativeRemoteStageState},
};
use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;
use kcoder_types::integrations::{core::*, knowledge::*};
use kcoder_types::{
    CronSchedule, STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use serde_json::json;
use std::collections::BTreeMap;

fn publish(
    root: &Path,
    from: &Path,
    to: &Path,
    id: &str,
) -> Result<(StorageCoordinator, StoragePublishedComponent)> {
    let home = root.join(format!("control-{id}"));
    PrivateDirectory::open_existing(root)?.create_private_child(home.file_name().unwrap())?;
    let mut owner = StorageCoordinator::acquire(&home)?;
    owner.begin(StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: to.into(),
            cache_root: root.join(format!("cache-{id}")),
            operation_id: Some(id.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: from.into(),
            destination: to.into(),
            source_identity: PrivateDirectory::open_existing(from)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })?;
    owner.advance(id, Phase::Planned, Phase::Stopping)?;
    owner.advance(id, Phase::Stopping, Phase::Stopped)?;
    owner.advance(id, Phase::Stopped, Phase::Copying)?;
    owner.publish_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN, &Default::default())?;
    let published = owner.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    Ok((owner, published))
}

#[tokio::test]
async fn retired_channel_domains_keep_original_markers_and_payloads_across_two_moves() -> Result<()>
{
    use kcoder_state::domain_storage::legacy_channel::LEGACY_CHANNEL_DOMAINS;

    let root = tempfile::tempdir()?;
    let base = PrivateDirectory::open_existing(root.path())?;
    let source_path = root.path().join("source");
    let profile = base.create_private_child(OsStr::new("source"))?;
    base.create_private_child(OsStr::new("workspace"))?;
    let native = NativeIntegrationContext::capture(
        &source_path,
        &root.path().join("workspace"),
        "owned",
        "revision",
    )?;
    let scope = native.scope().clone();
    let payload = b"{\"operationId\":\"original-retired-operation\",\"state\":\"unknown\"}\n";
    let mut originals = BTreeMap::new();
    for domain in LEGACY_CHANNEL_DOMAINS {
        let (guard, ()) = NativeDomainGuard::initialize(
            &profile,
            &scope,
            domain,
            "original-retired-domain",
            |directory| directory.atomic_replace(OsStr::new("original.jsonl"), payload),
        )?;
        let marker = PathBuf::from(format!(".{}.jsonl", guard.namespace_id()));
        let bytes = std::fs::read(source_path.join(&marker))?;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                bytes.split(|b| *b == b'\n').next().unwrap()
            )?["version"],
            1
        );
        originals.insert(marker, bytes);
        originals.insert(
            PathBuf::from(guard.namespace_id()).join("original.jsonl"),
            payload.to_vec(),
        );
    }
    drop(native);

    for (from, to) in [("source", "first"), ("first", "second")] {
        let from = root.path().join(from);
        let target_path = root.path().join(to);
        let source = PrivateDirectory::open_existing(&from)?;
        let (global, identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(&source, "revision")?.unwrap();
        let owners = NativeProfileDomainOwners::observe(&from, "revision")?.unwrap();
        assert_eq!(
            owners.inventory.domains().len(),
            LEGACY_CHANNEL_DOMAINS.len() + 1
        );
        assert_eq!(owners.source_count(), 0);
        assert!(!owners.requires_owner_runtime());
        let (mut coordinator, published) = publish(root.path(), &from, &target_path, to)?;
        identity.relocate(&source, published.directory(), &global, to, &snapshot)?;
        owners.finish(&mut coordinator, &published, None).await?;
        let current = NativeProfileDomainOwners::observe(&target_path, "revision")?.unwrap();
        assert_eq!(current.snapshot(), &snapshot);
        assert_eq!(
            current.inventory.domains().len(),
            LEGACY_CHANNEL_DOMAINS.len() + 1
        );
        for (relative, bytes) in &originals {
            assert_eq!(std::fs::read(target_path.join(relative))?, *bytes);
            assert_eq!(std::fs::read(source_path.join(relative))?, *bytes);
        }
        // The production task-workspace fence still observes the original
        // credential namespace, without loading or interpreting its contents.
        let credentials = NativeDomainGuard::observe(
            published.directory(),
            &scope,
            NativeDomain::ConnectivityCredentials,
        )?
        .unwrap();
        credentials.directory(published.directory())?;
        let marker_name = format!(".{}.jsonl", credentials.namespace_id());
        let marker = OsStr::new(&marker_name);
        let original = std::fs::read(target_path.join(marker))?;
        published.directory().atomic_replace(marker, b"{}\n")?;
        assert!(NativeProfileDomainOwners::observe(&target_path, "revision").is_err());
        published.directory().atomic_replace(marker, &original)?;
        NativeProfileDomainOwners::observe(&target_path, "revision")?.unwrap();
        coordinator.advance(to, Phase::Copying, Phase::Verifying)?;
        coordinator.advance(to, Phase::Verifying, Phase::Prepared)?;
        coordinator.commit(to)?;
        coordinator.complete(to)?;
    }
    Ok(())
}

#[tokio::test]
async fn memory_operation_receipts_and_current_business_stores_move_twice_without_replay()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let base = PrivateDirectory::open_existing(root.path())?;
    let source_path = root.path().join("source");
    let profile = base.create_private_child(OsStr::new("source"))?;
    base.create_private_child(OsStr::new("workspace"))?;
    let native = NativeIntegrationContext::capture(
        &source_path,
        &root.path().join("workspace"),
        "owned",
        "revision",
    )?;
    let scope = native.scope().clone();
    // This is the same NativeOperations ingress used before Memory's domain write.
    let ledger = NativeOperations::initialize(&native, "memory-initialize-operations")?;
    let request: IntegrationRequest = serde_json::from_value(json!({
        "contractVersion":"parallel-v1", "requestId":"memory-request", "scope":scope,
        "operationId":"memory-propose", "expectedRevision":null, "timeoutMs":1000,
        "cancellationRef":null, "payload":{"title":"Original memory"}
    }))?;
    let (executing, execute) = ledger.begin_memory(&native, &request, "propose")?;
    assert!(execute);
    let (memory_domain, memory) = NativeDomainGuard::initialize(
        &profile,
        &scope,
        NativeDomain::Memory,
        "memory-initialize",
        |directory| MemoryReviewStore::create_in(directory, OsStr::new("data"), &scope),
    )?;
    let candidate = memory.propose(
        "memory-propose",
        MemoryProposal {
            title: "Original memory".into(),
            content: "Keep the original receipt".into(),
            category: "preference".into(),
            origin: MemoryOrigin::Manual,
            provenance: vec![MemoryProvenance {
                kind: "explicit_user_message".into(),
                source_id: "original-message".into(),
                source_revision: "1".into(),
                description: "Owned synthetic fixture".into(),
            }],
            valid_until_ms: None,
        },
        100,
    )?;
    memory.review(
        "memory-review",
        &candidate.id,
        1,
        MemoryReview::Accept {
            edited_content: None,
        },
        101,
    )?;
    let frozen = memory.capture_task_snapshot("original-accepted-turn", 102)?;
    let unknown = ledger.transition(
        &native,
        &executing,
        IntegrationOperationPhase::Unknown,
        Some(IntegrationError {
            code: "MEMORY_WRITE_UNCONFIRMED".into(),
            recovery: IntegrationRecovery::ReconcileOriginal,
            message_key: "operation.unknown".into(),
        }),
    )?;
    let (policy_domain, _) = NativeDomainGuard::initialize(
        &profile,
        &scope,
        NativeDomain::Policy,
        "policy-initialize",
        |directory| NativeDelegationAuthority::create_in(directory, OsStr::new("issuer"), &scope),
    )?;
    let (automation_domain, automation) = NativeDomainGuard::initialize(
        &profile,
        &scope,
        NativeDomain::Automation,
        "automation-initialize",
        |directory| AutomationStore::create_in(directory, OsStr::new("store"), &scope),
    )?;
    let draft = AutomationSubscriptionDraft {
        id: "owned-subscription".into(),
        title: "Original automation".into(),
        workflow_id: "original-workflow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({"original":"input"}),
        schedule: Some(CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 5000,
        period_budget: None,
        maximum_runtime_seconds: 120,
        delivery: AutomationDestination::Studio,
    };
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "fixture-consent", &draft)?;
    let subscription =
        automation.save_subscription("save-original", 0, draft, &consent, Some(1000), 100)?;
    let run = automation.prepare_run(
        &subscription.draft.id,
        subscription.revision,
        "original-trigger",
        json!({"original":"facts"}),
        Some(2000),
        1000,
    )?;
    automation.record_native_acceptance(&run.id, "original-thread", Some("original-turn"), 1001)?;
    let run = automation.record_native_status(
        &run.id,
        AutomationRunStatus::Unknown,
        None,
        vec![],
        1002,
    )?;
    let subscription = automation.read_subscription(&subscription.draft.id)?;
    let (resources_domain, resources) = NativeDomainGuard::initialize(
        &profile,
        &scope,
        NativeDomain::WorkspaceResources,
        "resources-initialize",
        |directory| {
            ResourceStore::create_in(
                directory,
                OsStr::new("data"),
                IntegrationOwner::from(&scope),
            )
        },
    )?;
    let definition = serde_json::from_value(json!({
        "schemaVersion":1,"id":"original-definition","scope":"personal","title":"Original definition","description":"Preserved",
        "language":"en","inputSchema":{"type":"object"},"instructions":"Keep original sources",
        "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Original evidence"],"externalSend":"ask"
    }))?;
    let definition = resources.save_draft("original-definition-save", definition, None, 100)?;
    let mut account = scope.clone();
    account.workspace_id = IntegrationNullable::Null;
    let (budget_domain, budget) = NativeDomainGuard::initialize(
        &profile,
        &account,
        NativeDomain::Budgets,
        "budget-initialize",
        |directory| NativeBudgetStore::create_in(directory, OsStr::new("ledger"), &account),
    )?;
    let budget_policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "original-budget".into(),
        version: 1,
        revision: "original-policy".into(),
        scope: BudgetScope::Account(scope.account_id.clone()),
        window: BudgetWindow {
            id: "original-window".into(),
            starts_at_ms: 0,
            ends_at_ms: 1000,
        },
        limits: BudgetLimits {
            tokens: Some(100),
            concurrent_calls: Some(2),
            ..Default::default()
        },
        currency: None,
    })?;
    let budget_request = NativeBudgetRequest {
        reservation_id: "original-reservation".into(),
        operation_id: "original-budget-operation".into(),
        principal: NativeBudgetPrincipal::from_native_facts(
            scope.account_id.clone(),
            None,
            Some("original-workspace".into()),
            None,
        )?,
        unit: BudgetUnit::ModelCall,
        task: BudgetTaskLink {
            root_operation_id: "original-root-operation".into(),
            root_task: Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Turn,
                id: "original-native-turn".into(),
                revision: None,
            }),
            actor: BudgetActor::Main,
            actor_attempt_id: "original-attempt".into(),
            parent_reservation_id: None,
        },
        estimate: BudgetCharge {
            tokens: 70,
            model_calls: 1,
            run_millis: 100,
            cost_micros: None,
        },
    };
    let reservation = budget
        .reserve(&budget_request, &[budget_policy.clone()], 100)?
        .receipt()
        .clone();
    let (remote_domain, remote) = NativeDomainGuard::initialize(
        &profile,
        &scope,
        NativeDomain::RemoteDelegations,
        "remote-initialize",
        |directory| NativeRemoteDelegationStore::create_in(directory, OsStr::new("data"), &scope),
    )?;
    let remote_plan = NativeRemotePlan {
        operation_id: "original-remote-operation".into(),
        scope: scope.clone(),
        public_intent: json!({"prompt":"Keep the original remote intent"}),
        recipient_revision: "original-recipient-revision".into(),
        recipient_identity: json!({"nativeOwner":"original-receiver"}),
    };
    remote.begin(&remote_plan)?;
    let dispatch = remote.before_dispatch(
        &remote_plan.operation_id,
        &scope,
        NativeRemoteStage::Spawn,
        &json!({"original":"dispatch"}),
    )?;
    let remote_unknown = remote.unknown(&dispatch)?;
    let operations_namespace =
        NativeDomainGuard::expected_namespace_id(&scope, NativeDomain::Operations)?;
    let placements = [
        (
            memory_domain.namespace_id().to_owned(),
            "data",
            "memory-binding.json",
        ),
        (
            policy_domain.namespace_id().to_owned(),
            "issuer",
            "issuer-lock-placement.json",
        ),
        (operations_namespace.clone(), "data", "owner.json"),
        (
            automation_domain.namespace_id().to_owned(),
            "store",
            "automation-binding.json",
        ),
        (
            resources_domain.namespace_id().to_owned(),
            "data",
            "office-header.json",
        ),
        (
            budget_domain.namespace_id().to_owned(),
            "ledger",
            "owner.json",
        ),
        (
            remote_domain.namespace_id().to_owned(),
            "data",
            "owner.json",
        ),
    ];
    let mut originals = BTreeMap::new();
    for (namespace, leaf, header) in &placements {
        for entry in std::fs::read_dir(source_path.join(namespace).join(leaf))? {
            let entry = entry?;
            if entry.file_name() != *header
                && !entry.file_name().to_string_lossy().ends_with(".lock")
            {
                originals.insert(
                    PathBuf::from(namespace).join(leaf).join(entry.file_name()),
                    std::fs::read(entry.path())?,
                );
            }
        }
    }
    drop((ledger, memory, automation, resources, budget, remote));
    for (index, (from, to)) in [("source", "first"), ("first", "second")]
        .into_iter()
        .enumerate()
    {
        let from = root.path().join(from);
        let target_path = root.path().join(to);
        let profile = PrivateDirectory::open_existing(&from)?;
        let (global, identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(&profile, "revision")?.unwrap();
        let owners = NativeProfileDomainOwners::observe(&from, "revision")?.unwrap();
        assert_eq!(owners.source_count(), 7);
        assert!(!owners.requires_owner_runtime());
        let (mut coordinator, published) = publish(root.path(), &from, &target_path, to)?;
        identity.relocate(&profile, published.directory(), &global, to, &snapshot)?;
        if index == 0 {
            let operations = profile
                .open_child(OsStr::new(&operations_namespace), false)?
                .open_child(OsStr::new("data"), false)?;
            let id = operations.portable_regular_identity(OsStr::new("operations.lock"))?;
            let held = operations
                .try_existing_portable_lock(
                    OsStr::new("operations.lock"),
                    &id,
                    kcoder_config::PrivateLeaseMode::Exclusive,
                )?
                .unwrap();
            assert!(
                owners
                    .finish(&mut coordinator, &published, None)
                    .await
                    .is_err()
            );
            drop(held);
            NativeProfileDomainOwners::observe(&from, "revision")?
                .unwrap()
                .finish(&mut coordinator, &published, None)
                .await?;
        } else {
            owners.finish(&mut coordinator, &published, None).await?;
        }
        let original_owners = NativeProfileDomainOwners::observe(&from, "revision")?.unwrap();
        original_owners.verify_placements(&published)?;
        let target = published.directory();
        let memory = MemoryReviewStore::open_in(
            &target.open_child(OsStr::new(memory_domain.namespace_id()), false)?,
            OsStr::new("data"),
            &scope,
        )?;
        assert_eq!(
            memory.read_operation_result("memory-propose")?,
            Some(candidate.clone())
        );
        assert_eq!(
            memory.read_task_snapshot("original-accepted-turn")?,
            Some(frozen.clone())
        );
        let operations = IntegrationOperationStore::open_in(
            &target.open_child(OsStr::new(&operations_namespace), false)?,
            OsStr::new("data"),
            &scope,
        )?;
        assert_eq!(operations.read("memory-propose")?, Some(unknown.clone()));
        let automation = AutomationStore::open_in(
            &target.open_child(OsStr::new(automation_domain.namespace_id()), false)?,
            OsStr::new("store"),
            &scope,
        )?;
        assert_eq!(automation.read_run(&run.id)?, run);
        assert_eq!(
            serde_json::to_value(automation.read_subscription(&subscription.draft.id)?)?,
            serde_json::to_value(&subscription)?
        );
        let resources = ResourceStore::open_in(
            &target.open_child(OsStr::new(resources_domain.namespace_id()), false)?,
            OsStr::new("data"),
            IntegrationOwner::from(&scope),
        )?
        .unwrap();
        assert_eq!(
            resources.read_draft("original-definition")?,
            Some(definition.clone())
        );
        let budget = NativeBudgetStore::open_in(
            &target.open_child(OsStr::new(budget_domain.namespace_id()), false)?,
            OsStr::new("ledger"),
            &account,
        )?
        .unwrap();
        assert_eq!(
            budget.read_reservation("original-reservation")?,
            Some(reservation.clone())
        );
        assert_eq!(
            budget
                .observe_policy(&budget_policy)?
                .unwrap()
                .charged
                .tokens,
            70
        );
        let remote = NativeRemoteDelegationStore::open_in(
            &target.open_child(OsStr::new(remote_domain.namespace_id()), false)?,
            OsStr::new("data"),
            &scope,
        )?
        .unwrap();
        let observed = remote.read(&remote_plan.operation_id)?.unwrap();
        assert_eq!(observed.revision, remote_unknown.revision);
        assert_eq!(
            observed.stages[&NativeRemoteStage::Spawn],
            NativeRemoteStageState::Unknown
        );
        assert!(
            remote
                .before_dispatch(
                    &remote_plan.operation_id,
                    &scope,
                    NativeRemoteStage::Spawn,
                    &json!({"original":"dispatch"})
                )
                .is_err()
        );
        for (relative, bytes) in &originals {
            assert_eq!(std::fs::read(target_path.join(relative))?, *bytes);
            assert_eq!(std::fs::read(source_path.join(relative))?, *bytes);
        }
        for (namespace, leaf, header) in &placements {
            let directory = target
                .open_child(OsStr::new(namespace), false)?
                .open_child(OsStr::new(leaf), false)?;
            let path = target_path.join(namespace).join(leaf).join(header);
            let bytes = std::fs::read(&path)?;
            if *header != "issuer-lock-placement.json" {
                let mut original: serde_json::Value = serde_json::from_slice(&std::fs::read(
                    source_path.join(namespace).join(leaf).join(header),
                )?)?;
                let mut current: serde_json::Value = serde_json::from_slice(&bytes)?;
                for field in ["lock_identity", "lockIdentity"] {
                    original.as_object_mut().unwrap().remove(field);
                    current.as_object_mut().unwrap().remove(field);
                }
                assert_eq!(current, original, "only the current writer pin may change");
            }
            directory.atomic_replace(OsStr::new(header), b"{}")?;
            assert!(original_owners.verify_placements(&published).is_err());
            assert_eq!(std::fs::read(&path)?, b"{}");
            directory.atomic_replace(OsStr::new(header), &bytes)?;
        }
        original_owners.verify_placements(&published)?;
        coordinator.advance(to, Phase::Copying, Phase::Verifying)?;
        coordinator.advance(to, Phase::Verifying, Phase::Prepared)?;
        coordinator.commit(to)?;
        coordinator.complete(to)?;
    }
    Ok(())
}
