//! These cases test private metadata CAS around a real accepted Code workflow.
//! They do not construct a C28 seal or claim source/child admission by fixture data.
use super::*;
use crate::app_server::integrations::core::runtime_driver::test_support::{
    Fixture, FixtureInstaller, resident, shutdown,
};
use crate::app_server::thread_runtime::ThreadManager;
use kcoder_tools::{ToolRegistry, WorkflowTool};
use serde_json::json;

fn replace_workflow_facts_digest(intent: &mut ChildIntent, digest: String) -> Result<()> {
    let mut persisted = serde_json::to_value(&*intent)?;
    persisted["workflowFactsSha256"] = json!(digest);
    *intent = serde_json::from_value(persisted)?;
    Ok(())
}

async fn fixture() -> Result<(
    Fixture,
    NativeRuntimeDriver,
    ThreadManager,
    RuntimeBinding,
    ChildIntent,
)> {
    let fixture = Fixture::new();
    let (mut manager, engine) = resident(&fixture).await;
    let engine = engine
        .with_turn_tools(ToolRegistry::new().register(WorkflowTool))
        .with_settings_persistence_path(fixture.profile.join("settings.json"));
    manager.replace_host_turn_engine(&engine.session_id(), engine.clone())?;
    let library =
        kcoder_workflow::store::WorkflowStore::new(fixture.profile.join("workflow-library"));
    let draft = library.create(
        "Actual metadata CAS Code run",
        "No model or child is executed by this storage test",
    )?;
    let draft = library.upsert_node(&draft.id, draft.revision, serde_json::from_value(json!({"id":"derive","title":"Return local metadata fixture result","kind":"code","config":{"code":{"source":"return {ready:true};","timeoutMs":1000}}}))?)?;
    let definition = library.save(&draft.id, draft.revision)?;
    let mut spec = fixture.spec();
    spec.existing_thread_id = Some(engine.session_id());
    spec.configuration.model.model = engine.active_model_configuration_summary()?;
    spec.configuration.allowed_tools = Some(vec!["Workflow".into()]);
    spec.configuration.workflow = Some(RuntimeWorkflowSpec::from_native_source(
        &fixture.context,
        &definition.id,
        1,
        json!({}),
    )?);
    let request = fixture.request("actual-child-storage-cas");
    let mut driver = fixture.driver();
    ensure!(
        matches!(
            driver.accept_task(&fixture.context, &request, spec)?,
            RuntimeSubmission::Queued
        ),
        "actual native workflow not queued"
    );
    let Some(NativeRuntimeCommand::Configure { ticket, .. }) =
        driver.next_command(&fixture.context)?
    else {
        anyhow::bail!("actual configure missing")
    };
    driver.configure_command(
        &fixture.context,
        &ticket,
        &mut manager,
        Some(&FixtureInstaller),
    )?;
    let Some(NativeRuntimeCommand::StartWorkflow {
        ticket, thread_id, ..
    }) = driver.next_command(&fixture.context)?
    else {
        anyhow::bail!("actual workflow launch missing")
    };
    let engine = manager
        .engine(&thread_id)
        .context("actual parent unavailable")?;
    let job = driver.prepare_workflow_launch(
        &fixture.context,
        &ticket,
        engine,
        Some(Arc::new(FixtureInstaller)),
    )?;
    driver.observe_workflow_launch(&fixture.context, &ticket, job.run().await)?;
    let binding = driver
        .storage()
        .bindings()
        .get("actual-child-storage-cas")?
        .context("actual binding missing")?;
    let receipt = driver
        .read_operation(&fixture.context, &binding.operation_id)?
        .context("actual Core receipt missing")?;
    let accepted = receipt
        .runtime_acceptance
        .as_ref()
        .context("actual native acceptance missing")?;
    let workflow = binding.spec.configuration.workflow.as_ref().unwrap();
    let source = NativeWorkflowParentFacts {
        operation_id: binding.operation_id.clone(),
        receipt_revision: receipt.revision,
        runtime_acceptance_sha256: sha(&(
            IntegrationOwner::from(fixture.context.scope()),
            binding.operation_id.as_str(),
            accepted,
        ))?,
        workflow_task_id: accepted
            .task_id
            .clone()
            .context("actual workflow task missing")?,
        definition_id: workflow.definition_id.clone(),
        definition_version: workflow.version,
        node_id: "derive".into(),
        source_revision: "a".repeat(64),
    };
    // This tuple is storage-format data only. No child request or authority can
    // be manufactured from it; the public prepare API requires a real C28 seal.
    let intent = ChildIntent::from_parent_facts(
        &binding,
        &source,
        workflow.definition_sha256.as_deref().unwrap(),
        &sha(&workflow.args)?,
        BackgroundRunKey {
            parent_session_id: accepted.thread_id.clone(),
            agent_id: "storage-format-child".into(),
            run_id: uuid::Uuid::new_v4().to_string(),
        },
        TurnAttemptIdentity {
            thread_id: uuid::Uuid::new_v4().to_string(),
            turn_id: uuid::Uuid::new_v4().to_string(),
            attempt_id: uuid::Uuid::new_v4().to_string(),
        },
        &"b".repeat(64),
        &"c".repeat(64),
    )?;
    Ok((fixture, driver, manager, binding, intent))
}

