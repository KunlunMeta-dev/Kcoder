//! Bounded, best-effort lifecycle diagnostics, separate from protocol receipts.
use serde_json::{Value, json};
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);
static DROPPED: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub(crate) struct Lifecycle {
    connection: u64,
    identities: Arc<RandomState>,
    session: Option<String>,
    thread: Option<String>,
    turn: Option<String>,
    generation: Option<u32>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            connection: NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed),
            identities: Arc::new(RandomState::new()),
            session: None,
            thread: None,
            turn: None,
            generation: None,
        }
    }
}

impl Lifecycle {
    // References are connection-keyed fingerprints, never raw client/native strings.
    fn reference(&self, value: &str) -> String {
        format!("{:016x}", self.identities.hash_one(value))
    }

    pub(crate) fn session(&self, id: &str) -> Self {
        Self {
            session: Some(self.reference(id)),
            thread: None,
            turn: None,
            generation: None,
            ..self.clone()
        }
    }

    pub(crate) fn native(&self, thread: &str, turn: Option<&str>) -> Self {
        Self {
            thread: Some(self.reference(thread)),
            turn: turn.map(|id| self.reference(id)),
            ..self.clone()
        }
    }

    pub(crate) fn process(&self, pid: u32) -> Self {
        Self {
            generation: Some(pid),
            ..self.clone()
        }
    }

    fn value(&self, stage: &'static str, source: &'static str, outcome: &'static str) -> Value {
        json!({
            "event":"acp_lifecycle", "connectionId":self.connection,
            "sessionRef":self.session, "nativeThreadRef":self.thread,
            "nativeTurnRef":self.turn, "processGeneration":self.generation,
            "stage":stage, "source":source, "outcome":outcome,
            "timeUnixMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "droppedEvents":DROPPED.load(Ordering::Relaxed),
        })
    }

    pub(crate) fn record(&self, stage: &'static str, source: &'static str, outcome: &'static str) {
        static SENDER: OnceLock<Option<mpsc::SyncSender<Value>>> = OnceLock::new();
        let sender = SENDER.get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<Value>(128);
            std::thread::Builder::new()
                .name("acp-diagnostics".into())
                .spawn(move || {
                    for event in receiver {
                        // A blocked diagnostic reader must not block cancellation or stdout.
                        let _ = writeln!(std::io::stderr(), "{event}");
                    }
                })
                .ok()
                .map(|_| sender)
        });
        if sender
            .as_ref()
            .is_none_or(|sender| sender.try_send(self.value(stage, source, outcome)).is_err())
        {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_correlate_only_within_connection_and_never_contain_private_input() {
        let first = Lifecycle::default();
        let secret = "private-session\ncredential=value";
        let scoped = first
            .session(secret)
            .native(secret, Some(secret))
            .process(42);
        let event = scoped.value("cancel", "client_cancel", "requested");
        assert_eq!(event["connectionId"], first.connection);
        assert_eq!(event["sessionRef"], first.session(secret).session.unwrap());
        assert_eq!(event["nativeThreadRef"], event["nativeTurnRef"]);
        assert_eq!(event["processGeneration"], 42);
        assert_ne!(
            first.reference(secret),
            Lifecycle::default().reference(secret)
        );
        assert!(!event.to_string().contains("credential"));
        assert!(!event.to_string().contains("private-session"));
        assert!(event.to_string().len() < 1024);
    }
}
