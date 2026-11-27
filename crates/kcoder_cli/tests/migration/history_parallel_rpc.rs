//! Public stdio admission uses real owned sources, execution leases and archive receipts.
use super::*;
use kcoder_migration::history_jobs::{
    HISTORY_IMPORT_CONCURRENCY, HistoryExecutionState, HistoryJobStore,
};
use std::collections::{BTreeMap, BTreeSet};

/// Read an execution state while workers hold the lifecycle lease. Contention is
/// the documented retryable outcome; any other error still fails the test.
fn observed_execution_state(store: &HistoryJobStore, job: &str) -> HistoryExecutionState {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match store.execution_state(job) {
            Err(error)
                if error.to_string() == "external_history_lifecycle_busy"
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            result => return result.unwrap(),
        }
    }
}

fn responses(server: &TestAppServer, ids: impl IntoIterator<Item = i64>) -> BTreeMap<i64, Value> {
    let mut pending: BTreeSet<_> = ids.into_iter().collect();
    let mut values = BTreeMap::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    while !pending.is_empty() {
        let value = server.next_value(deadline);
        if let Some(id) = value["id"].as_i64() {
            assert!(
                pending.remove(&id),
                "unexpected or duplicate owned response {id}"
            );
            values.insert(id, value);
        }
    }
    values
}

