use super::*;

pub(crate) struct MemoryIdleReservation {
    reserved: Arc<AtomicBool>,
    committed: bool,
}

impl MemoryIdleReservation {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for MemoryIdleReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.reserved.store(false, Ordering::SeqCst);
        }
    }
}

impl QueryEngine {
    pub(crate) fn try_reserve_memory_idle(&self) -> Option<MemoryIdleReservation> {
        let _admission = self.memory_idle_gate.try_write().ok()?;
        if self.memory_idle_reserved.load(Ordering::SeqCst)
            || self.session_memory_update_running.load(Ordering::SeqCst)
            || self.memory_observer_worker_running.load(Ordering::SeqCst)
            || self
                .session_memory_update_handle
                .try_lock()
                .ok()?
                .as_ref()
                .is_some_and(|job| !job.is_finished())
            || self
                .memory_observer_worker_handle
                .try_lock()
                .ok()?
                .as_ref()
                .is_some_and(|job| !job.is_finished())
            || !self.memory_observer_queue.try_read().ok()?.is_empty()
        {
            return None;
        }
        self.memory_idle_reserved.store(true, Ordering::SeqCst);
        Some(MemoryIdleReservation {
            reserved: Arc::clone(&self.memory_idle_reserved),
            committed: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;

    #[test]
    fn memory_idle_reservation_blocks_observer_enqueue_and_restores_it_on_rollback() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build();
        engine.settings.write().unwrap().memory.observer_mode =
            kcoder_config::MemoryObserverMode::Model;
        let reservation = engine.try_reserve_background_work_idle().unwrap();
        engine.record_memory_observer_bundle(engine.memory_observer_event_bundle());
        assert!(engine.memory_observer_queue.read().unwrap().is_empty());
        assert!(!engine.memory_observer_worker_running.load(Ordering::SeqCst));
        drop(reservation);
        // Keep the model-independent test at the enqueue boundary without invoking a provider.
        engine
            .memory_observer_worker_running
            .store(true, Ordering::SeqCst);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        engine.record_memory_observer_bundle(engine.memory_observer_event_bundle());
        engine
            .memory_observer_worker_running
            .store(false, Ordering::SeqCst);
        assert!(!engine.memory_observer_queue.read().unwrap().is_empty());
        assert!(engine.try_reserve_background_work_idle().is_none());
        engine.memory_observer_queue.write().unwrap().drain_all();
        assert!(engine.try_reserve_background_work_idle().is_some());
    }

    #[tokio::test]
    async fn memory_idle_reservation_rejects_worker_tail_and_rolls_back_other_domains() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build();
        let held = engine.memory_idle_gate.read().unwrap();
        assert!(engine.try_reserve_background_work_idle().is_none());
        assert!(engine.background_jobs.try_reserve_idle().is_some());
        assert!(engine.try_reserve_prefire_idle().is_some());
        drop(held);
        let (finish, wait) = tokio::sync::oneshot::channel();
        *engine.session_memory_update_handle.lock().unwrap() = Some(tokio::spawn(async move {
            let _ = wait.await;
        }));
        assert!(!engine.session_memory_update_running.load(Ordering::SeqCst));
        assert!(
            engine.try_reserve_background_work_idle().is_none(),
            "a cleared flag is not task completion"
        );
        finish.send(()).unwrap();
        let handle = engine
            .session_memory_update_handle
            .lock()
            .unwrap()
            .take()
            .unwrap();
        handle.await.unwrap();
        let reserved = engine.try_reserve_background_work_idle().unwrap();
        assert!(engine.memory_idle_reserved.load(Ordering::SeqCst));
        drop(reserved);
        assert!(!engine.memory_idle_reserved.load(Ordering::SeqCst));
        engine
            .memory_observer_worker_running
            .store(true, Ordering::SeqCst);
        assert!(engine.try_reserve_background_work_idle().is_none());
        engine
            .memory_observer_worker_running
            .store(false, Ordering::SeqCst);
        engine.try_reserve_background_work_idle().unwrap().commit();
        assert!(engine.memory_idle_reserved.load(Ordering::SeqCst));
    }
}
