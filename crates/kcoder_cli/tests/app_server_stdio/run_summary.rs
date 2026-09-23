// S01 + S5/R046 end-to-end evidence over the real app-server stdio protocol.
//
// The authoritative run state and the interaction receipts are only useful if
// they survive the real dispatch path: initialize capability negotiation, a real
// turn, a real approval request, and real reply frames.

/// Same deterministic provider as the shared fixture, but with an explicit
/// `ask` mode so gated tools produce a real approval request.
fn write_ask_mode_settings(path: &std::path::Path) {
    std::fs::write(
        path,
        serde_json::to_vec(&json!({
            "permission_mode": "ask",
            "active_provider": "integration-test",
            "providers": {
                "integration-test": {
                    "api_format": "openai_chat_completions",
                    "endpoint": "http://127.0.0.1:1/v1",
                    "default_model": "deterministic-scenario",
                    "context_window_tokens": 128000,
                    "output_headroom_tokens": 8192,
                    "max_output_tokens": 8192,
                    "request_timeout_secs": 30,
                    "no_proxy": true,
                    "extra_body": {}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

impl TestAppServer {
    /// Initialize with the richer run projection negotiated.
    fn initialize_with_run_summary(&mut self, id: i64) -> Value {
        self.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {
                "protocolVersion": "2026-07-27",
                "clientInfo": {"name": "run-summary-test", "version": "1"},
                "capabilities": {"experimental": {"threadRunSummaryV1": true}}
            }
        }));
        self.response(id)
    }

    fn thread_status(&mut self, id: i64, thread_id: &str) -> Value {
        self.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "thread/list",
            "params": {"limit": 100}
        }));
        let listed = self.response(id);
        listed["result"]["threads"]
            .as_array()
            .expect("thread/list threads")
            .iter()
            .find(|thread| thread["id"] == thread_id)
            .cloned()
            .unwrap_or_else(|| panic!("thread {thread_id} missing from thread/list: {listed}"))
    }
}

#[test]
fn run_summary_reaches_stdio_consumers_and_unmatched_replies_stay_safe() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_ask_mode_settings(&settings);
    // A slow deterministic stream keeps the turn observably running.
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "long-write", "120", "0", "0");

    let initialize = server.initialize_with_run_summary(1);
    assert_eq!(
        initialize["result"]["capabilities"]["experimental"]["threadRunSummaryV1"],
        true
    );

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [{"type": "text", "text": "exercise the deterministic long write"}]
        }
    }));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");

    server.wait_for_method("turn/started");
    let running = server.thread_status(4, &thread_id);
    assert_eq!(running["status"], "running");
    assert_eq!(running["runSummary"]["mainTurn"], "running");
    assert_eq!(running["runSummary"]["pendingApprovals"], 0);
    assert_eq!(running["runSummary"]["pendingQuestions"], 0);

    server.wait_for_method("turn/completed");
    let settled = server.thread_status(5, &thread_id);
    assert_eq!(settled["status"], "idle");
    assert_eq!(settled["runSummary"]["mainTurn"], "idle");
    assert_eq!(settled["runSummary"]["activeJobs"], 0);
    assert_eq!(settled["runSummary"]["tasksRunning"], 0);
    assert_eq!(settled["runSummary"]["pendingFollowups"], 0);

    // A reply this connection never issued must not resolve anything and must
    // not break the connection. The approval-path duplicate replay needs the
    // HTTP-fixture harness because `app-server --scenario` bypasses permissions.
    server.send(json!({
        "jsonrpc": "2.0", "id": 9_999_999, "result": {"decision": "accept"}
    }));
    let after_unmatched = server.thread_status(6, &thread_id);
    assert_eq!(after_unmatched["id"], thread_id);
    assert_eq!(after_unmatched["status"], "idle");
    server.shutdown();
}

#[test]
fn resuming_history_hydrates_run_summary_without_sending_a_message() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut first = TestAppServer::start(temp.path(), &settings);
    first.initialize(1);
    first.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = first.response(2)["result"]["thread"]["id"].as_str().unwrap().to_owned();
    first.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,
        "input":[{"type":"text","text":"historical message"}]}}));
    assert!(first.response(3).get("error").is_none());
    first.wait_for_method("turn/completed");
    first.shutdown_successfully();
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize_with_run_summary(1);
    // Listing cannot claim another runtime's counters are idle.
    assert_eq!(server.thread_status(2, &thread)["runSummary"]["mainTurn"], "unknown");
    for request in [3, 4] {
        // First resume restores persisted state; the second selects the resident.
        server.send(json!({"id":request,"method":"thread/resume","params":{"threadId":thread}}));
        let response = server.response(request);
        assert_eq!(response["result"]["thread"]["runSummary"]["mainTurn"], "idle", "{response}");
        for field in ["pendingApprovals", "pendingQuestions", "activeJobs", "tasksPending", "tasksRunning", "pendingFollowups", "pendingGoals"] {
            assert_eq!(response["result"]["thread"]["runSummary"][field], 0, "{field}: {response}");
        }
    }
    server.send(json!({"id":5,"method":"thread/read","params":{"threadId":thread}}));
    let read = server.response(5);
    assert_eq!(read["result"]["thread"]["runSummary"]["mainTurn"], "idle");
    assert_eq!(read["result"]["messages"].as_array().unwrap().iter()
        .filter(|message| message["role"] == "user").count(), 1);
    server.shutdown_successfully();
}