#[tokio::test]
async fn original_binding_cas_preserves_prepared_child_across_stale_writes_and_reopen() -> Result<()>
{
    let (fixture, driver, manager, binding, intent) = fixture().await?;
    let result = (|| -> Result<()> {
        let mut first = binding.clone();
        first.child_intents.push(ChildIntentRecord {
            intent: intent.clone(),
            phase: ChildIntentPhase::Prepared,
        });
        let saved = driver
            .storage()
            .bindings()
            .save(first, Some(binding.revision))?;
        ensure!(
            driver
                .storage()
                .bindings()
                .save(binding.clone(), Some(binding.revision))
                .is_err(),
            "stale writer erased intent"
        );
        let reopened = ExistingBindings::open(&fixture.context)?;
        let current = reopened
            .bindings
            .get(&binding.operation_id)?
            .context("binding lost")?;
        ensure!(
            current.revision == saved.revision
                && current.child_intents.len() == 1
                && current.child_intents[0].intent == intent,
            "original child intent changed"
        );
        Ok(())
    })();
    shutdown(manager).await;
    result
}

#[tokio::test]
async fn same_background_run_cannot_change_child_identity_input_or_source() -> Result<()> {
    let (_fixture, driver, manager, binding, intent) = fixture().await?;
    let result = (|| -> Result<()> {
        let mut initial = binding.clone();
        initial.child_intents.push(ChildIntentRecord {
            intent,
            phase: ChildIntentPhase::Prepared,
        });
        let saved = driver
            .storage()
            .bindings()
            .save(initial, Some(binding.revision))?;
        for field in 0..4 {
            let mut changed = saved.clone();
            let intent = &mut changed.child_intents[0].intent;
            match field {
                0 => intent.child_identity.thread_id = uuid::Uuid::new_v4().to_string(),
                1 => intent.input_hash = "d".repeat(64),
                2 => intent.fingerprint = "e".repeat(64),
                _ => {
                    intent.source_revision = "f".repeat(64);
                    let digest = facts(intent).sha256();
                    replace_workflow_facts_digest(intent, digest)?;
                }
            }
            ensure!(
                driver
                    .storage()
                    .bindings()
                    .save(changed, Some(saved.revision))
                    .is_err(),
                "same run intent was rewritten"
            );
        }
        Ok(())
    })();
    shutdown(manager).await;
    result
}

#[tokio::test]
async fn accepted_metadata_cannot_regress_and_wrong_task_definition_or_digest_is_rejected()
-> Result<()> {
    let (_fixture, driver, manager, binding, intent) = fixture().await?;
    let result = (|| -> Result<()> {
        let mut initial = binding.clone();
        initial.child_intents.push(ChildIntentRecord {
            intent,
            phase: ChildIntentPhase::Prepared,
        });
        let prepared = driver
            .storage()
            .bindings()
            .save(initial, Some(binding.revision))?;
        let mut marked = prepared.clone();
        marked.child_intents[0].phase = ChildIntentPhase::Accepted;
        let accepted = driver
            .storage()
            .bindings()
            .save(marked, Some(prepared.revision))?;
        let mut regressed = accepted.clone();
        regressed.child_intents[0].phase = ChildIntentPhase::Prepared;
        ensure!(
            driver
                .storage()
                .bindings()
                .save(regressed, Some(accepted.revision))
                .is_err(),
            "accepted metadata regressed"
        );
        for field in 0..3 {
            let mut wrong = binding.clone();
            let mut record = accepted.child_intents[0].clone();
            match field {
                0 => record.intent.workflow_task_id = "another-actual-task".into(),
                1 => record.intent.definition_version += 1,
                _ => replace_workflow_facts_digest(&mut record.intent, "0".repeat(64))?,
            }
            wrong.child_intents.push(record);
            ensure!(
                validate_records(&wrong).is_err(),
                "foreign native reference was accepted"
            );
        }
        Ok(())
    })();
    shutdown(manager).await;
    result
}

