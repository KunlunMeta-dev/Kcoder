//! Invoked only by the owned Linux supervisor fixture with its real policy peer.
use super::*;
use serde::Deserialize;
use std::io::{BufRead, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    source_refs: Vec<OfficeResourceRef>,
    expected_sha256: Vec<String>,
}

fn phase(name: &str) -> Result<()> {
    println!("ORG_OFFICE_SOURCE_PHASE:{name}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    ensure!(
        std::io::stdin().lock().read_line(&mut line)? > 0 && line.trim() == "continue",
        "owned source fixture continuation missing"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires the explicit authenticated Linux UID and live organization supervisor"]
async fn actual_uid_accepted_knowledge_sources_recheck_original_pdp() -> Result<()> {
    ensure!(
        std::env::var("KCODER_TEST_ORGANIZATION_OFFICE_SOURCE").as_deref() == Ok("1"),
        "explicit owned source fixture required"
    );
    let input: Input = serde_json::from_str(&std::env::var("KCODER_TEST_OFFICE_SOURCE_REFS")?)?;
    ensure!(input.source_refs.len() == 2 && input.expected_sha256.len() == 2);
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").context("profile missing")?);
    let workspace = std::env::current_dir()?;
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
        .with_settings_persistence_path(profile.join("settings.json"));
    {
        let mut settings = engine.settings.write().unwrap();
        settings.knowledge.enabled = true;
        settings.integrations.knowledge.publications_enabled = true;
        settings.integrations.office.enabled = true;
    }
    let native = NativeIntegrationContext::capture_existing(
        &profile,
        &workspace,
        "actual-owned-office-source-test",
        &engine.active_model_configuration_summary()?.revision,
    )?;
    ensure!(native.scope().organization_id.is_some());
    ensure!(native.organization_policy_revision()?.is_some());
    let cache = Arc::new(Mutex::new(NativeKnowledgeRpc::default()));
    let identity = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "actual-owned-office-source-turn".into(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
    };
    engine.state.add_message(kcoder_types::Message::user_text(
        "Read explicit original knowledge sources in this owned accepted adapter test.",
    ));
    crate::app_server::turn_attempts::begin(
        &engine,
        &identity,
        false,
        None,
        "a".repeat(64),
        "b".repeat(64),
    )?;
    assert!(
        NativeKnowledgeOfficeAssets::capture(&native, &engine, &identity, cache.clone()).is_err()
    );
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: native.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 10_000,
        cancellation_ref: None,
        payload: json!({"task":{"threadId":identity.thread_id,"turnId":identity.turn_id}})
            .as_object()
            .unwrap()
            .clone(),
    };
    let cancel = CancellationToken::new();
    let model = engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let model =
                NativeKnowledgeOfficeAssets::capture(&native, &engine, &identity, cache.clone())?;
            let read = model
                .validate_sources(&native, &request, &input.source_refs, &cancel)
                .await?;
            assert_eq!(
                read.iter().map(|item| &item.sha256).collect::<Vec<_>>(),
                input.expected_sha256.iter().collect::<Vec<_>>()
            );
            let mut guessed = request.clone();
            guessed.payload.get_mut("task").unwrap()["turnId"] = json!("guessed-task");
            assert!(
                model
                    .validate_sources(&native, &guessed, &input.source_refs, &cancel)
                    .await
                    .is_err()
            );
            let mut wrong_version = input.source_refs.clone();
            wrong_version[0].revision = "2".into();
            assert!(
                model
                    .validate_sources(&native, &request, &wrong_version, &cancel)
                    .await
                    .is_err()
            );
            phase("revoke-use")?;
            for reference in &input.source_refs {
                assert!(
                    model
                        .validate_sources(
                            &native,
                            &request,
                            std::slice::from_ref(reference),
                            &cancel
                        )
                        .await
                        .is_err()
                );
            }
            phase("restore-use")?;
            assert_eq!(
                model
                    .validate_sources(&native, &request, &input.source_refs, &cancel)
                    .await?,
                read
            );
            Ok::<_, anyhow::Error>(model)
        })
        .await?;
    crate::app_server::turn_attempts::finish(
        &engine,
        &identity,
        "completed",
        None,
        None,
        &crate::app_server::turn_attempts::PartialOutput::default(),
    )?;
    assert!(
        model
            .validate_sources(&native, &request, &input.source_refs, &cancel)
            .await
            .is_err()
    );
    let mut management = request.clone();
    management.payload.remove("task");
    let read = validate_management_office_knowledge_sources(
        &native,
        &engine,
        &cache,
        &management,
        &input.source_refs,
        &cancel,
    )
    .await?;
    assert_eq!(read.len(), 2);
    phase("revoke-read")?;
    assert!(
        validate_management_office_knowledge_sources(
            &native,
            &engine,
            &cache,
            &management,
            &input.source_refs,
            &cancel,
        )
        .await
        .is_err()
    );
    println!(
        "ORG_OFFICE_SOURCE_EVIDENCE:actual-uid-live-peer-original-accepted-fixed-hashes-current-read-use"
    );
    Ok(())
}
