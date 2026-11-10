//! CT-99 L1 evidence against a real app-server.
//!
//! This module records what the current host really does with a requirement
//! that is durable while its target is busy. Two host facts shape the test:
//!
//! * The client-facing mutation surface is not offered yet: the dispatcher
//!   answers `-32601` because
//!   `continuous_work_mutation::continuous_work_mutation_dispatch_ready` is off,
//!   so `work/input/submit`/`work/input/read` cannot carry a receipt. The
//!   requirement is therefore written through the same store the server owns,
//!   as the test-only stand-in for that RPC.
//! * The automatic turn settles a dispatched requirement as
//!   `needs_reconciliation` when the input handoff never observed it, so the
//!   record must not be read as "applied" - and this test asserts exactly that
//!   instead of assuming a stronger outcome.
//!
//! Every consumption fact comes from the real host: the automatic turn the
//! scheduler claims, the provider request it really sends, and the durable
//! settlement it records. Observations are read back through `work/read` (RPC)
//! and the store's own read API, never from log text.
use super::*;
use kcoder_state::continuous_work::{
    ContinuousWorkStore, HostWorkScope, InputAdmission, WorkInputSource,
};
use kcoder_types::continuous_work::{WorkInputKind, WorkInputState};

const QUEUE_TOKEN: &str = "ct99-queued-requirement";
const BUSY_APPEND_TOKEN: &str = "ct99-active-turn-append";
const READ_TIMEOUT: Duration = Duration::from_secs(90);

/// One live app-server with a goal-bound work item it is still consuming.
struct Fixture {
    /// Kept alive because the app-server reads this private profile.
    #[allow(dead_code, reason = "the private root must outlive the server")]
    temp: tempfile::TempDir,
    server: TestAppServer,
    config: std::path::PathBuf,
    requests: std::path::PathBuf,
    thread: String,
    turn_id: String,
    work_id: String,
    store: ContinuousWorkStore,
    source: WorkInputSource,
    scope: kcoder_types::continuous_work::WorkScope,
}