#[tokio::test]
async fn child_metadata_reloads_after_actual_peer_cas_without_losing_original_intent() -> Result<()>
{
    let (fixture, driver, manager, binding, intent) = fixture().await?;
    let mut attempts = 0;
    let result = retry_child_metadata_prewrite(|| {
        attempts += 1;
        let mut current = driver
            .storage()
            .bindings()
            .get(&binding.operation_id)?
            .unwrap();
        if attempts == 1 {
            let peer = ExistingBindings::open(&fixture.context)?;
            peer.bindings
                .save(current.clone(), Some(current.revision))?;
        }
        let revision = current.revision;
        current.child_intents.push(ChildIntentRecord {
            intent: intent.clone(),
            phase: ChildIntentPhase::Prepared,
        });
        driver.storage().bindings().save(current, Some(revision))
    })
    .await;
    shutdown(manager).await;
    let saved = result?;
    assert_eq!(attempts, 2);
    assert_eq!(saved.revision, binding.revision + 2);
    assert_eq!(saved.acceptance, binding.acceptance);
    assert_eq!(saved.child_intents.len(), 1);
    assert_eq!(saved.child_intents[0].intent, intent);
    Ok(())
}

#[tokio::test]
async fn child_metadata_waits_only_for_its_actual_prewrite_lock() -> Result<()> {
    let (fixture, driver, manager, binding, intent) = fixture().await?;
    let original = ExistingBindings::open(&fixture.context)?;
    let directory = original
        .directory
        .open_entry_handle(OsStr::new("runtime-bindings"))?
        .open_child_directory()?;
    let identity = directory.portable_regular_identity(OsStr::new("bindings.lock"))?;
    let mut held = Some(
        directory
            .try_existing_portable_lock(
                OsStr::new("bindings.lock"),
                &identity,
                kcoder_config::PrivateLeaseMode::Exclusive,
            )?
            .context("test lock unavailable")?,
    );
    let mut attempts = 0;
    let result = retry_child_metadata_prewrite(|| {
        attempts += 1;
        let mut current = driver
            .storage()
            .bindings()
            .get(&binding.operation_id)?
            .unwrap();
        let revision = current.revision;
        current.child_intents.push(ChildIntentRecord {
            intent: intent.clone(),
            phase: ChildIntentPhase::Prepared,
        });
        let result = driver.storage().bindings().save(current, Some(revision));
        if attempts == 1 {
            held.take();
        }
        result
    })
    .await;
    shutdown(manager).await;
    let saved = result?;
    assert_eq!(attempts, 2);
    assert_eq!(saved.revision, binding.revision + 1);
    assert_eq!(saved.child_intents[0].intent, intent);
    Ok(())
}

#[tokio::test]
async fn unconfirmed_postwrite_metadata_never_retries_from_an_error_string() -> Result<()> {
    let (_fixture, driver, manager, binding, intent) = fixture().await?;
    let mut attempts = 0;
    let result: Result<()> = retry_child_metadata_prewrite(|| {
        attempts += 1;
        let mut current = binding.clone();
        current.child_intents.push(ChildIntentRecord {
            intent: intent.clone(),
            phase: ChildIntentPhase::Prepared,
        });
        driver
            .storage()
            .bindings()
            .save(current, Some(binding.revision))?;
        // A lost post-write observation can contain the same text, but it is
        // not the typed, proven prewrite conflict and cannot authorize replay.
        anyhow::bail!("RUNTIME_BINDING_CONFLICT")
    })
    .await;
    let saved = driver
        .storage()
        .bindings()
        .get(&binding.operation_id)?
        .unwrap();
    shutdown(manager).await;
    assert!(result.is_err());
    assert_eq!(attempts, 1);
    assert_eq!(saved.revision, binding.revision + 1);
    assert_eq!(saved.child_intents[0].intent, intent);
    Ok(())
}
