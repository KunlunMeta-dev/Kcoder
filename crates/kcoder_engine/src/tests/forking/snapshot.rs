use super::*;

#[test]
fn shared_fork_snapshot_is_immutable_across_replacement_and_clear() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path()).build();
    let make = |text: &str| {
        Arc::new(crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text(text)].into(),
            active_skills: vec![],
            snapshot_provider: "captured-provider".into(),
            snapshot_model: "captured-model".into(),
            full_context_compatible: false,
        })
    };
    *engine.last_cache_safe_params.write().unwrap() = Some(make("old"));
    let first = engine.cache_safe_snapshot().unwrap();
    assert!(Arc::ptr_eq(&first, &engine.cache_safe_snapshot().unwrap()));
    let mut owned = engine.last_cache_safe_params().unwrap();
    owned.fork_context_messages.clear();
    assert_eq!(first.fork_context_messages, vec![Message::user_text("old")]);
    *engine.last_cache_safe_params.write().unwrap() = Some(make("new"));
    let second = engine.cache_safe_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
    *engine.last_cache_safe_params.write().unwrap() = None;
    engine.state.clear_messages();
    assert_eq!(first.fork_context_messages, vec![Message::user_text("old")]);
    assert_eq!(
        second.fork_context_messages,
        vec![Message::user_text("new")]
    );
    assert_eq!(first.snapshot_model, "captured-model");
    assert!(!first.full_context_compatible);
    assert!(engine.cache_safe_snapshot().is_none());
}

#[test]
fn session_replacement_releases_fork_cache_after_external_owner_finishes() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path()).build();
    for generation in 0..32 {
        let snapshot = Arc::new(crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text(format!("generation {generation}"))]
                .into(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        });
        let observed = Arc::downgrade(&snapshot);
        *engine.last_cache_safe_params.write().unwrap() = Some(snapshot);
        let external = engine.cache_safe_snapshot().unwrap();
        assert_eq!(observed.strong_count(), 2);
        engine.prepare_session_replacement();
        assert!(engine.cache_safe_snapshot().is_none());
        assert_eq!(observed.strong_count(), 1);
        assert_eq!(
            external.fork_context_messages[0],
            Message::user_text(format!("generation {generation}"))
        );
        drop(external);
        assert!(observed.upgrade().is_none());
    }
}
