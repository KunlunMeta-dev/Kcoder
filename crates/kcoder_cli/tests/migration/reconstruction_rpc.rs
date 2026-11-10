//! Model-independent reconstruction through the real app-server and isolated source profile.
use super::*;

#[test]
fn encrypted_codex_history_reconstructs_without_replaying_tools_or_claiming_exact_context() {
    let fixture = Fixture::new();
    fs::write(&fixture.overlay, json!({"api_format":"anthropic_messages","context_window_tokens":1000000,"context_output_headroom":10000,"max_tokens":2048}).to_string()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let folder = fixture.codex.join("sessions/2026/10/09");
    fs::create_dir_all(&folder).unwrap();
    let file = folder.join(format!("rollout-2026-10-09T20-00-00-{id}.jsonl"));
    let mut records = vec![
        json!({"type":"session_meta","payload":{"id":id,"session_id":id,"history_mode":"paginated"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please continue this task"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-call","name":"write","arguments":"NEVER_EXECUTE_RECONSTRUCTION"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":[{"type":"input_text","text":"evidence ".repeat(3000)},{"type":"input_image","image_url":"data:image/png;base64,AA=="}]}}),
        json!({"type":"compacted","payload":{"message":"","window_number":1,"replacement_history":[{"type":"compaction","encrypted_content":"OPAQUE-CANARY"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"We can proceed"}]}}),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let original = records
        .into_iter()
        .map(|record| record.to_string() + "\n")
        .collect::<String>();
    fs::write(&file, &original).unwrap();
    let mut server = fixture.start();
    let sources = rpc(
        &mut server,
        201,
        "migration/history/discover",
        json!({"source":"codex"}),
    );
    assert_eq!(sources["totalItems"], 1);
    let job = uuid::Uuid::new_v4().to_string();
    create(&mut server, &sources, &sources["items"][0], &job);
    rpc(
        &mut server,
        202,
        "migration/history/run",
        json!({"jobId":job,"expectedSequence":0}),
    );
    wait(&mut server, &job, |state| {
        state["job"]["stage"] == "normalized"
    });
    let normal = rpc(
        &mut server,
        203,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let normal_view = normal["progress"]["viewId"].clone();
    rpc(
        &mut server,
        204,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":normal_view}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = rpc(
            &mut server,
            205,
            "migration/history/branch/read",
            json!({"jobId":job,"viewId":normal_view}),
        );
        if state["progress"]["stage"] == "ready" && state["workerRunning"] == false {
            assert!(
                state["progress"]["issues"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "source_records_require_review")
            );
            break;
        }
        assert!(Instant::now() < deadline, "{state}");
        std::thread::sleep(Duration::from_millis(10));
    }
    let reconstructed = rpc(
        &mut server,
        206,
        "migration/history/branch/prepare",
        json!({"jobId":job,"reconstructReadable":true}),
    );
    let view = reconstructed["progress"]["viewId"].clone();
    assert_ne!(view, normal_view);
    rpc(
        &mut server,
        207,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = rpc(
            &mut server,
            208,
            "migration/history/branch/read",
            json!({"jobId":job,"viewId":view}),
        );
        if state["progress"]["stage"] == "ready" && state["workerRunning"] == false {
            assert!(
                state["progress"]["issues"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "codex_readable_reconstruction_requires_admission")
            );
            break;
        }
        assert!(Instant::now() < deadline, "{state}");
        std::thread::sleep(Duration::from_millis(10));
    }
    rpc(
        &mut server,
        209,
        "migration/history/branch/tools/run",
        json!({"jobId":job,"viewId":view}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = rpc(
            &mut server,
            210,
            "migration/history/branch/tools/read",
            json!({"jobId":job,"viewId":view}),
        );
        if state["state"]["run"]["stage"] == "ready" && state["state"]["workerRunning"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "{state}");
        std::thread::sleep(Duration::from_millis(10));
    }
    let key = uuid::Uuid::new_v4().to_string();
    branches::continuation::create_continuation(&mut server, &job, &view, &key);
    rpc(
        &mut server,
        211,
        "migration/history/continuation/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let ready = branches::continuation::wait_continuation(&mut server, &key);
    assert_eq!(ready["job"]["compilation"]["contextCompiled"], true);
    assert_eq!(ready["job"]["compilation"]["attachments"], 0);
    assert!(
        ready["job"]["compilation"]["encodedBytes"]
            .as_u64()
            .unwrap()
            < 15_000
    );
    let thread = ready["job"]["threadId"].as_str().unwrap();
    assert_eq!(
        rpc(
            &mut server,
            212,
            "migration/history/continuation/source",
            json!({"threadId":thread})
        )["source"]["viewId"],
        view
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), original);
    assert!(
        !fixture
            .workspace
            .join("NEVER_EXECUTE_RECONSTRUCTION")
            .exists()
    );
}
