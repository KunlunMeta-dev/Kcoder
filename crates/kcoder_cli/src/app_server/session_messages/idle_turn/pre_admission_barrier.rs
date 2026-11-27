//! Test-only scheduling rendezvous. It never creates or changes permission facts.
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

struct Rendezvous {
    thread: String,
    entered: Notify,
    release: Notify,
}
static NEXT: Mutex<Option<Arc<Rendezvous>>> = Mutex::new(None);

pub(in crate::app_server::session_messages) struct Handle(Arc<Rendezvous>);
impl Handle {
    pub(in crate::app_server::session_messages) async fn reached(&self) {
        self.0.entered.notified().await;
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        let mut next = NEXT.lock().unwrap();
        if next.as_ref().is_some_and(|gate| Arc::ptr_eq(gate, &self.0)) {
            next.take();
        }
        self.0.release.notify_one();
    }
}
pub(in crate::app_server::session_messages) fn arm(thread: &str) -> Handle {
    let mut next = NEXT.lock().unwrap();
    assert!(
        next.is_none(),
        "only one original scheduling rendezvous is armed"
    );
    let gate = Arc::new(Rendezvous {
        thread: thread.to_owned(),
        entered: Notify::new(),
        release: Notify::new(),
    });
    *next = Some(gate.clone());
    Handle(gate)
}
pub(super) async fn checkpoint(thread: &str) {
    let gate = {
        let mut next = NEXT.lock().unwrap();
        if next.as_ref().is_some_and(|gate| gate.thread == thread) {
            next.take()
        } else {
            None
        }
    };
    if let Some(gate) = gate {
        gate.entered.notify_one();
        gate.release.notified().await;
    }
}