fn write_ct99_settings(settings: &std::path::Path) {
    write_test_settings(settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    // The valve stays closed, so no ordinary automatic continuation is spent:
    // only a durable queued requirement may start a turn here.
    value["goal_max_auto_continuations"] = json!(5);
    value["continuous_work"] = json!({"dispatch_enabled": false});
    value["session_memory"] = json!({"enabled": false});
    std::fs::write(settings, serde_json::to_vec(&value).unwrap()).unwrap();
}

/// Poll `work/list` until the goal-bound record for this thread is observable.
fn wait_for_bound_work(server: &mut TestAppServer, first_id: i64, thread: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut id = first_id;
    loop {
        server.send(json!({"id":id,"method":"work/list","params":{}}));
        let page = server.response(id);
        id += 1;
        if let Some(work) = page["result"]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["threadId"] == thread))
        {
            return work["workId"].as_str().unwrap().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the goal input was not bound to a work record: {page}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Start one goal-bound work item and stop while its foreground turn is live.
fn busy_fixture() -> Fixture {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let requests = temp.path().join("recorded-requests");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&requests).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_ct99_settings(&settings);

    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("goal-pro")
        .stream_delay_ms("200")
        .text_chunk_chars(4096)
        .discard_stderr()
        .env("KCODER_TUI_LAB_REQUEST_DIR", &requests)
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"continuous-task-ct99","version":"1"},
        "capabilities":{"experimental":{
            "continuousWorkReadV1":true,
            "continuousWorkInputV1":true,
            "continuousWorkControlV1":true
        }}
    }}));
    let initialized = server.response(1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["continuousWorkReadV1"],
        json!(true),
        "{initialized}"
    );
    // The submit and control receipts this case is written against stay
    // unadvertised, and the host must refuse them rather than fake a receipt.
    for (id, name) in [(2, "continuousWorkInputV1"), (3, "continuousWorkControlV1")] {
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"][name],
            json!(false),
            "{initialized}"
        );
        let _ = id;
    }
    for (id, method) in [
        (4, "work/input/submit"),
        (5, "work/input/read"),
        (6, "work/control"),
    ] {
        let params = match method {
            "work/control" => json!({"threadId":"no-thread","workId":"no-work",
                "requestId":"ct99-control","expectedRevision":1,"action":"pause"}),
            _ => json!({"threadId":"no-thread","workId":"no-work","inputId":"ct99-input",
                "requestId":"ct99-request","expectedRevision":1,"text":"ct99 text"}),
        };
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let refused = server.response(id);
        assert_eq!(refused["error"]["code"], json!(-32601), "{refused}");
        assert_eq!(
            refused["error"]["message"],
            json!("continuous work mutation was not negotiated"),
            "{refused}"
        );
    }

    server.send(json!({"id":10,"method":"thread/start","params":{}}));
    let thread = server.response(10)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":11,"method":"turn/start","params":{
        "threadId":thread,
        "input":[{"type":"text","text":"continuous-work-fixture-request: please complete this task"}]
    }}));
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut accepted = false;
    let mut started = false;
    let (mut turn_id, mut attempt_id) = (String::new(), String::new());
    while !(accepted && started) {
        let value = server.next_value(deadline);
        if value["id"] == json!(11) {
            assert!(value.get("error").is_none(), "{value}");
            turn_id = value["result"]["turn"]["id"].as_str().unwrap().to_owned();
            attempt_id = value["result"]["turn"]["attemptId"]
                .as_str()
                .unwrap()
                .to_owned();
            accepted = true;
        }
        if value["method"] == json!("turn/started")
            && value["params"]["turn"]["threadId"] == json!(thread)
            && value["params"]["turn"]["internal"] != json!(true)
        {
            started = true;
        }
    }
    assert!(!attempt_id.is_empty(), "an accepted turn owns an attempt");

    // A second foreground turn cannot become the busy-time append: the target
    // refuses it, so the requirement has to be durable input for a later turn.
    server.send(json!({"id":12,"method":"turn/start","params":{
        "threadId":thread,"clientMessageId":"ct99-live-append",
        "input":[{"type":"text","text":BUSY_APPEND_TOKEN}]
    }}));
    let busy = server.response(12);
    assert_eq!(busy["error"]["code"], json!(-32003), "{busy}");

    let work_id = wait_for_bound_work(&mut server, 13, &thread);
    let host = HostWorkScope::capture(&config, &workspace, None).unwrap();
    let store = ContinuousWorkStore::open_existing(&config)
        .unwrap()
        .unwrap();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: host.scope().target_id.clone(),
        conversation_id: thread.clone(),
    };
    Fixture {
        scope: host.scope().clone(),
        temp,
        server,
        config,
        requests,
        thread,
        turn_id,
        work_id,
        store,
        source,
    }
}

impl Fixture {
    /// Persist one requirement the way the target persists a busy-time append.
    fn queue_requirement(&self, request_id: &str, text: &str) -> anyhow::Result<InputAdmission> {
        let work = self
            .store
            .read_work(&self.scope, &self.work_id)?
            .expect("the bound work record must exist");
        let deliveries = self
            .store
            .accepted_deliveries(&self.scope, &self.work_id)?
            .expect("a bound requirement work owns a delivery snapshot");
        self.store.queue_input(
            &self.scope,
            &self.work_id,
            &self.source,
            work.revision.revision,
            "ct99-input-1",
            request_id,
            WorkInputKind::Requirement,
            json!({"text": text}),
            Some(deliveries),
        )
    }

    fn receipt(&self) -> kcoder_types::continuous_work::WorkInputReceipt {
        self.store
            .read_input(&self.scope, &self.work_id, &self.source, "ct99-input-1")
            .unwrap()
            .expect("the queued requirement must stay readable")
            .0
    }

    fn record(&self) -> kcoder_state::continuous_work::WorkInputEntry {
        self.store
            .list_inputs(&self.scope, &self.work_id, None)
            .unwrap()
            .inputs
            .into_iter()
            .find(|entry| entry.receipt.input_id == "ct99-input-1")
            .expect("the requirement exists exactly once")
    }

    fn watermark(&self) -> (u64, u64, u64) {
        let work = self
            .store
            .read_work(&self.scope, &self.work_id)
            .unwrap()
            .expect("the work record must stay readable");
        (
            work.revision.accepted_input_sequence,
            work.revision.applied_input_sequence,
            work.revision.requirements_revision,
        )
    }

