//! Keep native queue ownership beside the existing bounded observer queue.
use super::*;
use crate::native_model_requests::NativeAuxiliaryWork;
use std::collections::{BTreeMap, VecDeque};

pub(crate) struct ObserverRuntimeQueue {
    queue: MemoryObserverQueue,
    owners: BTreeMap<String, VecDeque<NativeAuxiliaryWork>>,
}
fn key(bundle: &MemoryObserverEventBundle) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(bundle).expect("observer bundle serialization"))
    )
}
impl ObserverRuntimeQueue {
    pub(crate) fn new(queue: MemoryObserverQueue) -> Self {
        Self {
            queue,
            owners: BTreeMap::new(),
        }
    }
    pub(crate) fn stats(&self) -> MemoryObserverQueueStats {
        self.queue.stats()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
    fn take_owner(&mut self, bundle: &MemoryObserverEventBundle) -> Option<NativeAuxiliaryWork> {
        let key = key(bundle);
        let owners = self.owners.get_mut(&key)?;
        let owner = owners.pop_front();
        if owners.is_empty() {
            self.owners.remove(&key);
        }
        owner
    }
    pub(crate) fn submit(
        &mut self,
        bundle: MemoryObserverEventBundle,
        owner: NativeAuxiliaryWork,
    ) -> MemoryObserverQueueSubmitResult {
        let incoming = key(&bundle);
        let result = self.queue.submit(bundle);
        if let MemoryObserverQueueSubmitResult::DroppedOldest(dropped) = &result {
            self.take_owner(dropped);
        }
        if matches!(
            result,
            MemoryObserverQueueSubmitResult::Queued
                | MemoryObserverQueueSubmitResult::DroppedOldest(_)
        ) {
            self.owners.entry(incoming).or_default().push_back(owner);
        }
        result
    }
    pub(crate) fn drain_owned(
        &mut self,
    ) -> Vec<(MemoryObserverEventBundle, Option<NativeAuxiliaryWork>)> {
        self.queue
            .drain_all()
            .into_iter()
            .map(|bundle| {
                let owner = self.take_owner(&bundle);
                (bundle, owner)
            })
            .collect()
    }
    pub(crate) fn drain_all(&mut self) -> Vec<MemoryObserverEventBundle> {
        self.drain_owned()
            .into_iter()
            .map(|(bundle, _)| bundle)
            .collect()
    }
}
