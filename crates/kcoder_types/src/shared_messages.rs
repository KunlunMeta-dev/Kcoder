use crate::Message;
use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeSeq};
use std::sync::Arc;

/// Immutable snapshots share message payloads; writes detach the index and affected payload only.
/// Structural writes with retained snapshots still copy the pointer index in O(message count).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SharedMessages(Arc<Vec<Arc<Message>>>);

impl SharedMessages {
    pub fn insert(&mut self, index: usize, message: Message) {
        assert!(index <= self.len());
        Arc::make_mut(&mut self.0).insert(index, Arc::new(message));
    }
    pub fn reserve(&mut self, additional: usize) {
        if additional > self.0.capacity().saturating_sub(self.len()) {
            Arc::make_mut(&mut self.0).reserve(additional);
        }
    }
    pub fn capacity(&self) -> usize {
        self.0.capacity()
    }
    /// Each yielded mutable message detaches its payload if another snapshot retains it.
    pub fn iter_mut(
        &mut self,
    ) -> impl DoubleEndedIterator<Item = &mut Message> + ExactSizeIterator {
        Arc::make_mut(&mut self.0).iter_mut().map(Arc::make_mut)
    }
    /// Conservative index and Arc payload allocation estimate, excluding nested message fields.
    pub fn retained_shallow_bytes(&self) -> usize {
        std::mem::size_of::<Vec<Arc<Message>>>()
            .saturating_add(2 * std::mem::size_of::<usize>())
            .saturating_add(
                self.0
                    .capacity()
                    .saturating_mul(std::mem::size_of::<Arc<Message>>()),
            )
            .saturating_add(
                self.len().saturating_mul(
                    std::mem::size_of::<Message>() + 2 * std::mem::size_of::<usize>(),
                ),
            )
    }
    pub fn first(&self) -> Option<&Message> {
        self.0.first().map(Arc::as_ref)
    }
    pub fn last(&self) -> Option<&Message> {
        self.0.last().map(Arc::as_ref)
    }
    pub fn pop(&mut self) -> Option<Message> {
        if self.is_empty() {
            return None;
        }
        Arc::make_mut(&mut self.0).pop().map(Arc::unwrap_or_clone)
    }
    pub fn remove_range(&mut self, range: std::ops::Range<usize>) {
        assert!(range.start <= range.end && range.end <= self.len());
        if !range.is_empty() {
            Arc::make_mut(&mut self.0).drain(range);
        }
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Message> + ExactSizeIterator {
        self.0.iter().map(Arc::as_ref)
    }
    pub fn get(&self, index: usize) -> Option<&Message> {
        self.0.get(index).map(Arc::as_ref)
    }

    /// Detach only the selected payload; other snapshots retain their original content.
    pub fn get_mut(&mut self, index: usize) -> Option<&mut Message> {
        if index >= self.len() {
            return None;
        }
        Some(Arc::make_mut(&mut Arc::make_mut(&mut self.0)[index]))
    }

    pub fn push(&mut self, message: Message) {
        Arc::make_mut(&mut self.0).push(Arc::new(message));
    }

    pub fn truncate(&mut self, len: usize) {
        if len < self.len() {
            Arc::make_mut(&mut self.0).truncate(len);
        }
    }

    pub fn clear(&mut self) {
        if !self.is_empty() {
            *self = Self::default();
        }
    }

    /// Explicit compatibility boundary for callers that require owned message payloads.
    pub fn to_vec(&self) -> Vec<Message> {
        self.iter().cloned().collect()
    }

    /// Move uniquely owned payloads; clone only payloads still held by other snapshots.
    pub fn into_vec(self) -> Vec<Message> {
        Arc::unwrap_or_clone(self.0)
            .into_iter()
            .map(Arc::unwrap_or_clone)
            .collect()
    }
}

impl<'a> IntoIterator for &'a SharedMessages {
    type Item = &'a Message;
    type IntoIter =
        std::iter::Map<std::slice::Iter<'a, Arc<Message>>, fn(&'a Arc<Message>) -> &'a Message>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter().map(Arc::as_ref)
    }
}

