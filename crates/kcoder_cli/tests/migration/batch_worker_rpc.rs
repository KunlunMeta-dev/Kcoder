use super::{Fixture, TestAppServer, Value, json, rpc};
use std::time::{Duration, Instant};

fn prepare(server: &mut TestAppServer) -> Value {
    let page = rpc(
        server,
        401,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let scan = rpc(
        server,
        402,
        "migration/batch/scan",
        json!({"sourceIds":[],"historySources":[{
        "catalogId":page["catalogId"], "sourceHandle":page["items"][0]["sourceHandle"]}]}),
    );
    rpc(
        server,
        403,
        "migration/batch/plan",
        json!({"jobId":scan["job"]["jobId"],
        "expectedSequence":scan["job"]["sequence"],"choices":[],"includeDefaultItems":true}),
    )
}
fn start(server: &mut TestAppServer, state: &Value, request: &str, mode: &str) -> Value {
    rpc(
        server,
        404,
        "migration/batch/run",
        json!({"jobId":state["job"]["jobId"],
        "expectedSequence":state["job"]["sequence"], "planId":state["batch"]["planId"],
        "requestId":request,"mode":mode}),
    )
}
fn wait_for(server: &mut TestAppServer, job: &Value, check: impl Fn(&Value) -> bool) -> Value {
    // Some waits cover a full 3000-record normalization, which takes 45-60 s
    // in an unoptimized build on a disk-backed filesystem. Cancellation itself
    // is observed within milliseconds; this bound only covers completion.
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let current = rpc(server, 405, "migration/batch/read", json!({"jobId":job}));
        if check(&current) {
            return current;
        }
        assert!(
            Instant::now() < deadline,
            "batch worker did not reach the requested checkpoint: {current}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn asynchronous_batch_can_be_observed_cancelled_and_explicitly_resumed_on_the_same_child() {
    let fixture = Fixture::new();
    let source = fixture.source(3000);
    let original = std::fs::read(&source).unwrap();
    let mut server = fixture.start();
    let planned = prepare(&mut server);
    let job = planned["job"]["jobId"].clone();
    let started = start(&mut server, &planned, "owned-async-batch", "apply");
    assert_eq!(started["workerRunning"], true);
    let progressing = wait_for(&mut server, &job, |value| {
        value["progress"]["history"].is_object()
    });
    assert_eq!(progressing["workerRunning"], true);
    let cancelled = rpc(
        &mut server,
        406,
        "migration/cancel",
        json!({"jobId":job,
        "expectedSequence":progressing["state"]["job"]["sequence"]}),
    );
    assert!(matches!(
        cancelled["job"]["status"].as_str(),
        Some("cancel_requested" | "cancelled")
    ));
    let stopped = wait_for(&mut server, &job, |value| value["workerRunning"] == false);
    assert_eq!(stopped["state"]["job"]["status"], "cancelled");
    let page = rpc(&mut server, 407, "migration/items", json!({"jobId":job}));
    let item = page["items"][0]["id"].clone();
    let detail = rpc(
        &mut server,
        408,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":item}),
    );
    let child = detail["item"]["historyJobId"].clone();
    let resumed = start(
        &mut server,
        &stopped["state"],
        "explicit-batch-resume",
        "resume",
    );
    assert_eq!(resumed["workerRunning"], true);
    let done = wait_for(&mut server, &job, |value| value["workerRunning"] == false);
    assert!(done["workerError"].is_null(), "{done}");
    assert_eq!(done["state"]["job"]["status"], "completed");
    let archived = rpc(
        &mut server,
        409,
        "migration/history/read",
        json!({"jobId":child}),
    );
    assert_eq!(archived["job"]["normalization"]["normalizedRecords"], 3000);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    server.shutdown();
    let mut server = fixture.start();
    let observed = rpc(
        &mut server,
        410,
        "migration/batch/read",
        json!({"jobId":job}),
    );
    assert_eq!(observed["workerRunning"], false);
    assert_eq!(observed["state"], done["state"]);
    let detail = rpc(
        &mut server,
        411,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":item}),
    );
    assert_eq!(detail["item"]["historyJobId"], child);
}

#[test]
fn closing_the_connection_stops_its_batch_without_replaying_or_replacing_the_history_child() {
    let fixture = Fixture::new();
    let source = fixture.source(3000);
    let original = std::fs::read(&source).unwrap();
    let mut server = fixture.start();
    let planned = prepare(&mut server);
    let job = planned["job"]["jobId"].clone();
    start(&mut server, &planned, "disconnect-owned-batch", "apply");
    let in_progress = wait_for(&mut server, &job, |value| {
        value["progress"]["history"].is_object()
    });
    assert_eq!(in_progress["workerRunning"], true);
    server.shutdown();
    let mut server = fixture.start();
    let stopped = rpc(
        &mut server,
        420,
        "migration/batch/read",
        json!({"jobId":job}),
    );
    assert_eq!(stopped["workerRunning"], false);
    assert_eq!(stopped["state"]["job"]["status"], "applying");
    let page = rpc(&mut server, 421, "migration/items", json!({"jobId":job}));
    let item = page["items"][0]["id"].clone();
    let detail = rpc(
        &mut server,
        422,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":item}),
    );
    let child = detail["item"]["historyJobId"].clone();
    start(
        &mut server,
        &stopped["state"],
        "resume-after-disconnect",
        "resume",
    );
    let done = wait_for(&mut server, &job, |value| value["workerRunning"] == false);
    assert!(done["workerError"].is_null(), "{done}");
    assert_eq!(done["state"]["job"]["status"], "completed");
    let detail = rpc(
        &mut server,
        423,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":item}),
    );
    assert_eq!(detail["item"]["historyJobId"], child);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    server.shutdown();
}
