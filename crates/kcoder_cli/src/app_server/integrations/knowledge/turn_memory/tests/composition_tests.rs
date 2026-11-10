use super::*;
use crate::app_server::integrations::knowledge::{
    prepare_native_turn_memory, request_native_memory_snapshot,
};
use kcoder_types::integrations::core::{
    IntegrationContractVersion, IntegrationRequest, IntegrationStatus,
};

fn request(f: &Fixture, thread: &str, task: &str) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: f.native.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: json!({"threadId":thread,"taskId":task})
            .as_object()
            .unwrap()
            .clone(),
    }
}
async fn prepared(f: &Fixture) -> Result<(TurnAttemptIdentity, String)> {
    let identity = accepted(f)?;
    let id = f
        .engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let prepared = prepare_current_turn_memory(
                &f.native,
                &identity,
                &f.engine,
                Some(f.source.clone()),
            )?
            .context("no prepared input")?;
            Ok::<_, anyhow::Error>(prepared.snapshot_id().to_string())
        })
        .await?;
    Ok((identity, id))
}

#[tokio::test]
async fn direct_composition_false_preserves_the_original_engine_without_context_source_or_acceptance()
-> Result<()> {
    let f = fixture(false, None)?;
    let before = std::fs::read(
        f.native
            .profile_path()?
            .join(f.source.guard.namespace_id())
            .join("data/memory-review.json"),
    )?;
    let fake = TurnAttemptIdentity {
        thread_id: "payload-no-proof".into(),
        turn_id: "user-marked-accepted".into(),
        attempt_id: "not-real".into(),
    };
    let engine = prepare_native_turn_memory(f.engine.clone(), None, &fake)?;
    assert!(engine.state.shares_state_with(&f.engine.state));
    assert!(engine.native_reviewed_memory_snapshot_id().is_none());
    assert!(Arc::ptr_eq(
        &engine.current_provider(),
        &f.engine.current_provider()
    ));
    assert_eq!(
        std::fs::read(
            f.native
                .profile_path()?
                .join(f.source.guard.namespace_id())
                .join("data/memory-review.json")
        )?,
        before
    );
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn direct_composition_loads_the_existing_real_core_service_and_sends_three_frozen_requests()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    let native = f.native.recapture_for_owned_service()?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            let engine = prepare_native_turn_memory(f.engine.clone(), Some(native), &identity)?;
            let snapshot_id = engine
                .native_reviewed_memory_snapshot_id()
                .context("missing native preparation locator")?;
            let reply = request_native_memory_snapshot(
                &request(&f, &engine.session_id(), snapshot_id),
                &engine,
                &f.native,
            );
            assert_eq!(reply.status, IntegrationStatus::Completed);
            assert_eq!(
                reply.result.as_ref().unwrap()["snapshot"]["taskId"],
                snapshot_id
            );
            let events = engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4)
                .collect::<Vec<_>>()
                .await;
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_)))
            );
            let requests = f.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            let first = memory_text(&requests[0]);
            assert_eq!(first.len(), 1);
            assert!(requests.iter().all(|request| memory_text(request) == first));
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn direct_composition_true_rejects_missing_context_and_real_unaccepted_scope() -> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let fake = TurnAttemptIdentity {
        thread_id: f.engine.session_id(),
        turn_id: "payload-accepted".into(),
        attempt_id: "no-private-record".into(),
    };
    assert!(prepare_native_turn_memory(f.engine.clone(), None, &fake).is_err());
    f.engine
        .state
        .history_attempt_scope(fake.clone())?
        .run(async {
            assert!(
                prepare_native_turn_memory(
                    f.engine.clone(),
                    Some(f.native.recapture_for_owned_service()?),
                    &fake
                )
                .is_err()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    let real = accepted(&f)?;
    assert!(
        prepare_native_turn_memory(
            f.engine.clone(),
            Some(f.native.recapture_for_owned_service()?),
            &real
        )
        .is_err()
    );
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn direct_composition_missing_committed_core_namespace_is_not_initialized_or_downgraded()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let identity = accepted(&f)?;
    let namespace = f.source.guard.namespace_id();
    std::fs::rename(
        f.native.profile_path()?.join(namespace),
        f.native.profile_path()?.join("held-core-memory"),
    )?;
    f.native
        .profile()?
        .create_private_child(OsStr::new(namespace))?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            assert!(
                prepare_native_turn_memory(
                    f.engine.clone(),
                    Some(f.native.recapture_for_owned_service()?),
                    &identity
                )
                .is_err()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    assert!(
        !f.native
            .profile_path()?
            .join(namespace)
            .join("data")
            .exists()
    );
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn readonly_rpc_returns_standard_canonical_snapshot_and_does_not_need_a_write_operation()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (identity, id) = prepared(&f).await?;
    crate::app_server::turn_attempts::finish(
        &f.engine,
        &identity,
        "completed",
        None,
        None,
        &crate::app_server::turn_attempts::PartialOutput::default(),
    )?;
    let request = request(&f, &f.engine.session_id(), &id);
    let before = std::fs::read(
        f.native
            .profile_path()?
            .join(f.source.guard.namespace_id())
            .join("data/memory-review.json"),
    )?;
    let reply = request_native_memory_snapshot(&request, &f.engine, &f.native);
    reply.validate()?;
    assert_eq!(reply.status, IntegrationStatus::Completed);
    assert_eq!(reply.request_id, request.request_id);
    assert!(reply.operation_id.as_ref().is_none());
    assert_eq!(reply.result.as_ref().unwrap()["snapshot"]["taskId"], id);
    assert_eq!(
        std::fs::read(
            f.native
                .profile_path()?
                .join(f.source.guard.namespace_id())
                .join("data/memory-review.json")
        )?,
        before
    );
    Ok(())
}

#[tokio::test]
async fn readonly_rpc_wrong_thread_scope_invalid_payload_and_wrong_id_are_safe_non_success()
-> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (_, id) = prepared(&f).await?;
    let mut wrong = request(&f, "unselected-native-thread", &id);
    let reply = request_native_memory_snapshot(&wrong, &f.engine, &f.native);
    assert_eq!(reply.status, IntegrationStatus::Rejected);
    assert!(reply.result.as_ref().is_none());
    wrong = request(&f, &f.engine.session_id(), &id);
    wrong.scope.account_id = "JSON-can-not-grant-owner".into();
    assert_eq!(
        request_native_memory_snapshot(&wrong, &f.engine, &f.native).status,
        IntegrationStatus::Rejected
    );
    wrong = request(&f, &f.engine.session_id(), &id);
    wrong.payload.insert("trusted".into(), json!(true));
    assert_eq!(
        request_native_memory_snapshot(&wrong, &f.engine, &f.native)
            .error
            .as_ref()
            .unwrap()
            .code,
        "MEMORY_TASK_SNAPSHOT_INVALID_REQUEST"
    );
    wrong = request(&f, &f.engine.session_id(), &format!("{id}-missing"));
    let reply = request_native_memory_snapshot(&wrong, &f.engine, &f.native);
    assert_eq!(reply.status, IntegrationStatus::Rejected);
    assert!(reply.result.as_ref().is_none());
    assert!(f.requests.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn readonly_rpc_real_revocation_and_committed_source_loss_never_expose_paths_or_old_body()
-> Result<()> {
    for revoke in [true, false] {
        let f = fixture(true, None)?;
        seed(&f)?;
        let (_, id) = prepared(&f).await?;
        let request = request(&f, &f.engine.session_id(), &id);
        if revoke {
            let mut global = f.native.scope().clone();
            global.workspace_id = IntegrationNullable::Null;
            let authority = crate::app_server::integrations::core::NativeIdentity::observe(
                f.native.profile()?,
                &global,
            )?
            .unwrap();
            authority.disable(f.native.profile()?, "revoke-standard-snapshot-rpc", 1, 800)?;
        } else {
            let namespace = f.source.guard.namespace_id();
            std::fs::rename(
                f.native.profile_path()?.join(namespace),
                f.native.profile_path()?.join("held-read-core-memory"),
            )?;
            f.native
                .profile()?
                .create_private_child(OsStr::new(namespace))?;
        }
        let reply = request_native_memory_snapshot(&request, &f.engine, &f.native);
        assert_ne!(reply.status, IntegrationStatus::Completed);
        assert!(reply.result.as_ref().is_none());
        let text = serde_json::to_string(&reply)?;
        assert!(!text.contains("Frozen reviewed"));
        assert!(!text.contains(f._root.path().to_string_lossy().as_ref()));
    }
    Ok(())
}

#[tokio::test]
async fn direct_composition_and_snapshot_rpc_reject_a_foreign_actual_profile() -> Result<()> {
    let f = fixture(true, None)?;
    seed(&f)?;
    let (identity, id) = prepared(&f).await?;
    let foreign = fixture(true, None)?;
    f.engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            assert!(
                prepare_native_turn_memory(
                    f.engine.clone(),
                    Some(foreign.native.recapture_for_owned_service()?),
                    &identity
                )
                .is_err()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    let request = request(&f, &f.engine.session_id(), &id);
    let reply = request_native_memory_snapshot(&request, &f.engine, &foreign.native);
    assert_ne!(reply.status, IntegrationStatus::Completed);
    assert!(reply.result.as_ref().is_none());
    Ok(())
}
