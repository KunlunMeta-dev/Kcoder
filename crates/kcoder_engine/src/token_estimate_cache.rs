use crate::QueryEngine;
use crate::context::TokenCounter;
use crate::context::compact::latest_compact_boundary;
use kcoder_state::MessageRevision;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct TokenEstimateCache {
    inner: Mutex<CacheEntry>,
}

#[derive(Default)]
struct CacheEntry {
    value: Option<(MessageRevision, usize)>,
    hits: u64,
    misses: u64,
    invalidations: u64,
}

pub(super) fn count(engine: &QueryEngine) -> usize {
    let revision = engine.state.message_revision();
    if let Ok(mut cache) = engine.token_estimate_cache.inner.try_lock() {
        if let Some((cached_revision, value)) = &cache.value {
            if *cached_revision == revision {
                let value = *value;
                cache.hits = cache.hits.saturating_add(1);
                return value;
            }
            cache.invalidations = cache.invalidations.saturating_add(1);
        }
        cache.misses = cache.misses.saturating_add(1);
    }
    let (messages, captured_revision) = engine.state.messages_with_revision();
    let start = latest_compact_boundary(&messages).map_or(0, |boundary| boundary.summary_index);
    let value = TokenCounter::count(&messages[start..]);
    // No cache lock is held during the message clone or token scan.
    if let Ok(mut cache) = engine.token_estimate_cache.inner.try_lock()
        && engine.state.message_revision() == captured_revision
    {
        cache.value = Some((captured_revision, value));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_types::Message;

    #[test]
    fn token_estimate_cache_hits_and_invalidates_on_content_not_length() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build();
        engine
            .state
            .set_messages(vec![Message::user_text("before")]);
        assert_eq!(
            engine.estimated_token_count(),
            TokenCounter::count(&engine.state.messages())
        );
        engine.estimated_token_count();
        assert_eq!(engine.token_estimate_cache.inner.lock().unwrap().hits, 1);
        engine
            .state
            .set_messages(vec![Message::user_text("after!")]);
        assert_eq!(
            engine.estimated_token_count(),
            TokenCounter::count(&engine.state.messages())
        );
        let cache = engine.token_estimate_cache.inner.lock().unwrap();
        assert_eq!(cache.misses, 2);
        assert_eq!(cache.invalidations, 1);
        drop(cache);
        engine
            .state
            .upsert_task(kcoder_state::Task::new("metadata", "only"));
        engine.estimated_token_count();
        assert_eq!(engine.token_estimate_cache.inner.lock().unwrap().hits, 2);
    }

    #[test]
    fn token_estimate_cache_does_not_cross_state_identity_or_wait_for_its_lock() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build();
        engine.state.set_messages(vec![Message::user_text("first")]);
        engine.estimated_token_count();
        let mut other = engine.clone();
        other.state = kcoder_state::AppState::with_messages(
            root.path(),
            vec![Message::user_text("long ".repeat(1000))],
        );
        assert_eq!(
            other.estimated_token_count(),
            TokenCounter::count(&other.state.messages())
        );
        let held = engine.token_estimate_cache.inner.lock().unwrap();
        assert_eq!(
            engine.estimated_token_count(),
            TokenCounter::count(&engine.state.messages())
        );
        drop(held);
    }
}