impl IntoIterator for SharedMessages {
    type Item = Message;
    type IntoIter = std::iter::Map<std::vec::IntoIter<Arc<Message>>, fn(Arc<Message>) -> Message>;
    fn into_iter(self) -> Self::IntoIter {
        Arc::unwrap_or_clone(self.0)
            .into_iter()
            .map(Arc::unwrap_or_clone)
    }
}

impl std::ops::Index<usize> for SharedMessages {
    type Output = Message;
    fn index(&self, index: usize) -> &Message {
        &self.0[index]
    }
}

impl PartialEq<Vec<Message>> for SharedMessages {
    fn eq(&self, other: &Vec<Message>) -> bool {
        self.iter().eq(other.iter())
    }
}

impl From<Vec<Message>> for SharedMessages {
    fn from(messages: Vec<Message>) -> Self {
        Self(Arc::new(messages.into_iter().map(Arc::new).collect()))
    }
}

impl Serialize for SharedMessages {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.len()))?;
        for message in self.iter() {
            sequence.serialize_element(message)?;
        }
        sequence.end()
    }
}

impl<'de> Deserialize<'de> for SharedMessages {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<Message>::deserialize(deserializer).map(Self::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_share_payloads_but_mutations_are_isolated() {
        let original = SharedMessages::from(vec![
            Message::user_text("one"),
            Message::assistant_text("two"),
        ]);
        let mut current = original.clone();
        assert!(Arc::ptr_eq(&original.0, &current.0));
        current.push(Message::user_text("three"));
        assert_eq!(original.len(), 2);
        assert!(std::ptr::eq(
            original.get(0).unwrap(),
            current.get(0).unwrap()
        ));
        *current.get_mut(0).unwrap() = Message::user_text("changed");
        assert_eq!(original.get(0), Some(&Message::user_text("one")));
        assert!(std::ptr::eq(
            original.get(1).unwrap(),
            current.get(1).unwrap()
        ));
        let snapshot = current.clone();
        current.truncate(1);
        assert_eq!(snapshot.len(), 3);
        current.clear();
        assert!(current.is_empty());
        assert_eq!(snapshot.len(), 3);
    }

    #[test]
    fn wire_format_and_owned_conversion_preserve_message_order() {
        let messages = vec![
            Message::user_text("你好"),
            Message::assistant_text("answer"),
            Message::user_text("你好"),
        ];
        let shared = SharedMessages::from(messages.clone());
        let encoded = serde_json::to_vec(&shared).unwrap();
        assert_eq!(encoded, serde_json::to_vec(&messages).unwrap());
        let restored: SharedMessages = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored, shared);
        assert_eq!(shared.clone().into_vec(), messages);
        assert_eq!(shared.into_vec(), messages);
        assert_eq!(
            restored.iter().rev().cloned().collect::<Vec<_>>(),
            messages.into_iter().rev().collect::<Vec<_>>()
        );
    }

    #[test]
    fn concurrent_forks_keep_original_payloads_and_order() {
        let original = SharedMessages::from(vec![
            Message::user_text("root"),
            Message::assistant_text("stable"),
        ]);
        let workers: Vec<_> = (0..4)
            .map(|index| {
                let mut fork = original.clone();
                std::thread::spawn(move || {
                    *fork.get_mut(0).unwrap() = Message::user_text(format!("fork {index}"));
                    fork.push(Message::user_text("tail"));
                    fork.into_vec()
                })
            })
            .collect();
        for (index, worker) in workers.into_iter().enumerate() {
            assert_eq!(
                worker.join().unwrap(),
                vec![
                    Message::user_text(format!("fork {index}")),
                    Message::assistant_text("stable"),
                    Message::user_text("tail"),
                ]
            );
        }
        assert_eq!(
            original.to_vec(),
            vec![
                Message::user_text("root"),
                Message::assistant_text("stable")
            ]
        );
    }