    fn requirement_count(&self) -> usize {
        self.store
            .list_inputs(&self.scope, &self.work_id, None)
            .unwrap()
            .inputs
            .iter()
            .filter(|entry| entry.receipt.input_id == "ct99-input-1")
            .count()
    }

    /// Read the durable work item through the negotiated RPC, not the store.
    fn read_work(&mut self, id: i64) -> Value {
        self.server
            .send(json!({"id":id,"method":"work/read","params":{"workId":self.work_id}}));
        let read = self.server.response(id);
        assert!(read.get("error").is_none(), "{read}");
        read["result"].clone()
    }

    /// `(requirementsRevision, unconsumedInputs, pending inputs)` from the RPC.
    fn observed_queue(&mut self, id: i64) -> (u64, u64, Vec<(String, u64, String)>) {
        let result = self.read_work(id);
        assert_eq!(result["presence"], json!("present"), "{result}");
        let work = &result["work"];
        let pending = work["pendingInputs"]
            .as_array()
            .expect("an observed queue is listed, empty or not")
            .iter()
            .map(|input| {
                (
                    input["inputId"].as_str().unwrap().to_owned(),
                    input["sequence"].as_u64().unwrap(),
                    input["state"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        (
            work["requirementsRevision"].as_u64().unwrap(),
            work["unconsumedInputs"].as_u64().unwrap(),
            pending,
        )
    }

    /// Wait until the dispatched requirement is no longer queued or in flight.
    fn wait_for_settlement(&mut self) -> (u64, u64, String) {
        let deadline = Instant::now() + READ_TIMEOUT;
        loop {
            let (requirements, unconsumed, pending) = self.observed_queue(30);
            let state = self.receipt().state.as_str().to_owned();
            let settled = !matches!(state.as_str(), "queued" | "dispatched");
            if settled {
                return (requirements, unconsumed, state);
            }
            assert!(
                Instant::now() < deadline,
                "the dispatched requirement never settled: requirements={requirements} \
                 unconsumed={unconsumed} pending={pending:?} state={state}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The provider request bodies the deterministic mock really served.
    fn recorded_requests(&self) -> Vec<String> {
        let mut bodies = Vec::new();
        for entry in std::fs::read_dir(&self.requests).unwrap().flatten() {
            bodies.push(std::fs::read_to_string(entry.path()).unwrap());
        }
        bodies
    }

    fn delivered_queued_times(&self) -> usize {
        self.recorded_requests()
            .iter()
            .filter(|body| body.contains(QUEUE_TOKEN))
            .count()
    }
}

/// Advance through the frames of one foreground turn until it is terminal.
fn wait_for_turn_end(server: &mut TestAppServer, thread: &str, internal: bool) -> Value {
    let deadline = Instant::now() + READ_TIMEOUT;
    loop {
        let value = server.next_value(deadline);
        if value["method"] == json!("turn/completed")
            && value["params"]["turn"]["threadId"] == json!(thread)
            && (value["params"]["turn"]["internal"] == json!(true)) == internal
        {
            return value;
        }
    }
}

/// Wait for one automatic turn to start and return its turn id.
fn wait_for_automatic_turn(server: &mut TestAppServer, thread: &str) -> String {
    let deadline = Instant::now() + READ_TIMEOUT;
    loop {
        let value = server.next_value(deadline);
        if value["method"] == json!("turn/started")
            && value["params"]["turn"]["threadId"] == json!(thread)
            && value["params"]["turn"]["internal"] == json!(true)
        {
            return value["params"]["turn"]["id"].as_str().unwrap().to_owned();
        }
    }
}

/// A busy target keeps the requirement durable, accepted once and unapplied;
/// the host then dispatches it into exactly one automatic turn and never counts
/// it as applied, because its own handoff observation stayed unknown.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn continuous_task_ct99_l1_a_queued_requirement_is_accepted_once_and_never_applied_twice() {
    let mut fixture = busy_fixture();
    assert_eq!(fixture.watermark(), (1, 1, 1));
    let before = fixture
        .store
        .read_work(&fixture.scope, &fixture.work_id)
        .unwrap()
        .unwrap();
    assert_eq!(before.origin.initial_attempt.turn_id, fixture.turn_id);

    // Step 2: the requirement becomes durable while the target is still busy.
    // It is accepted exactly once and queued, never applied.
    let text = format!("{QUEUE_TOKEN} keep the original requirement in order");
    let admission = fixture.queue_requirement("ct99-request-1", &text).unwrap();
    let InputAdmission::Accepted(receipt) = admission else {
        panic!("a first submission must be newly accepted");
    };
    assert_eq!(receipt.state, WorkInputState::Queued);
    assert_eq!(receipt.sequence, 2);
    assert_eq!(receipt.requirements_revision, Some(2));
    assert_eq!(fixture.receipt().state, WorkInputState::Queued);
    assert_eq!(fixture.record().applied, None);
    assert_eq!(
        fixture.watermark(),
        (2, 1, 2),
        "a queued requirement advances acceptance, not application"
    );

    // The foreground turn owns the first requirement and is still running, so
    // its terminal frame has not been consumed yet.
    let foreground = wait_for_turn_end(&mut fixture.server, &fixture.thread, false);
    assert_eq!(foreground["params"]["turn"]["status"], json!("completed"));

    // Step 3a: after the busy turn ended the requirement is still only queued.
    let (requirements, unconsumed, pending) = fixture.observed_queue(20);
    assert_eq!(
        requirements, 2,
        "acceptance advanced the requirement revision exactly once"
    );
    assert_eq!(unconsumed, 1);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0].0, "ct99-input-1");
    assert_eq!(pending[0].1, 2);
    assert_eq!(pending[0].2, "queued");
    assert_eq!(fixture.record().applied, None);
    assert_eq!(fixture.watermark(), (2, 1, 2));

    // Step 4: the same identity returns the original record and the same id
    // with different text is refused. Neither adds a second durable record.
    let replay = fixture.queue_requirement("ct99-request-1", &text).unwrap();
    let InputAdmission::Existing(replayed) = replay else {
        panic!("an identical replay must report the original receipt");
    };
    assert_eq!(replayed.sequence, 2);
    assert_eq!(replayed.request_id, "ct99-request-1");
    assert_eq!(replayed.requirements_revision, Some(2));
    let changed = fixture
        .queue_requirement("ct99-request-1", "different text")
        .expect_err("the same input id with different text must be refused");
    assert!(
        changed
            .chain()
            .map(ToString::to_string)
            .any(|code| code.starts_with("CONTINUOUS_WORK_")),
        "the refusal must be a stable continuous-work code: {changed:#}"
    );
    // A second transport attempt for the same text is still one requirement.
    let renamed = fixture.queue_requirement("ct99-request-2", &text).unwrap();
    let InputAdmission::Existing(renamed) = renamed else {
        panic!("a repeated requirement must never be accepted twice");
    };
    assert_eq!(renamed.request_id, "ct99-request-1");
    assert_eq!(renamed.sequence, 2);
    assert_eq!(fixture.requirement_count(), 1);
    assert_eq!(fixture.watermark(), (2, 1, 2));

    // Step 3b: the host dispatches the queued requirement into exactly one
    // automatic turn. The model really received it once, and the target still
    // refuses to call it applied.
    let automatic = wait_for_automatic_turn(&mut fixture.server, &fixture.thread);
    let completed = wait_for_turn_end(&mut fixture.server, &fixture.thread, true);
    assert_eq!(completed["params"]["turn"]["id"], json!(automatic));
    let (requirements, unconsumed, state) = fixture.wait_for_settlement();
    assert_eq!(
        requirements, 2,
        "application must not advance the requirement revision"
    );
    assert_ne!(state, "applied", "the host never observed the handoff");
    assert_eq!(
        state, "needs_reconciliation",
        "an unobserved automatic handoff stays an explicit unknown"
    );
    assert_eq!(
        unconsumed, 1,
        "an unconfirmed requirement still blocks completion"
    );
    let record = fixture.record();
    assert_eq!(record.applied, None);
    assert_eq!(record.receipt.sequence, 2);
    assert_eq!(fixture.requirement_count(), 1);
    assert_eq!(
        fixture.watermark(),
        (2, 1, 2),
        "the applied watermark never advanced for an unconfirmed requirement"
    );
    assert_eq!(
        fixture.delivered_queued_times(),
        1,
        "the queued requirement reached the provider exactly once"
    );
    assert!(
        !fixture
            .recorded_requests()
            .iter()
            .any(|body| body.contains(BUSY_APPEND_TOKEN)),
        "the refused active-turn append must never reach the provider"
    );
    let (revision, _, pending) = fixture.observed_queue(21);
    assert!(revision > 0);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0].2, "needs_reconciliation");
    fixture.server.shutdown_successfully();

    // The same identity stays readable after the host exited, still without a
    // second record and still without an applied claim.
    let after = ContinuousWorkStore::open_existing(&fixture.config)
        .unwrap()
        .unwrap();
    let recovered = after
        .read_input(
            &fixture.scope,
            &fixture.work_id,
            &fixture.source,
            "ct99-input-1",
        )
        .unwrap()
        .expect("the unconfirmed requirement must survive the host exit");
    assert_eq!(recovered.0.state, WorkInputState::NeedsReconciliation);
    assert_eq!(recovered.0.sequence, 2);
    assert_eq!(
        after
            .read_work(&fixture.scope, &fixture.work_id)
            .unwrap()
            .unwrap()
            .revision
            .applied_input_sequence,
        1
    );
}

/// An interrupted turn keeps the queued requirement queued and unduplicated.
///
/// The interrupt lands before the turn settles, so the requirement must stay
/// durable and unapplied. After the goal is resumed the same requirement is the
/// only one dispatched, and it still never becomes an applied claim.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn continuous_task_ct99_l1_an_interrupted_turn_leaves_the_queue_unduplicated() {
    let mut fixture = busy_fixture();
    let text = format!("{QUEUE_TOKEN} survives an interrupted turn");
    let admission = fixture.queue_requirement("ct99-request-1", &text).unwrap();
    assert!(matches!(admission, InputAdmission::Accepted(_)));
    assert_eq!(fixture.receipt().state, WorkInputState::Queued);
    assert_eq!(fixture.watermark(), (2, 1, 2));

    // Interrupt the live turn before it settles.
    fixture
        .server
        .send(json!({"id":40,"method":"turn/interrupt","params":{
            "threadId":fixture.thread,"turnId":fixture.turn_id
        }}));
    let interrupted = fixture.server.response(40);
    assert_eq!(
        interrupted["result"]["interrupted"],
        json!(true),
        "{interrupted}"
    );
    let terminal = wait_for_turn_end(&mut fixture.server, &fixture.thread, false);
    assert_ne!(
        terminal["params"]["turn"]["status"],
        json!("completed"),
        "the interrupted turn must not report completion"
    );

    // The requirement stays queued, accepted once, and never applied: an
    // interrupted turn must not consume what it never carried.
    let (requirements, unconsumed, pending) = fixture.observed_queue(42);
    assert_eq!(requirements, 2);
    assert_eq!(unconsumed, 1);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0].2, "queued");
    assert_eq!(fixture.receipt().state, WorkInputState::Queued);
    assert_eq!(fixture.record().applied, None);
    assert_eq!(fixture.requirement_count(), 1);
    assert_eq!(fixture.watermark(), (2, 1, 2));
    assert_eq!(
        fixture.delivered_queued_times(),
        0,
        "an interrupted turn never sent the queued requirement to the provider"
    );

    // Resume the paused goal: the still-queued requirement is what starts the
    // next automatic turn, and it stays a single durable record.
    fixture
        .server
        .send(json!({"id":41,"method":"thread/goal/set","params":{
            "threadId":fixture.thread,"status":"active"
        }}));
    let resumed = fixture.server.response(41);
    assert!(resumed.get("error").is_none(), "{resumed}");
    let automatic = wait_for_automatic_turn(&mut fixture.server, &fixture.thread);
    let completed = wait_for_turn_end(&mut fixture.server, &fixture.thread, true);
    assert_eq!(completed["params"]["turn"]["id"], json!(automatic));
    let (requirements, _, state) = fixture.wait_for_settlement();
    assert_eq!(requirements, 2, "the resumed turn accepted nothing new");
    assert_ne!(state, "applied");
    assert_eq!(fixture.record().applied, None);
    assert_eq!(fixture.requirement_count(), 1);
    assert_eq!(
        fixture.delivered_queued_times(),
        1,
        "the requirement is carried by exactly one turn after the resume"
    );
    assert_eq!(
        fixture.watermark().2,
        2,
        "a resume must not create a second acceptance"
    );
    fixture.server.shutdown_successfully();
}
