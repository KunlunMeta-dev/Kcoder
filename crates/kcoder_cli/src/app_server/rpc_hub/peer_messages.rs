//! Per-client wire projection. Presentation negotiation is never an access grant.
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Default)]
pub struct PeerMessagePresentation {
    supported: AtomicBool,
}
impl PeerMessagePresentation {
    pub fn negotiate(&self, supported: bool) {
        self.supported.store(supported, Ordering::Release);
    }
    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::Acquire)
    }
    pub fn allows_notification(&self, frame: &Value) -> bool {
        self.supported() || allows_legacy_notification(frame)
    }
}

fn is_peer(value: &Value) -> bool {
    value.get("role").and_then(Value::as_str) == Some("peer_agent")
        || value.get("origin").and_then(Value::as_str) == Some("peer_agent")
        || value.get("type").and_then(Value::as_str) == Some("peerAgentMessage")
}
fn allows_legacy_notification(frame: &Value) -> bool {
    if !matches!(
        frame.get("method").and_then(Value::as_str),
        Some("item/started" | "item/delta" | "item/completed")
    ) {
        return true;
    }
    let params = &frame["params"];
    !is_peer(params) && !is_peer(&params["item"])
}

/// Called only for Native thread/read, indexed read and inline-resume results.
/// Source ordinals remain unchanged. A filtered display has no full-view proof.
pub fn project_peer_history(result: &mut Value, supported: bool) {
    if supported {
        return;
    }
    let page = if result.get("messages").is_some() {
        result
    } else if result["history"]["status"] == "ready" {
        &mut result["history"]["page"]
    } else {
        return;
    };
    let Some(messages) = page.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let length = messages.len();
    messages.retain(|row| !is_peer(row));
    if messages.len() == length {
        return;
    }
    let Some(page) = page.as_object_mut() else {
        return;
    };
    page.remove("transcriptSnapshotV1");
    page.remove("transcriptObservationV1");
    if let Some(cursor) = page.get("beforeCursor").and_then(Value::as_str)
        && cursor.starts_with("tp1:")
    {
        let ordinal = cursor
            .rsplit(':')
            .next()
            .and_then(|value| value.parse::<u64>().ok());
        if let Some(ordinal) = ordinal {
            page.insert("beforeCursor".into(), ordinal.to_string().into());
        } else {
            page.remove("beforeCursor");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page() -> Value {
        json!({"messages":[
            {"id":"user","role":"user","content":"A request mentioning peer_agent"},
            {"id":"peer","role":"peer_agent","origin":"peer_agent","content":"Untrusted input"},
            {"id":"assistant","role":"assistant","content":"Reply to a peer"}],
            "rangeStart":7,"rangeEnd":10,"hasMoreBefore":true,
            "beforeCursor":"tp1:ob1-digest:7",
            "transcriptSnapshotV1":{"snapshotId":"source-proof"},
            "transcriptObservationV1":{"observationId":"source-observation"}})
    }
    #[test]
    fn only_typed_peer_inputs_are_hidden_and_native_ranges_do_not_shift() {
        let mut old = page();
        project_peer_history(&mut old, false);
        assert_eq!(old["messages"].as_array().unwrap().len(), 2);
        assert_eq!(old["messages"][0]["id"], "user");
        assert_eq!(old["messages"][1]["id"], "assistant");
        assert_eq!(old["rangeStart"], 7);
        assert_eq!(old["rangeEnd"], 10);
        assert_eq!(old["beforeCursor"], "7");
        assert!(old.get("transcriptSnapshotV1").is_none());
        assert!(old.get("transcriptObservationV1").is_none());
        let mut modern = page();
        project_peer_history(&mut modern, true);
        assert_eq!(modern, page());
    }
    #[test]
    fn inline_resume_uses_the_same_projection_without_changing_other_results() {
        let mut response =
            json!({"thread":{"id":"thread"},"history":{"status":"ready","page":page()}});
        project_peer_history(&mut response, false);
        assert_eq!(
            response["history"]["page"]["messages"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(response["thread"]["id"], "thread");
        let mut no_history = json!({"thread":{"id":"thread"},"history":{"status":"unavailable","code":"readFailed"}});
        let original = no_history.clone();
        project_peer_history(&mut no_history, false);
        assert_eq!(no_history, original);
    }
    #[test]
    fn receive_negotiation_is_per_client_and_never_interprets_body_text() {
        let modern = PeerMessagePresentation::default();
        let old = PeerMessagePresentation::default();
        modern.negotiate(true);
        let peer = json!({"method":"item/completed","params":{"sequence":19,"item":{"type":"peerAgentMessage","text":"input"}}});
        assert!(modern.allows_notification(&peer));
        assert!(!old.allows_notification(&peer));
        assert!(old.allows_notification(&json!({"method":"item/completed","params":{"item":{"type":"assistantMessage","text":"peer_agent"}}})));
        modern.negotiate(false);
        assert!(!modern.allows_notification(&peer));
        assert!(old.allows_notification(&json!({"method":"kcoder/peerRouter/requestV1","params":{"payload":{"role":"peer_agent"}}})));
    }
}