    #[test]
    fn request_clones_share_messages_and_keep_wire_format() {
        let mut request =
            crate::MessagesRequest::new("model", vec![Message::user_text("original")]);
        let snapshot = request.clone();
        assert!(std::ptr::eq(
            request.messages.get(0).unwrap(),
            snapshot.messages.get(0).unwrap()
        ));
        *request.messages.get_mut(0).unwrap() = Message::user_text("changed");
        assert_eq!(snapshot.messages[0], Message::user_text("original"));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            wire["messages"],
            serde_json::to_value(vec![Message::user_text("original")]).unwrap()
        );
        assert_eq!(wire["model"], "model");
    }

    #[test]
    fn range_removal_and_pop_preserve_retained_snapshots() {
        let original = SharedMessages::from(
            (0..5)
                .map(|index| Message::user_text(index.to_string()))
                .collect::<Vec<_>>(),
        );
        let mut current = original.clone();
        current.remove_range(1..4);
        assert_eq!(
            current.to_vec(),
            vec![Message::user_text("0"), Message::user_text("4")]
        );
        assert_eq!(current.pop(), Some(Message::user_text("4")));
        assert_eq!(original.len(), 5);
        assert_eq!(original[4], Message::user_text("4"));
    }

    #[test]
    fn no_op_writes_do_not_detach_the_snapshot() {
        let original = SharedMessages::from(vec![Message::user_text("one")]);
        let mut current = original.clone();
        current.truncate(2);
        assert!(current.get_mut(1).is_none());
        assert!(Arc::ptr_eq(&original.0, &current.0));
    }

    #[test]
    fn repeated_snapshot_append_and_window_trim_release_obsolete_owners() {
        let mut current = SharedMessages::from(vec![Message::user_text("initial")]);
        // Weak probes observe strong ownership only; they intentionally keep Arc control blocks.
        let mut payloads = vec![Arc::downgrade(&current.0[0])];
        for turn in 0..64 {
            let retained = current.clone();
            let old_index = Arc::downgrade(&retained.0);
            let old_payloads: Vec<_> = retained.0.iter().map(Arc::downgrade).collect();
            assert_eq!(Arc::strong_count(&retained.0), 2);
            current.push(Message::user_text(format!("turn-{turn}")));
            payloads.push(Arc::downgrade(current.0.last().unwrap()));
            assert!(!Arc::ptr_eq(&retained.0, &current.0));
            assert_eq!(old_index.strong_count(), 1);
            assert!(
                old_payloads
                    .iter()
                    .all(|payload| payload.strong_count() == 2)
            );
            drop(retained);
            assert!(old_index.upgrade().is_none());
            assert!(
                old_payloads
                    .iter()
                    .all(|payload| payload.strong_count() == 1)
            );
            if current.len() > 8 {
                current.remove_range(0..current.len() - 8);
            }
            assert!(current.len() <= 8);
            assert_eq!(
                payloads
                    .iter()
                    .filter(|payload| payload.strong_count() != 0)
                    .count(),
                current.len(),
            );
            assert_eq!(
                payloads
                    .iter()
                    .map(|payload| payload.strong_count())
                    .sum::<usize>(),
                current.len()
            );
        }
        let last_index = Arc::downgrade(&current.0);
        current.clear();
        assert!(last_index.upgrade().is_none());
        assert!(payloads.iter().all(|payload| payload.upgrade().is_none()));
    }

    #[test]
    fn owned_repair_style_replacement_releases_each_previous_shared_generation() {
        let mut current = SharedMessages::from(vec![
            Message::user_text("question"),
            Message::assistant_text("interrupted"),
        ]);
        for generation in 0..32 {
            let retained = current.clone();
            let old_index = Arc::downgrade(&retained.0);
            let old_payloads: Vec<_> = retained.0.iter().map(Arc::downgrade).collect();
            // Simulate repair's ownership boundary, not its engine-level repair semantics.
            let mut owned = current.clone().into_vec();
            owned[1] = Message::assistant_text(format!("replacement-{generation}"));
            current = owned.into();
            assert_eq!(old_index.strong_count(), 1);
            assert!(
                old_payloads
                    .iter()
                    .all(|payload| payload.strong_count() == 1)
            );
            assert_eq!(retained[0], current[0]);
            assert_ne!(retained[1], current[1]);
            assert!(!Arc::ptr_eq(&retained.0[0], &current.0[0]));
            drop(retained);
            assert!(old_index.upgrade().is_none());
            assert!(
                old_payloads
                    .iter()
                    .all(|payload| payload.upgrade().is_none())
            );
            assert!(
                current
                    .0
                    .iter()
                    .all(|payload| Arc::strong_count(payload) == 1)
            );
        }
        let last_payloads: Vec<_> = current.0.iter().map(Arc::downgrade).collect();
        drop(current);
        assert!(
            last_payloads
                .iter()
                .all(|payload| payload.upgrade().is_none())
        );
    }

    #[test]
    fn truncate_and_clear_release_payloads_only_after_the_last_snapshot() {
        let mut current = SharedMessages::from(
            (0..6)
                .map(|index| Message::user_text(index.to_string()))
                .collect::<Vec<_>>(),
        );
        let retained = current.clone();
        let old_index = Arc::downgrade(&retained.0);
        let payloads: Vec<_> = retained.0.iter().map(Arc::downgrade).collect();
        current.truncate(2);
        assert!(
            payloads[..2]
                .iter()
                .all(|payload| payload.strong_count() == 2)
        );
        assert!(
            payloads[2..]
                .iter()
                .all(|payload| payload.strong_count() == 1)
        );
        let trimmed_index = Arc::downgrade(&current.0);
        current.clear();
        assert!(trimmed_index.upgrade().is_none());
        assert_eq!(retained.len(), 6);
        assert!(payloads.iter().all(|payload| payload.strong_count() == 1));
        drop(retained);
        assert!(old_index.upgrade().is_none());
        assert!(payloads.iter().all(|payload| payload.upgrade().is_none()));

        let mut empty_after_truncate = SharedMessages::from(vec![Message::user_text("last")]);
        let payload = Arc::downgrade(&empty_after_truncate.0[0]);
        empty_after_truncate.truncate(0);
        assert!(payload.upgrade().is_none());
        // Empty Vec capacity may remain; it is not a retained message or a claim of zero RSS.
        let empty_index = Arc::downgrade(&empty_after_truncate.0);
        empty_after_truncate.clear();
        assert_eq!(empty_index.strong_count(), 1);
        drop(empty_after_truncate);
        assert!(empty_index.upgrade().is_none());
    }

    #[test]
    fn cross_thread_snapshot_destruction_releases_shared_and_detached_payloads() {
        use std::sync::mpsc;
        use std::time::Duration;
        struct Workers(Vec<std::thread::JoinHandle<()>>);
        impl Drop for Workers {
            fn drop(&mut self) {
                for worker in self.0.drain(..) {
                    let _ = worker.join();
                }
            }
        }
        let original = SharedMessages::from(vec![
            Message::user_text("original"),
            Message::assistant_text("shared"),
        ]);
        let original_index = Arc::downgrade(&original.0);
        let original_payloads: Vec<_> = original.0.iter().map(Arc::downgrade).collect();
        let (ready_tx, ready_rx) = mpsc::channel();
        let mut workers = Workers(Vec::new());
        let mut releases = Vec::new();
        for index in 0..4 {
            let mut snapshot = original.clone();
            let ready = ready_tx.clone();
            let (release_tx, release_rx) = mpsc::channel();
            releases.push(release_tx);
            workers.0.push(std::thread::spawn(move || {
                snapshot.push(Message::user_text("tail"));
                *snapshot.get_mut(0).unwrap() = Message::user_text(format!("worker-{index}"));
                let observed = (
                    Arc::downgrade(&snapshot.0),
                    Arc::downgrade(&snapshot.0[0]),
                    Arc::downgrade(&snapshot.0[2]),
                );
                if ready.send(observed).is_ok() {
                    // A failed parent assertion drops senders; no worker can wait indefinitely.
                    let _ = release_rx.recv_timeout(Duration::from_secs(5));
                }
                drop(snapshot);
            }));
        }
        drop(ready_tx);
        let observed: Vec<_> = (0..4)
            .map(|_| ready_rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        assert_eq!(original_index.strong_count(), 1);
        assert_eq!(original_payloads[0].strong_count(), 1);
        assert_eq!(original_payloads[1].strong_count(), 5);
        drop(original);
        assert!(original_index.upgrade().is_none());
        assert!(original_payloads[0].upgrade().is_none());
        assert_eq!(original_payloads[1].strong_count(), 4);
        for release in releases {
            release.send(()).unwrap();
        }
        for worker in workers.0.drain(..) {
            worker.join().unwrap();
        }
        assert!(
            original_payloads
                .iter()
                .all(|payload| payload.upgrade().is_none())
        );
        for (index, head, tail) in observed {
            assert!(index.upgrade().is_none());
            assert!(head.upgrade().is_none());
            assert!(tail.upgrade().is_none());
        }
    }
}
