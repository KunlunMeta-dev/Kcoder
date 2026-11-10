//! Per-client subscriptions to the single host's original event stream.
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct RpcHub {
    subscribers: Arc<StdMutex<BTreeMap<String, Subscriber>>>,
    relays: Arc<StdMutex<Option<tokio::task::JoinSet<()>>>>,
}

impl Default for RpcHub {
    fn default() -> Self {
        Self {
            subscribers: Arc::default(),
            relays: Arc::new(StdMutex::new(Some(Default::default()))),
        }
    }
}

struct Subscriber {
    output: mpsc::Sender<Value>,
    ended: CancellationToken,
    threads: BTreeSet<String>,
    task_state_notifications: bool,
}
pub fn thread_id(frame: &Value) -> Option<&str> {
    let params = frame.get("params")?;
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            (frame.get("method").and_then(Value::as_str)
                == Some(kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED))
            .then(|| params.get("reference")?.get("threadId")?.as_str())
            .flatten()
        })
}
impl RpcHub {
    pub fn relay_client(
        &self,
        output_id: String,
        mut frames: mpsc::Receiver<Value>,
        output_ended: CancellationToken,
    ) -> Result<Arc<StdMutex<BTreeSet<u64>>>> {
        let mut jobs = self
            .relays
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let jobs = jobs.as_mut().context("APP_SERVER_RPC_HOST_ENDED")?;
        while jobs.try_join_next().is_some() {}
        ensure!(jobs.len() < 128, "APP_SERVER_RPC_RELAY_CAPACITY");
        let output_hub = self.clone();
        let delivered_interactions = Arc::new(StdMutex::new(BTreeSet::new()));
        let delivered = delivered_interactions.clone();
        // The host owns the relay after its originating client disconnects.
        jobs.spawn(Box::pin(async move {
            while let Some(frame) = frames.recv().await {
                if frame.get("method").is_some()
                    && let Some(id) = frame.get("id").and_then(Value::as_u64)
                {
                    let mut delivered = delivered.lock().unwrap_or_else(|error| error.into_inner());
                    if delivered.len() >= 4096 && !delivered.contains(&id) {
                        output_ended.cancel();
                        break;
                    }
                    delivered.insert(id);
                }
                output_hub.observe(&frame, Some(&output_id));
            }
        }));
        Ok(delivered_interactions)
    }
    pub async fn close(&self) {
        let jobs = self
            .relays
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(mut jobs) = jobs {
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
        }
        self.subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
    pub fn attach(&self, id: &str, output: mpsc::Sender<Value>, ended: CancellationToken) {
        self.subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                id.into(),
                Subscriber {
                    output,
                    ended,
                    threads: BTreeSet::new(),
                    task_state_notifications: false,
                },
            );
    }
    pub fn negotiate_task_state(&self, id: &str, enabled: bool) {
        if let Some(client) = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(id)
        {
            client.task_state_notifications = enabled;
        }
    }
    pub fn needs_task_state(&self) -> bool {
        self.subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .any(|client| client.task_state_notifications && !client.ended.is_cancelled())
    }
    pub fn subscribe(&self, id: &str, thread: &str) {
        if let Some(client) = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(id)
        {
            client.threads.insert(thread.into());
        }
    }
    pub fn unsubscribe(&self, id: &str, thread: &str) {
        if let Some(client) = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(id)
        {
            client.threads.remove(thread);
        }
    }
    pub fn detach(&self, id: &str) {
        self.subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
    }
    pub fn observe(&self, frame: &Value, origin: Option<&str>) {
        let notification = frame.get("method").is_some() && frame.get("id").is_none();
        let thread = notification.then(|| thread_id(frame)).flatten();
        let task_state = frame.get("method").and_then(Value::as_str)
            == Some(kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED);
        let mut clients = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        clients.retain(|id, client| {
            if client.ended.is_cancelled() {
                return false;
            }
            if task_state && !client.task_state_notifications {
                return true;
            }
            let own = origin == Some(id.as_str());
            if own
                && let Some(thread) = frame
                    .get("result")
                    .and_then(|r| r.get("thread"))
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
            {
                client.threads.insert(thread.into());
            }
            if own
                && frame.get("method").and_then(Value::as_str) == Some("thread/started")
                && let Some(thread) = thread
            {
                client.threads.insert(thread.into());
            }
            let send = if notification {
                thread.map_or(own, |thread| client.threads.contains(thread))
            } else {
                own
            };
            if send && client.output.try_send(frame.clone()).is_err() {
                // Never drop a live stream event and pretend the client is current.
                // Reconnection must read the original host's history and receipts.
                client.ended.cancel();
                return false;
            }
            true
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol_io::{notification, success_response};
    use serde_json::json;

    #[tokio::test]
    async fn interaction_delivery_limit_disconnects_its_owner_and_keeps_peer_events() {
        let hub = RpcHub::default();
        let ended = CancellationToken::new();
        let (owner_tx, _owner) = mpsc::channel(4096);
        let (peer_tx, mut peer) = mpsc::channel(1);
        let (frame_tx, frames) = mpsc::channel(128);
        hub.attach("owner", owner_tx, ended.clone());
        hub.attach("peer", peer_tx, CancellationToken::new());
        hub.subscribe("peer", "task");
        let delivered = hub
            .relay_client("owner".into(), frames, ended.clone())
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            for id in 0..=4096u64 {
                frame_tx
                    .send(json!({"method":"item/request","id":id}))
                    .await
                    .unwrap();
            }
            ended.cancelled().await;
        })
        .await
        .expect("owned relay did not close at capacity");
        {
            let delivered = delivered.lock().unwrap();
            assert_eq!(delivered.len(), 4096);
            assert!(delivered.contains(&4095));
            assert!(!delivered.contains(&4096));
        }
        let event = notification("turn/completed", json!({"threadId":"task"}));
        hub.observe(&event, None);
        assert_eq!(peer.try_recv().unwrap(), event);
        hub.close().await;
    }
    #[test]
    fn native_task_state_reaches_only_negotiated_subscribers_of_the_actual_task() {
        let hub = RpcHub::default();
        let (a, mut enabled) = mpsc::channel(8);
        let (b, mut legacy) = mpsc::channel(8);
        let (c, mut other_task) = mpsc::channel(8);
        hub.attach("enabled", a, CancellationToken::new());
        hub.attach("legacy", b, CancellationToken::new());
        hub.attach("other", c, CancellationToken::new());
        hub.subscribe("enabled", "one");
        hub.subscribe("legacy", "one");
        hub.subscribe("other", "two");
        hub.negotiate_task_state("enabled", true);
        hub.negotiate_task_state("other", true);
        assert!(hub.needs_task_state());
        let event = notification(
            kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED,
            json!({"reference":{"threadId":"one","turnId":"original-turn"},
                "state":"running","revision":7}),
        );
        hub.observe(&event, None);
        assert_eq!(enabled.try_recv().unwrap(), event);
        assert!(legacy.try_recv().is_err());
        assert!(other_task.try_recv().is_err());
        hub.negotiate_task_state("enabled", false);
        hub.detach("other");
        assert!(!hub.needs_task_state());
        hub.observe(&event, None);
        assert!(enabled.try_recv().is_err());
    }

    #[test]
    fn task_state_capability_does_not_grant_a_task_subscription_or_survive_disconnect() {
        let hub = RpcHub::default();
        let (tx, mut frames) = mpsc::channel(8);
        let ended = CancellationToken::new();
        hub.attach("viewer", tx, ended.clone());
        hub.negotiate_task_state("viewer", true);
        assert!(hub.needs_task_state());
        let event = notification(
            kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED,
            json!({"reference":{"threadId":"unsubscribed"},"state":"completed"}),
        );
        hub.observe(&event, None);
        assert!(frames.try_recv().is_err());
        ended.cancel();
        assert!(!hub.needs_task_state());
        hub.observe(&event, None);
        assert!(frames.try_recv().is_err());
    }

    #[test]
    fn notifications_are_scoped_and_responses_stay_with_the_original_client() {
        let hub = RpcHub::default();
        let (a, mut first) = mpsc::channel(8);
        let (b, mut second) = mpsc::channel(8);
        hub.attach("a", a, CancellationToken::new());
        hub.attach("b", b, CancellationToken::new());
        hub.subscribe("a", "one");
        hub.subscribe("b", "two");
        let event = notification("turn/completed", json!({"threadId":"one"}));
        hub.observe(&event, None);
        assert_eq!(first.try_recv().unwrap(), event);
        assert!(second.try_recv().is_err());
        let reply = success_response(json!(1), json!({"thread":{"id":"one"}}));
        hub.observe(&reply, Some("b"));
        assert_eq!(second.try_recv().unwrap(), reply);
        assert!(first.try_recv().is_err());
        hub.observe(&event, None);
        assert!(first.try_recv().is_ok() && second.try_recv().is_ok());
        hub.unsubscribe("b", "one");
        hub.observe(&event, Some("a"));
        assert!(first.try_recv().is_ok() && second.try_recv().is_err());
    }
    #[test]
    fn a_slow_or_detached_client_cannot_drop_a_peers_events() {
        let hub = RpcHub::default();
        let (a, mut first) = mpsc::channel(8);
        let (b, _second) = mpsc::channel(1);
        let ended = CancellationToken::new();
        hub.attach("a", a, CancellationToken::new());
        hub.attach("b", b, ended.clone());
        hub.subscribe("a", "one");
        hub.subscribe("b", "one");
        let event = notification("turn/completed", json!({"threadId":"one"}));
        hub.observe(&event, None);
        hub.observe(&event, None);
        assert!(ended.is_cancelled());
        assert_eq!(first.try_recv().unwrap(), event);
        assert_eq!(first.try_recv().unwrap(), event);
        hub.detach("a");
        hub.observe(&event, None);
        assert!(first.try_recv().is_err());
    }
}
