use std::collections::HashMap;
use std::sync::{Arc, Weak};
use tokio::sync::Mutex;

/// Connection-owned keyed gates. Weak entries never retain engines or histories;
/// the dispatcher's admission limit bounds the number of live request owners.
#[derive(Default)]
pub(super) struct IndexedReadGate {
    threads: HashMap<String, Weak<Mutex<()>>>,
}

impl IndexedReadGate {
    pub(super) fn for_thread(&mut self, thread_id: &str) -> anyhow::Result<Arc<Mutex<()>>> {
        super::validate_thread_id(thread_id)?;
        self.threads.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = self.threads.get(thread_id).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(Mutex::new(()));
        self.threads
            .insert(thread_id.to_owned(), Arc::downgrade(&gate));
        Ok(gate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn same_thread_shares_gate_and_other_threads_remain_independent() {
        let mut gates = IndexedReadGate::default();
        let first = gates.for_thread("a").unwrap();
        let same = gates.for_thread("a").unwrap();
        let other = gates.for_thread("b").unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        let held = first.clone().lock_owned().await;
        assert!(same.try_lock().is_err());
        assert!(other.try_lock().is_ok());
        drop(held);
        assert!(same.try_lock().is_ok());
        drop((first, same, other));
        let _new = gates.for_thread("c").unwrap();
        assert_eq!(gates.threads.len(), 1);
        assert!(gates.for_thread("../invalid").is_err());
    }

    #[tokio::test]
    async fn cancelling_an_owner_or_waiter_does_not_keep_the_gate_locked() {
        let mut gates = IndexedReadGate::default();
        let gate = gates.for_thread("a").unwrap();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let owned_gate = gate.clone();
        let owner = tokio::spawn(async move {
            let _held = owned_gate.lock_owned().await;
            entered.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        let waiting_gate = gate.clone();
        let waiter = tokio::spawn(async move {
            let _held = waiting_gate.lock_owned().await;
        });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(gate.try_lock().is_err());
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        assert!(gate.try_lock().is_ok());
    }
}
