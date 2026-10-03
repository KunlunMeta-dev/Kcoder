//! Finalize display-only tool state after execution has stopped. Never manufacture
//! a tool result: missing outcomes must still block unsafe automatic continuation.
use super::*;

pub(super) fn settle_inactive_tools(
    thread: &Thread,
    messages: &mut [ThreadMessage],
    facts: Option<kcoder_app_protocol::ThreadRunFacts>,
) {
    use kcoder_app_protocol::ThreadStatus;
    // Unknown or live work is not evidence of interruption. Background tools may
    // outlive the foreground turn, including a cancelled foreground turn.
    if !matches!(
        facts.map_or(thread.status.clone(), |facts| facts.state()),
        ThreadStatus::Idle | ThreadStatus::Failed
    ) {
        return;
    }
    for message in messages {
        for block in &mut message.blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool")
                || !matches!(
                    block.get("status").and_then(Value::as_str),
                    Some("pending" | "streaming" | "generating_arguments")
                )
                || block
                    .get("tool_output")
                    .is_some_and(|value| !value.is_null())
            {
                continue;
            }
            block["status"] = json!("error");
            block["recovery_reason"] = json!("result_unavailable");
            // Do not invent completion timestamps or successful output. These
            // fields describe recorded execution facts, not the time of reopening.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(status: &str) -> ThreadReadResult {
        serde_json::from_value(json!({
            "thread": {"id":"fixture", "cwd":"/tmp", "status":status, "createdAt":"1", "updatedAt":"10"},
            "messages":[{"id":"message", "role":"assistant", "content":"", "timestampMs":10,
                "blocks":[
                    {"type":"tool", "id":"lost", "status":"pending", "tool_output":null, "completed_at":null},
                    {"type":"tool", "id":"done", "status":"done", "tool_output":"actual result", "completed_at":20}
                ]}],
            "rangeStart":0,"rangeEnd":1,"hasMoreBefore":false
        })).unwrap()
    }

    #[test]
    fn inactive_missing_result_is_terminal_but_not_fabricated() {
        for status in ["idle", "failed"] {
            let mut page = page(status);
            settle_inactive_tools(&page.thread, &mut page.messages, None);
            let blocks = &page.messages[0].blocks;
            assert_eq!(blocks[0]["status"], "error");
            assert_eq!(blocks[0]["recovery_reason"], "result_unavailable");
            assert!(blocks[0]["tool_output"].is_null());
            assert!(blocks[0]["completed_at"].is_null());
            assert_eq!(blocks[1]["tool_output"], "actual result");
            assert_eq!(blocks[1]["status"], "done");
        }
    }

    #[test]
    fn live_or_unobservable_work_is_not_marked_stopped() {
        for status in [
            "running",
            "background",
            "aggregating",
            "waiting_for_approval",
            "waiting_for_answer",
            "unknown",
        ] {
            let mut page = page(status);
            let previous = page.messages.clone();
            settle_inactive_tools(&page.thread, &mut page.messages, None);
            assert_eq!(page.messages, previous);
        }
    }
}