// Sampling reads only the explicitly owned fixture process, never source or model data.
fn process_sample(server: &TestAppServer) -> Value {
    #[cfg(target_os = "linux")]
    {
        let pid = server.child.id();
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let fields: Vec<_> = stat
            .rsplit_once(") ")
            .map(|(_, tail)| tail.split_whitespace().collect())
            .unwrap_or_default();
        let io = fs::read_to_string(format!("/proc/{pid}/io")).unwrap_or_default();
        let mut sample = BTreeMap::new();
        for line in io.lines() {
            if let Some((key, value)) = line.split_once(':')
                && matches!(
                    key,
                    "rchar" | "wchar" | "read_bytes" | "write_bytes" | "syscr" | "syscw"
                )
            {
                sample.insert(key.to_owned(), value.trim().parse::<u64>().unwrap_or(0));
            }
        }
        sample.insert(
            "fdCount".into(),
            fs::read_dir(format!("/proc/{pid}/fd"))
                .map(|entries| entries.count() as u64)
                .unwrap_or(0),
        );
        sample.insert(
            "threads".into(),
            fields
                .get(17)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
        sample.insert(
            "user_ticks".into(),
            fields
                .get(11)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
        sample.insert(
            "system_ticks".into(),
            fields
                .get(12)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
        json!(sample)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = server;
        Value::Null
    }
}

#[test]
fn public_stdio_admits_sixty_four_history_workers_and_queues_the_sixty_fifth_without_replay() {
    let f = Fixture::new();
    let count = HISTORY_IMPORT_CONCURRENCY + 1;
    // Real records keep the admission overlap observable without a worker hook or artificial delay.
    for _ in 0..count {
        let path = f.source(128);
        let original = fs::read_to_string(&path).unwrap();
        let mut file = fs::File::create(&path).unwrap();
        for line in original.lines() {
            let mut record: Value = serde_json::from_str(line).unwrap();
            record["message"]["content"] = json!("Owned migration record. ".repeat(128));
            writeln!(file, "{record}").unwrap();
        }
    }
    let mut builder = TestAppServer::builder(&f.workspace, &f.overlay)
        .config_dir(&f.profile)
        .discard_stderr();
    for (key, value) in [
        ("HOME", f.root.path()),
        ("USERPROFILE", f.root.path()),
        ("CLAUDE_CONFIG_DIR", f.claude.as_path()),
        ("CODEX_HOME", f.codex.as_path()),
    ] {
        builder
            .extra_env
            .push((key.into(), value.as_os_str().into()));
    }
    let mut server = builder.spawn();
    let init = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27",
        "clientInfo":{"name":"owned-history-parallel","version":"1"},
        "capabilities":{"experimental":{"migrationHistoryWorkerStateV1":true}}}),
    );
    assert_eq!(
        init["capabilities"]["experimental"]["migrationHistoryConcurrency32V1"],
        true
    );
    assert_eq!(
        init["capabilities"]["experimental"]["migrationHistoryConcurrency64V1"],
        true
    );
    let page = rpc(
        &mut server,
        2,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let catalog = page["catalogId"].clone();
    let mut items = page["items"].as_array().unwrap().clone();
    let mut cursor = page["nextCursor"].clone();
    while !cursor.is_null() {
        let page = rpc(
            &mut server,
            3,
            "migration/history/sources",
            json!({"catalogId":catalog,"cursor":cursor}),
        );
        items.extend(page["items"].as_array().unwrap().iter().cloned());
        cursor = page["nextCursor"].clone();
    }
    assert_eq!(items.len(), count);
    let mut jobs = Vec::new();
    for item in &items {
        let id = uuid::Uuid::new_v4().to_string();
        let created = rpc(
            &mut server,
            4,
            "migration/history/create",
            json!({"catalogId":catalog,"sourceHandle":item["sourceHandle"],"requestId":id}),
        );
        assert_eq!(created["job"]["jobId"], id);
        jobs.push(created);
    }
    server.send_batch(
        jobs[..HISTORY_IMPORT_CONCURRENCY]
            .iter()
            .enumerate()
            .map(|(index, job)| {
                json!({"jsonrpc":"2.0","id":1000+index as i64,"method":"migration/history/run",
            "params":{"jobId":job["job"]["jobId"],"expectedSequence":job["job"]["sequence"]}})
            }),
    );
    let accepted = responses(&server, 1000..1000 + HISTORY_IMPORT_CONCURRENCY as i64);
    for value in accepted.values() {
        assert!(value.get("error").is_none(), "admission failed: {value}");
        assert_eq!(value["result"]["workerRunning"], true);
    }
    let store = HistoryJobStore::open(&f.profile).unwrap();
    let running = jobs[..HISTORY_IMPORT_CONCURRENCY]
        .iter()
        .filter(|job| {
            observed_execution_state(&store, job["job"]["jobId"].as_str().unwrap())
                == HistoryExecutionState::Running
        })
        .count();
    assert_eq!(
        running, HISTORY_IMPORT_CONCURRENCY,
        "fixture must observe all real execution leases"
    );
    assert_eq!(
        observed_execution_state(
            &store,
            jobs[HISTORY_IMPORT_CONCURRENCY]["job"]["jobId"]
                .as_str()
                .unwrap(),
        ),
        HistoryExecutionState::Stopped
    );
    // Capacity rejection proves this original request has not started; it is safe to queue it locally.
    let last = &jobs[HISTORY_IMPORT_CONCURRENCY];
    server.send(
        json!({"jsonrpc":"2.0","id":2000,"method":"migration/history/run",
        "params":{"jobId":last["job"]["jobId"],"expectedSequence":last["job"]["sequence"]}}),
    );
    let rejected = server.response(2000);
    assert!(
        rejected["error"]
            .to_string()
            .contains("history_job_worker_capacity_reached"),
        "{rejected}"
    );
    assert_eq!(
        observed_execution_state(&store, last["job"]["jobId"].as_str().unwrap()),
        HistoryExecutionState::Stopped
    );
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut queued = true;
    let mut completed = BTreeMap::new();
    let started = Instant::now();
    let mut sampled = started;
    let mut states = BTreeMap::<String, Value>::new();
    while completed.len() < count {
        let live = if queued {
            HISTORY_IMPORT_CONCURRENCY
        } else {
            count
        };
        for job in jobs.iter().take(live) {
            let id = job["job"]["jobId"].as_str().unwrap();
            if completed.contains_key(id) {
                continue;
            }
            let value = rpc(
                &mut server,
                2100,
                "migration/history/read",
                json!({"jobId":id}),
            );
            states.insert(
                id.to_owned(),
                json!({"stage":value["job"]["stage"],
                "records":value["job"]["normalization"]["normalizedRecords"],
                "progress":value["progress"],"sequence":value["job"]["sequence"]}),
            );
            if sampled.elapsed() >= Duration::from_secs(5) || Instant::now() >= deadline {
                let mut stages = BTreeMap::<String, usize>::new();
                let records: Vec<_> = states
                    .values()
                    .filter_map(|value| value["records"].as_u64())
                    .collect();
                for value in states.values() {
                    *stages
                        .entry(value["stage"].as_str().unwrap_or("unknown").to_owned())
                        .or_default() += 1;
                }
                eprintln!(
                    "owned public history sample {}",
                    json!({"elapsedMs":started.elapsed().as_millis(),
                    "completed":completed.len(),"stages":stages,"recordsMin":records.iter().min(),
                    "recordsMax":records.iter().max(),"recordsSum":records.iter().sum::<u64>(),
                    "progressExamples":states.values().take(2).collect::<Vec<_>>(),"process":process_sample(&server)})
                );
                sampled = Instant::now();
            }

            assert!(value["workerError"].is_null(), "{value}");
            assert!(
                !matches!(value["job"]["stage"].as_str(), Some("failed" | "cancelled")),
                "{value}"
            );
            if value["workerState"] == "stopped" {
                assert_eq!(value["job"]["stage"], "normalized", "{value}");
                assert_eq!(value["job"]["normalization"]["normalizedRecords"], 128);
                assert!(value["job"]["archiveId"].as_str().is_some());
                completed.insert(id.to_owned(), value["job"].clone());
            }
        }
        if queued && !completed.is_empty() {
            let value = rpc(
                &mut server,
                2200,
                "migration/history/run",
                json!({"jobId":last["job"]["jobId"],"expectedSequence":last["job"]["sequence"]}),
            );
            assert!(value.get("job").is_some());
            queued = false;
        }
        assert!(
            Instant::now() < deadline,
            "owned histories did not settle: {}/{}",
            completed.len(),
            count
        );
        std::thread::yield_now();
    }
    for (item, initial) in items.iter().zip(&jobs) {
        let id = initial["job"]["jobId"].as_str().unwrap();
        let duplicate = rpc(
            &mut server,
            2300,
            "migration/history/create",
            json!({"catalogId":catalog,"sourceHandle":item["sourceHandle"],"requestId":id}),
        );
        assert_eq!(duplicate["job"], completed[id]);
        let duplicate_run = rpc(
            &mut server,
            2301,
            "migration/history/run",
            json!({"jobId":id,"expectedSequence":initial["job"]["sequence"]}),
        );
        assert_eq!(duplicate_run["job"], completed[id]);
        assert_eq!(duplicate_run["workerRunning"], false);
    }
    eprintln!(
        "owned public history peak={running}, completed={}, queued=1, model_calls=0",
        completed.len()
    );
    server.shutdown();
}
