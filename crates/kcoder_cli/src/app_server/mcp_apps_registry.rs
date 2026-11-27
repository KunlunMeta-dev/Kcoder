//! Short-held metadata and owner generations, independent of network preparation.
use super::mcp_apps_runtime::AppConnection;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

const MAX_CONNECTIONS: usize = 16;
const MAX_GENERATIONS: usize = 1024;
#[derive(Default)]
struct Entries {
    connections: HashMap<String, Arc<AppConnection>>,
    generations: HashMap<String, u64>,
}
#[derive(Default)]
pub struct AppRegistry {
    inner: StdMutex<Entries>,
    changed: tokio::sync::Notify,
}
impl std::fmt::Debug for AppRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f.debug_struct("AppRegistry")
            .field("connections", &inner.connections.len())
            .field("owner_generations", &inner.generations.len())
            .finish()
    }
}
pub struct Preparation {
    pub registry: Arc<AppRegistry>,
    pub thread: String,
    pub generation: u64,
}
impl Preparation {
    pub fn current(&self) -> bool {
        self.registry.current(&self.thread, self.generation)
    }
    pub async fn revoked(&self) {
        loop {
            let notified = self.registry.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.current() {
                return;
            }
            notified.await;
        }
    }
}
impl AppRegistry {
    /// Capture authority before spawning the task, so an owner detach cannot be
    /// overtaken by a connection that has not reached initialize yet.
    pub fn prepare(self: &Arc<Self>, thread: &str) -> Option<Preparation> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !inner.generations.contains_key(thread) && inner.generations.len() >= MAX_GENERATIONS {
            return None;
        }
        let generation = *inner.generations.entry(thread.into()).or_insert(0);
        Some(Preparation {
            registry: Arc::clone(self),
            thread: thread.into(),
            generation,
        })
    }
    fn current(&self, thread: &str, generation: u64) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generations
            .get(thread)
            == Some(&generation)
    }
    pub fn get(&self, id: &str) -> Option<Arc<AppConnection>> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connections
            .get(id)
            .cloned()
    }
    pub fn snapshot(&self) -> Vec<Arc<AppConnection>> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connections
            .values()
            .cloned()
            .collect()
    }
    pub fn has_capacity(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connections
            .len()
            < MAX_CONNECTIONS
    }
    pub fn insert(&self, scope: &Preparation, entry: Arc<AppConnection>) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if entry.thread_id != scope.thread
            || inner.generations.get(&scope.thread) != Some(&scope.generation)
            || inner.connections.len() >= MAX_CONNECTIONS
        {
            entry.revoke();
            return false;
        }
        inner.connections.insert(entry.connection_id.clone(), entry);
        true
    }
    pub fn remove(&self, id: &str) {
        if let Some(entry) = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connections
            .remove(id)
        {
            entry.revoke();
        }
    }
    pub fn revoke(&self, thread: Option<&str>) -> Vec<Arc<AppConnection>> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match thread {
            Some(thread) => {
                if let Some(generation) = inner.generations.get_mut(thread) {
                    *generation = generation.saturating_add(1);
                }
            }
            None => inner.generations.clear(),
        }
        let mut entries = Vec::new();
        inner.connections.retain(|_, entry| {
            if thread.is_none_or(|thread| entry.thread_id == thread) {
                entry.revoke();
                entries.push(Arc::clone(entry));
                false
            } else {
                true
            }
        });
        self.changed.notify_waiters();
        entries
    }
    /// Called only after the resident runtime and its owned operations stop.
    pub fn forget(&self, thread: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generations
            .remove(thread);
    }
}
#[cfg(test)]
mod tests {
    use super::AppRegistry;
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Mutex;

    #[test]
    fn revoke_invalidates_pre_network_scope_without_waiting_for_actor() {
        let registry = Arc::new(AppRegistry::default());
        let one = registry.prepare("one").unwrap();
        let two = registry.prepare("two").unwrap();
        assert!(one.current() && two.current());
        registry.revoke(Some("one"));
        assert!(!one.current());
        assert!(two.current());
        assert!(registry.prepare("one").unwrap().current());
        registry.revoke(None);
        assert!(!two.current());
    }
    #[tokio::test]
    async fn metadata_snapshot_is_independent_of_held_preparation_actor() {
        let registry = Arc::new(AppRegistry::default());
        let actor = Arc::new(Mutex::new(()));
        let _held = actor.lock().await;
        let one = registry.prepare("one").unwrap();
        let two = registry.prepare("two").unwrap();
        tokio::time::timeout(Duration::from_millis(50), async {
            assert!(registry.snapshot().is_empty());
            assert!(registry.get("absent").is_none());
            registry.revoke(Some("two"));
        })
        .await
        .unwrap();
        assert!(one.current() && !two.current());
    }
}
