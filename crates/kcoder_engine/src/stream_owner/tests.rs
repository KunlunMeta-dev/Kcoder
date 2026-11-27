use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;

#[tokio::test]
async fn independent_stream_owns_one_canonical_attempt_and_real_history_scope() -> Result<()> {
    let root = tempfile::tempdir()?;
    let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    let history = root.path().join("owned-stream.jsonl");
    engine.state.with_history_path(&history);
    let owner = StreamOwner::prepare(&engine, true)?.context("independent actual stream")?;
    let identity = owner.identity().clone();
    let probe = engine.clone();
    let expected = identity.clone();
    let inner = Box::pin(stream! {
        assert_eq!(probe.state.current_history_attempt_identity(), Some(expected));
        probe.state.add_message(kcoder_types::Message::assistant_text("owned foreground output"));
        yield probe.native_event_frame(EngineEvent::AssistantMessageDone, None);
    });
    let mut wrapped = wrap(engine.clone(), inner, Ok(Some(owner)));
    assert!(
        engine
            .owned_turns
            .observer()
            .current_identity()
            .map_err(anyhow::Error::msg)?
            .is_none()
    );
    assert!(wrapped.next().await.is_some());
    assert_eq!(
        engine
            .owned_turns
            .observer()
            .current_identity()
            .map_err(anyhow::Error::msg)?,
        Some(identity.clone())
    );
    assert!(wrapped.next().await.is_none());
    assert!(engine.state.current_history_attempt_identity().is_none());
    assert!(
        engine
            .owned_turns
            .observer()
            .current_identity()
            .map_err(anyhow::Error::msg)?
            .is_none()
    );
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .unwrap();
    let record = store.load(&identity)?.unwrap();
    assert_eq!(record.status, TurnAttemptStatus::Completed);
    assert_eq!(
        record.completion.unwrap().status,
        TurnAttemptStatus::Completed
    );
    let rows = kcoder_state::load_history(&history)?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].history_attempt.as_ref(), Some(&identity));
    Ok(())
}

#[tokio::test]
async fn native_identity_is_reused_and_abandoned_independent_stream_stays_unresolved() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    let native = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "original-native-turn".into(),
        attempt_id: "original-native-attempt".into(),
    };
    let reused = engine
        .state
        .history_attempt_scope(native.clone())?
        .run(async { StreamOwner::prepare(&engine, true) })
        .await?
        .unwrap();
    assert_eq!(reused.identity(), &native);
    assert!(reused.attempt.is_none());
    drop(reused);
    let mut constructed_outside = StreamOwner::prepare(&engine, true)?.unwrap();
    engine
        .state
        .history_attempt_scope(native.clone())?
        .run(constructed_outside.begin(&engine))
        .await?;
    assert_eq!(constructed_outside.identity(), &native);
    assert!(constructed_outside.attempt.is_none());
    drop(constructed_outside);
    let owner = StreamOwner::prepare(&engine, true)?.unwrap();
    let identity = owner.identity().clone();
    let producer = engine.clone();
    let inner = Box::pin(stream! {
        yield producer.native_event_frame(EngineEvent::SystemNotice("actual stream started".into()), None);
        futures::future::pending::<()>().await;
    });
    let mut wrapped = wrap(engine.clone(), inner, Ok(Some(owner)));
    assert!(wrapped.next().await.is_some());
    drop(wrapped);
    assert!(
        engine
            .owned_turns
            .observer()
            .current_identity()
            .map_err(anyhow::Error::msg)?
            .is_none()
    );
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .unwrap();
    let record = store.load(&identity)?.unwrap();
    assert_eq!(record.status, TurnAttemptStatus::Accepted);
    assert!(record.completion.is_none());
    Ok(())
}

#[tokio::test]
async fn automatic_turn_identity_cannot_replace_an_existing_accepted_turn() -> Result<()> {
    let root = tempfile::tempdir()?;
    let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    let mut automatic =
        StreamOwner::prepare_for_turn(&engine, true, Some("automatic-turn"))?.unwrap();
    assert_eq!(automatic.identity.turn_id, "automatic-turn");
    let accepted = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "accepted-turn".into(),
        attempt_id: "accepted-attempt".into(),
    };
    engine
        .state
        .history_attempt_scope(accepted.clone())?
        .run(async {
            assert!(StreamOwner::prepare_for_turn(&engine, true, Some("automatic-turn")).is_err());
            assert!(automatic.begin(&engine).await.is_err());
            let matching =
                StreamOwner::prepare_for_turn(&engine, true, Some("accepted-turn"))?.unwrap();
            assert_eq!(matching.identity(), &accepted);
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    assert!(StreamOwner::prepare_for_turn(&engine, true, Some(" ")).is_err());
    assert!(StreamOwner::prepare_for_turn(&engine, false, Some("delegated-turn")).is_err());
    Ok(())
}

#[tokio::test]
async fn cancellation_before_registration_settles_as_an_interrupted_abort() -> Result<()> {
    let root = tempfile::tempdir()?;
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let engine = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_cancel_token(cancel);
    let owner = StreamOwner::prepare(&engine, true)?.context("independent actual stream")?;
    let identity = owner.identity().clone();
    // Registration refuses the cancelled token, so the turn body never runs.
    let inner: Pin<Box<dyn Stream<Item = NativeEngineEventFrame> + Send>> =
        Box::pin(futures::stream::empty());
    let events = wrap(engine.clone(), inner, Ok(Some(owner)))
        .map(|frame| frame.into_event())
        .collect::<Vec<_>>()
        .await;
    assert!(
        matches!(
            events.as_slice(),
            [EngineEvent::StreamAborted { reason }] if reason == "cancelled by user"
        ),
        "{events:?}"
    );
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .unwrap();
    let completion = store.load(&identity)?.unwrap().completion.unwrap();
    assert_eq!(completion.status, TurnAttemptStatus::Interrupted);
    assert_eq!(
        completion.error.as_deref(),
        Some("foreground_turn_unstarted")
    );
    Ok(())
}
