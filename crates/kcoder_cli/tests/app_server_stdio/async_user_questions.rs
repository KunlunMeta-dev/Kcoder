fn async_question_rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    server.response(id)
}

fn async_question_initialize(server: &mut TestAppServer, offered: bool) -> Value {
    async_question_rpc(
        server,
        1,
        "initialize",
        json!({
            "protocolVersion": kcoder_app_protocol::PROTOCOL_VERSION,
            "clientInfo": {"name":"async-question-stdio","version":"1"},
            "capabilities": {"experimental": {"asyncUserQuestionsV1": offered}}
        }),
    )
}

fn async_question_wait_completed(
    server: &TestAppServer,
    turn_id: &str,
    expected_status: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == turn_id {
            assert_eq!(
                event["params"]["turn"]["status"], expected_status,
                "{event}"
            );
            return event;
        }
    }
}

fn async_question_started_count(server: &TestAppServer) -> usize {
    server
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter(|line| line.contains("\"method\":\"turn/started\""))
        .count()
}

fn async_question_response_count(server: &TestAppServer, id: i64) -> usize {
    server
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value["id"] == json!(id))
        .count()
}

fn async_question_answer_params(thread_id: &str, question: &Value, submission_id: &str) -> Value {
    let item = &question["questions"][0];
    let item_id = item["id"].as_str().expect("question item id");
    let option_id = item["options"][0]["id"]
        .as_str()
        .expect("question option id");
    let answers = serde_json::Map::from_iter([(
        item_id.to_owned(),
        json!({"selectedOptionIds": [option_id]}),
    )]);
    json!({
        "threadId": thread_id,
        "questionId": question["questionId"],
        "submissionId": submission_id,
        "expectedRevision": question["revision"],
        "answers": answers
    })
}

fn async_question_saved_record(root: &std::path::Path, question_id: &str) -> Value {
    let path = find_named_file(root, "async-user-questions.json")
        .expect("durable async-question ledger exists");
    let ledger: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    ledger["records"]
        .as_array()
        .expect("ledger records")
        .iter()
        .find(|stored| stored["record"]["questionId"] == question_id)
        .expect("question in durable ledger")
        .clone()
}

fn async_question_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn async_question_stable_uuid(domain: &str, parts: &[&str]) -> String {
    let encoded = serde_json::to_vec(&(domain, parts)).unwrap();
    let digest = Sha256::digest(encoded);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Prepare the durable snapshot left after answer persistence but before a
/// delivery claim. The app-server process is stopped while this test-owned
/// fixture updates its private session ledger.
fn async_question_seed_unclaimed_answer(
    root: &std::path::Path,
    question_id: &str,
    submission_id: &str,
) -> (Value, String) {
    let path = find_named_file(root, "async-user-questions.json")
        .expect("durable async-question ledger exists");
    let mut ledger: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let stored = ledger["records"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|stored| stored["record"]["questionId"] == question_id)
        .expect("question in durable ledger");
    let (queued_question, message_id, answer_digest) = {
        let record = &mut stored["record"];
        let item = &record["questions"][0];
        let item_id = item["id"].as_str().unwrap().to_owned();
        let option_id = item["options"][0]["id"].as_str().unwrap().to_owned();
        let answers = Value::Object(serde_json::Map::from_iter([(
            item_id,
            json!({"selectedOptionIds": [option_id]}),
        )]));
        let answer_digest = async_question_digest(&serde_json::to_vec(&answers).unwrap());
        let thread_id = record["threadId"].as_str().unwrap().to_owned();
        let message_id = async_question_stable_uuid(
            "async-question-answer-message-v1",
            &[&thread_id, question_id, submission_id],
        );

        let revision = record["revision"].as_u64().unwrap() + 1;
        record["revision"] = json!(revision);
        record["status"] = json!("queued");
        record["answer"] = json!({
            "submissionId": submission_id,
            "answers": answers,
            "acceptedAtMs": 1
        });
        (record.clone(), message_id, answer_digest)
    };
    stored["outbox"] = json!({
        "submissionId": submission_id,
        "answerDigest": answer_digest,
        "messageId": message_id,
        "state": {"state": "ready"}
    });
    std::fs::write(path, serde_json::to_vec(&ledger).unwrap()).unwrap();

    (queued_question, message_id)
}

#[test]
fn async_question_exact_replay_claims_saved_unclaimed_answer_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| match index {
            0 => FixtureAnswer::Tool {
                id: "fixture-async-question-recovery".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Which export format should the report use?",
                    "header":"Export format",
                    "options":[
                        {"label":"CSV","description":"Keeps the export easy to inspect."},
                        {"label":"JSON","description":"Preserves nested fields."}
                    ],
                    "multi_select":false
                }]}),
            },
            _ => FixtureAnswer::Text("I continued the report work independently.".into()),
        },
        Some(3),
        // Keep the loopback provider open while the server persists and resumes turns.
        Duration::from_secs(30),
    );
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = async_question_initialize(&mut server, true);
    assert!(initialized.get("error").is_none(), "{initialized}");
    let created = async_question_rpc(&mut server, 2, "thread/start", json!({}));
    assert!(created.get("error").is_none(), "{created}");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = async_question_rpc(
        &mut server,
        3,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Prepare the report and ask me which export format to use."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(started.get("error").is_none(), "{started}");
    let source_turn_id = started["result"]["turn"]["id"].as_str().unwrap().to_owned();
    async_question_wait_completed(&server, &source_turn_id, "completed");
    assert_eq!(fixture_call_count(&calls), 2);

    let listed = async_question_rpc(
        &mut server,
        4,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"][0].clone();
    assert_eq!(question["status"], "pending", "{listed}");
    server.shutdown_successfully();

    // Model the valid durable state after answer_async_question committed its
    // answer/outbox but before the server could persist a delivery claim.
    let (queued_question, stable_message_id) = async_question_seed_unclaimed_answer(
        temp.path(),
        question["questionId"].as_str().unwrap(),
        "recovered-submission-1",
    );
    assert_eq!(queued_question["status"], "queued");
    assert_eq!(
        queued_question["answer"]["submissionId"],
        "recovered-submission-1"
    );

    let mut restored = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let restored_init = async_question_initialize(&mut restored, true);
    assert!(restored_init.get("error").is_none(), "{restored_init}");
    let resumed = async_question_rpc(
        &mut restored,
        2,
        "thread/resume",
        json!({"threadId":thread_id}),
    );
    assert!(resumed.get("error").is_none(), "{resumed}");
    let restored_list = async_question_rpc(
        &mut restored,
        3,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(restored_list.get("error").is_none(), "{restored_list}");
    let question = restored_list["result"]["questions"][0].clone();
    assert_eq!(question["status"], "queued", "{restored_list}");

    let replay = async_question_rpc(
        &mut restored,
        5,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &question, "recovered-submission-1"),
    );
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(replay["result"]["accepted"], true, "{replay}");
    assert_eq!(replay["result"]["duplicate"], true, "{replay}");
    let resumed_turn_id = replay["result"]["startedTurn"]["id"]
        .as_str()
        .unwrap_or_else(|| {
            panic!("freshly claimed unclaimed replay must start a delivery turn: {replay}")
        })
        .to_owned();
    assert_eq!(replay["result"]["startedTurn"]["threadId"], thread_id);
    async_question_wait_completed(&restored, &resumed_turn_id, "completed");
    assert_eq!(async_question_response_count(&restored, 5), 1);
    assert_eq!(fixture_call_count(&calls), 3);

    let applied = async_question_rpc(
        &mut restored,
        6,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(applied.get("error").is_none(), "{applied}");
    assert_eq!(
        applied["result"]["questions"][0]["status"],
        "context_applied"
    );
    let history = async_question_rpc(
        &mut restored,
        7,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(history.get("error").is_none(), "{history}");
    let answer_messages = history["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user" && message.to_string().contains("CSV"))
        .collect::<Vec<_>>();
    assert_eq!(answer_messages.len(), 1, "{history}");
    assert_eq!(answer_messages[0]["id"], stable_message_id);
    restored.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn async_question_is_durable_answered_once_and_replay_safe_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| match index {
            0 => FixtureAnswer::Tool {
                id: "fixture-async-question-1".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Which export format should the report use?",
                    "header":"Export format",
                    "options":[
                        {"label":"CSV","description":"Keeps the export easy to inspect and process."},
                        {"label":"JSON","description":"Preserves nested fields in the export."}
                    ],
                    "multi_select":false
                }]}),
            },
            1 => FixtureAnswer::Text(
                "I registered the question and continued independent cleanup work.".into(),
            ),
            2 => FixtureAnswer::Text("I applied the selected export format.".into()),
            3 => FixtureAnswer::Tool {
                id: "fixture-async-question-cancel".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Should the report include raw rows?",
                    "header":"Raw rows",
                    "options":[
                        {"label":"Include","description":"Adds the source rows to the report."},
                        {"label":"Summary only","description":"Keeps the report compact."}
                    ],
                    "multi_select":false
                }]}),
            },
            _ => FixtureAnswer::Text("I completed independent report cleanup.".into()),
        },
        Some(5),
        // Keep the loopback provider open while the server persists and resumes turns.
        Duration::from_secs(30),
    );
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();

    let initialized = async_question_initialize(&mut server, true);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["asyncUserQuestionsV1"], true,
        "{initialized}"
    );
    let created = async_question_rpc(&mut server, 2, "thread/start", json!({}));
    assert!(created.get("error").is_none(), "{created}");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();

    let started = async_question_rpc(
        &mut server,
        3,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Prepare the report and ask me which export format to use. Continue cleanup steps that do not depend on my answer."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(started.get("error").is_none(), "{started}");
    let original_turn_id = started["result"]["turn"]["id"]
        .as_str()
        .expect("original turn id")
        .to_owned();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut changed_seen = false;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "asyncQuestion/changed"
            && event["params"]["threadId"] == thread_id
            && event["params"]["question"]["status"] == "pending"
        {
            changed_seen = true;
        }
        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == original_turn_id
        {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert!(
        changed_seen,
        "registration must publish asyncQuestion/changed"
    );
    assert_eq!(
        fixture_call_count(&calls),
        2,
        "the original turn must continue after registration"
    );
    let model_requests = calls.lock().unwrap().clone();
    assert!(
        model_requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| { tool["function"]["name"] == "AskUserQuestionAsync" })
    );
    let accepted_tool_receipt = model_requests[1]["messages"]
        .as_array()
        .expect("second provider request messages")
        .iter()
        .filter(|message| message["role"] == "tool")
        .filter_map(|message| message["content"].as_str())
        .filter_map(|content| serde_json::from_str::<Value>(content).ok())
        .any(|receipt| receipt["accepted"] == true);
    assert!(
        accepted_tool_receipt,
        "the next model request must receive the durable accepted receipt before independent work: {}",
        model_requests[1]
    );

    let listed = async_question_rpc(
        &mut server,
        4,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"][0].clone();
    assert_eq!(question["status"], "pending", "{listed}");
    assert_eq!(question["sourceTurnId"], original_turn_id);

    let answer_params = async_question_answer_params(&thread_id, &question, "answer-replay-1");
    let answer = async_question_rpc(
        &mut server,
        5,
        "asyncQuestion/answer",
        answer_params.clone(),
    );
    assert!(answer.get("error").is_none(), "{answer}");
    assert_eq!(answer["result"]["accepted"], true, "{answer}");
    assert_eq!(answer["result"]["duplicate"], false, "{answer}");
    assert_eq!(answer["result"]["threadId"], thread_id);
    let answer_turn_id = answer["result"]["startedTurn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("idle answer should start a turn: {answer}"))
        .to_owned();
    assert_eq!(answer["result"]["startedTurn"]["threadId"], thread_id);
    async_question_wait_completed(&server, &answer_turn_id, "completed");
    assert_eq!(
        async_question_response_count(&server, 5),
        1,
        "the answer RPC must emit exactly one result even though it internally admits a turn"
    );

    let applied_question = async_question_rpc(
        &mut server,
        12,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(
        applied_question.get("error").is_none(),
        "{applied_question}"
    );
    let applied_question = applied_question["result"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["questionId"] == question["questionId"])
        .expect("answered question remains listed")
        .clone();
    assert_eq!(
        applied_question["status"], "context_applied",
        "{applied_question}"
    );
    let durable_record =
        async_question_saved_record(temp.path(), question["questionId"].as_str().unwrap());
    assert_eq!(
        durable_record["outbox"]["state"]["state"], "applied",
        "{durable_record}"
    );
    let stable_answer_message_id = durable_record["outbox"]["messageId"]
        .as_str()
        .expect("stable history UUID is retained in the outbox")
        .to_owned();

    let replay = async_question_rpc(&mut server, 6, "asyncQuestion/answer", answer_params);
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(replay["result"]["accepted"], true, "{replay}");
    assert_eq!(replay["result"]["duplicate"], true, "{replay}");
    assert_eq!(
        fixture_call_count(&calls),
        3,
        "replaying a receipt must not start another model turn"
    );
    assert_eq!(
        async_question_started_count(&server),
        2,
        "only the original and answer turns should start"
    );

    let history = async_question_rpc(
        &mut server,
        7,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(history.get("error").is_none(), "{history}");
    let messages = history["result"]["messages"]
        .as_array()
        .expect("thread history");
    let answer_messages = messages
        .iter()
        .filter(|message| message["role"] == "user" && message.to_string().contains("CSV"))
        .count();
    assert_eq!(
        answer_messages, 1,
        "the answer must be appended once to original history: {history}"
    );
    let answer_history_message = messages
        .iter()
        .find(|message| message["role"] == "user" && message.to_string().contains("CSV"))
        .expect("answer is visible in transcript");
    assert_eq!(
        answer_history_message["id"], stable_answer_message_id,
        "the committed history UUID must be the stable outbox message id"
    );
    assert!(
        history
            .to_string()
            .contains("continued independent cleanup work")
    );
    assert!(history.to_string().contains("selected export format"));

    let second_turn = async_question_rpc(
        &mut server,
        8,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Start the next report step and ask whether to include raw rows."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(second_turn.get("error").is_none(), "{second_turn}");
    let second_turn_id = second_turn["result"]["turn"]["id"]
        .as_str()
        .expect("second source turn id")
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut second_changed_seen = false;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "asyncQuestion/changed"
            && event["params"]["threadId"] == thread_id
            && event["params"]["question"]["status"] == "pending"
        {
            second_changed_seen = true;
        }
        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == second_turn_id {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert!(
        second_changed_seen,
        "second question registration must publish a change"
    );
    let with_second_question = async_question_rpc(
        &mut server,
        9,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(
        with_second_question.get("error").is_none(),
        "{with_second_question}"
    );
    let pending_question = with_second_question["result"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|question| question["status"] == "pending")
        .expect("second pending question")
        .clone();
    let cancelled = async_question_rpc(
        &mut server,
        10,
        "asyncQuestion/cancel",
        json!({
            "threadId":thread_id,
            "questionId":pending_question["questionId"],
            "expectedRevision":pending_question["revision"]
        }),
    );
    assert!(cancelled.get("error").is_none(), "{cancelled}");
    assert_eq!(
        cancelled["result"]["question"]["status"], "cancelled",
        "{cancelled}"
    );
    let late_cancelled_answer = async_question_rpc(
        &mut server,
        11,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &pending_question, "cancelled-answer-1"),
    );
    assert!(
        late_cancelled_answer.get("error").is_some(),
        "cancelled questions must reject late answers: {late_cancelled_answer}"
    );
    assert_eq!(
        fixture_call_count(&calls),
        5,
        "cancel and late-answer rejection must not start model calls"
    );
    assert_eq!(async_question_started_count(&server), 3);
    server.shutdown_successfully();
    fixture.join().unwrap();

    let mut restored = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let restored_init = async_question_initialize(&mut restored, true);
    assert!(restored_init.get("error").is_none(), "{restored_init}");
    let resumed = async_question_rpc(
        &mut restored,
        2,
        "thread/resume",
        json!({"threadId":thread_id}),
    );
    assert!(resumed.get("error").is_none(), "{resumed}");
    let after_restart = async_question_rpc(
        &mut restored,
        3,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(after_restart.get("error").is_none(), "{after_restart}");
    let restored_questions = after_restart["result"]["questions"].as_array().unwrap();
    assert_eq!(restored_questions.len(), 2);
    assert_eq!(
        restored_questions
            .iter()
            .find(|question| question["answer"]["submissionId"] == "answer-replay-1")
            .expect("answered question survives restart")["answer"]["submissionId"],
        "answer-replay-1",
        "the saved answer must survive process restart: {after_restart}"
    );
    let restored_answer_question = restored_questions
        .iter()
        .find(|question| question["answer"]["submissionId"] == "answer-replay-1")
        .expect("answered question survives restart")
        .clone();
    let replay_after_restart = async_question_rpc(
        &mut restored,
        5,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &restored_answer_question, "answer-replay-1"),
    );
    assert!(
        replay_after_restart.get("error").is_none(),
        "{replay_after_restart}"
    );
    assert_eq!(replay_after_restart["result"]["accepted"], true);
    assert_eq!(replay_after_restart["result"]["duplicate"], true);
    assert!(replay_after_restart["result"]["startedTurn"].is_null());
    assert_eq!(async_question_started_count(&restored), 0);
    assert_eq!(async_question_response_count(&restored, 5), 1);
    assert!(
        restored_questions
            .iter()
            .any(|question| question["status"] == "cancelled")
    );
    let restored_history = async_question_rpc(
        &mut restored,
        4,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(
        restored_history.get("error").is_none(),
        "{restored_history}"
    );
    let restored_answer_messages = restored_history["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user" && message.to_string().contains("CSV"))
        .count();
    assert_eq!(restored_answer_messages, 1, "{restored_history}");
    let restored_answer_message = restored_history["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user" && message.to_string().contains("CSV"))
        .expect("answer transcript entry survives restart");
    assert_eq!(restored_answer_message["id"], stable_answer_message_id);
    let restored_record =
        async_question_saved_record(temp.path(), question["questionId"].as_str().unwrap());
    assert_eq!(
        restored_record["outbox"]["messageId"],
        stable_answer_message_id
    );
    restored.shutdown_successfully();
}

fn async_question_hold_stream_until_interrupted(socket: &mut std::net::TcpStream) {
    let event = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"waiting for provider completion"},"finish_reason":null}]})
    );
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{event}\r\n",
        event.len()
    )
    .unwrap();
    socket.flush().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let mut byte = [0];
        match socket.read(&mut byte) {
            Ok(0) => return,
            Ok(_) => return,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

fn async_question_finish_stream_after_delay(socket: &mut std::net::TcpStream) {
    let delta = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"I continued independent report work."},"finish_reason":null}]})
    );
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{delta}\r\n",
        delta.len()
    )
    .unwrap();
    socket.flush().unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    let finished = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
    );
    write!(socket, "{:x}\r\n{finished}\r\n0\r\n\r\n", finished.len()).unwrap();
    socket.flush().unwrap();
}

#[test]
fn async_question_answer_during_source_turn_steers_that_turn_once() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| match index {
            0 => FixtureAnswer::Tool {
                id: "fixture-async-question-active".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Should the report include raw rows?",
                    "header":"Raw rows",
                    "options":[
                        {"label":"Include","description":"Adds the source rows to the report."},
                        {"label":"Summary only","description":"Keeps the report compact."}
                    ],
                    "multi_select":false
                }]}),
            },
            1 => FixtureAnswer::Custom(async_question_finish_stream_after_delay),
            _ => FixtureAnswer::Text("I incorporated the selected option into the report.".into()),
        },
        Some(3),
        Duration::from_secs(10),
    );
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = async_question_initialize(&mut server, true);
    assert!(initialized.get("error").is_none(), "{initialized}");
    let created = async_question_rpc(&mut server, 2, "thread/start", json!({}));
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();
    let started = async_question_rpc(
        &mut server,
        3,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Draft the report, ask whether to include raw rows, and continue independent work."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(started.get("error").is_none(), "{started}");
    let source_turn_id = started["result"]["turn"]["id"]
        .as_str()
        .expect("source turn id")
        .to_owned();

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut changed_seen = false;
    while !changed_seen || fixture_call_count(&calls) < 2 {
        let event = server.next_value(deadline);
        if event["method"] == "asyncQuestion/changed"
            && event["params"]["threadId"] == thread_id
            && event["params"]["question"]["status"] == "pending"
        {
            changed_seen = true;
        }
    }
    let listed = async_question_rpc(
        &mut server,
        4,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"][0].clone();
    assert_eq!(question["status"], "pending", "{listed}");
    assert_eq!(question["sourceTurnId"], source_turn_id);

    let answer = async_question_rpc(
        &mut server,
        5,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &question, "active-answer-1"),
    );
    assert!(answer.get("error").is_none(), "{answer}");
    assert_eq!(answer["result"]["accepted"], true, "{answer}");
    assert_eq!(answer["result"]["duplicate"], false, "{answer}");
    assert!(
        answer["result"]["startedTurn"].is_null(),
        "an active-source answer must steer the existing turn rather than start another: {answer}"
    );
    async_question_wait_completed(&server, &source_turn_id, "completed");
    assert_eq!(
        async_question_response_count(&server, 5),
        1,
        "the active answer RPC must emit exactly one result"
    );
    assert_eq!(fixture_call_count(&calls), 3);
    assert_eq!(async_question_started_count(&server), 1);
    let model_requests = calls.lock().unwrap().clone();
    assert!(
        model_requests[2]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user"
                && message.to_string().contains("Answer: Include")),
        "the current turn's next model request must include the saved answer: {}",
        model_requests[2]
    );

    let listed = async_question_rpc(
        &mut server,
        6,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["questionId"] == question["questionId"])
        .expect("answered question remains listed");
    assert_eq!(question["status"], "context_applied", "{listed}");
    let saved = async_question_saved_record(temp.path(), question["questionId"].as_str().unwrap());
    let stable_message_id = saved["outbox"]["messageId"].clone();
    assert_eq!(saved["outbox"]["state"]["state"], "applied", "{saved}");

    let history = async_question_rpc(
        &mut server,
        7,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(history.get("error").is_none(), "{history}");
    let answer_messages = history["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| {
            message["role"] == "user" && message.to_string().contains("Answer: Include")
        })
        .collect::<Vec<_>>();
    assert_eq!(answer_messages.len(), 1, "{history}");
    assert_eq!(answer_messages[0]["id"], stable_message_id, "{history}");
    assert!(
        history
            .to_string()
            .contains("incorporated the selected option")
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn interrupting_a_later_turn_stales_questions_from_a_completed_turn() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| match index {
            0 => FixtureAnswer::Tool {
                id: "fixture-async-question-completed-source".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Should the report include raw rows?",
                    "header":"Raw rows",
                    "options":[
                        {"label":"Include","description":"Adds the source rows."},
                        {"label":"Summary only","description":"Keeps the report compact."}
                    ],
                    "multi_select":false
                }]}),
            },
            1 => FixtureAnswer::Text(
                "I finished independent report cleanup while the question remains open.".into(),
            ),
            _ => FixtureAnswer::Custom(async_question_hold_stream_until_interrupted),
        },
        Some(3),
        Duration::from_secs(8),
    );
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = async_question_initialize(&mut server, true);
    assert!(initialized.get("error").is_none(), "{initialized}");
    let created = async_question_rpc(&mut server, 2, "thread/start", json!({}));
    assert!(created.get("error").is_none(), "{created}");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let source = async_question_rpc(
        &mut server,
        3,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Prepare the report and ask whether raw rows should be included."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(source.get("error").is_none(), "{source}");
    let source_turn_id = source["result"]["turn"]["id"]
        .as_str()
        .expect("source turn id")
        .to_owned();
    async_question_wait_completed(&server, &source_turn_id, "completed");
    assert_eq!(fixture_call_count(&calls), 2);

    let listed = async_question_rpc(
        &mut server,
        4,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"][0].clone();
    assert_eq!(question["status"], "pending", "{listed}");
    assert_eq!(question["sourceTurnId"], source_turn_id);

    let later = async_question_rpc(
        &mut server,
        5,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Start another report turn before the outstanding answer arrives."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(later.get("error").is_none(), "{later}");
    let later_turn_id = later["result"]["turn"]["id"]
        .as_str()
        .expect("later active turn id")
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(15);
    while fixture_call_count(&calls) < 3 {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == later_turn_id {
            panic!("later turn completed before its interrupt: {event}");
        }
    }
    assert!(
        server.observed.lock().unwrap().iter().any(|line| {
            serde_json::from_str::<Value>(line).is_ok_and(|event| {
                event["method"] == "turn/started" && event["params"]["turn"]["id"] == later_turn_id
            })
        }),
        "the later turn must be active before interruption"
    );

    let interrupted = async_question_rpc(
        &mut server,
        6,
        "turn/interrupt",
        json!({"threadId":thread_id,"turnId":later_turn_id}),
    );
    assert!(interrupted.get("error").is_none(), "{interrupted}");
    assert_eq!(interrupted["result"]["interrupted"], true, "{interrupted}");
    async_question_wait_completed(&server, &later_turn_id, "interrupted");

    let stale_list = async_question_rpc(
        &mut server,
        7,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(stale_list.get("error").is_none(), "{stale_list}");
    let stale_question = stale_list["result"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["questionId"] == question["questionId"])
        .expect("question from the completed source remains inspectable");
    assert_eq!(stale_question["status"], "stale", "{stale_list}");
    assert!(stale_question["answer"].is_null(), "{stale_list}");

    let late_answer = async_question_rpc(
        &mut server,
        8,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &question, "answer-after-later-interrupt"),
    );
    assert!(late_answer.get("error").is_some(), "{late_answer}");
    assert_eq!(late_answer["error"]["code"], -32064, "{late_answer}");
    assert_eq!(fixture_call_count(&calls), 3, "{late_answer}");
    assert_eq!(async_question_started_count(&server), 2);

    let history = async_question_rpc(
        &mut server,
        9,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(history.get("error").is_none(), "{history}");
    assert!(
        !history["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user"
                && message.to_string().contains("Answer: Include")),
        "a task-wide interruption must not deliver or record the stale answer: {history}"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn late_async_question_answer_after_turn_interrupt_does_not_resume_turn() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| match index {
            0 => FixtureAnswer::Tool {
                id: "fixture-async-question-stop".into(),
                name: "AskUserQuestionAsync".into(),
                input: json!({"questions":[{
                    "question":"Should the report include raw rows?",
                    "header":"Raw rows",
                    "options":[
                        {"label":"Include","description":"Adds the source rows to the report."},
                        {"label":"Summary only","description":"Keeps the report compact."}
                    ],
                    "multi_select":false
                }]}),
            },
            1 => FixtureAnswer::Custom(async_question_hold_stream_until_interrupted),
            _ => FixtureAnswer::Custom(async_question_hold_stream_until_interrupted),
        },
        Some(3),
        // Keep the loopback provider open while the server persists and resumes turns.
        Duration::from_secs(30),
    );
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = async_question_initialize(&mut server, true);
    assert!(initialized.get("error").is_none(), "{initialized}");
    let created = async_question_rpc(&mut server, 2, "thread/start", json!({}));
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();
    let started = async_question_rpc(
        &mut server,
        3,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Prepare the report; ask about raw rows while continuing safe independent work."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(started.get("error").is_none(), "{started}");
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .expect("turn id")
        .to_owned();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut changed_seen = false;
    while !changed_seen || fixture_call_count(&calls) < 2 {
        let event = server.next_value(deadline);
        if event["method"] == "asyncQuestion/changed"
            && event["params"]["threadId"] == thread_id
            && event["params"]["question"]["status"] == "pending"
        {
            changed_seen = true;
        }
    }
    let interrupted = async_question_rpc(
        &mut server,
        4,
        "turn/interrupt",
        json!({"threadId":thread_id,"turnId":turn_id}),
    );
    assert!(interrupted.get("error").is_none(), "{interrupted}");
    assert_eq!(interrupted["result"]["interrupted"], true, "{interrupted}");
    async_question_wait_completed(&server, &turn_id, "interrupted");

    let listed = async_question_rpc(
        &mut server,
        5,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    let question = listed["result"]["questions"][0].clone();
    assert_eq!(
        question["status"], "stale",
        "an interrupted source turn must stale its pending question: {listed}"
    );
    let before_started = async_question_started_count(&server);
    let new_turn = async_question_rpc(
        &mut server,
        6,
        "turn/start",
        json!({
            "threadId":thread_id,
            "input":[{"type":"text","text":"Continue safe report work in a new turn while the old answer remains outstanding."}],
            "asyncUserQuestions":true
        }),
    );
    assert!(new_turn.get("error").is_none(), "{new_turn}");
    let new_turn_id = new_turn["result"]["turn"]["id"]
        .as_str()
        .expect("new active turn id")
        .to_owned();
    let new_turn_deadline = Instant::now() + Duration::from_secs(15);
    while fixture_call_count(&calls) < 3 {
        let event = server.next_value(new_turn_deadline);
        if event["method"] == "turn/completed" && event["params"]["turn"]["id"] == new_turn_id {
            panic!("new turn completed before stale-answer check: {event}");
        }
    }
    assert!(
        server.observed.lock().unwrap().iter().any(|line| {
            serde_json::from_str::<Value>(line).is_ok_and(|event| {
                event["method"] == "turn/started" && event["params"]["turn"]["id"] == new_turn_id
            })
        }),
        "the new turn must be active before the stale answer is submitted"
    );
    let answer = async_question_rpc(
        &mut server,
        7,
        "asyncQuestion/answer",
        async_question_answer_params(&thread_id, &question, "late-answer-1"),
    );
    assert!(
        answer.get("error").is_some(),
        "a late answer for an interrupted source turn must be rejected as stale: {answer}"
    );
    assert_eq!(answer["error"]["code"], -32064, "{answer}");
    assert_eq!(
        fixture_call_count(&calls),
        3,
        "a stale answer must not inject a follow-up into the active turn"
    );
    assert_eq!(async_question_started_count(&server), before_started + 1);
    let after_late_answer = async_question_rpc(
        &mut server,
        10,
        "asyncQuestion/list",
        json!({"threadId":thread_id,"includeTerminal":true}),
    );
    assert!(
        after_late_answer.get("error").is_none(),
        "{after_late_answer}"
    );
    let still_stale = after_late_answer["result"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["questionId"] == question["questionId"])
        .expect("stale question remains inspectable");
    assert_eq!(still_stale["status"], "stale", "{after_late_answer}");
    assert!(still_stale["answer"].is_null(), "{after_late_answer}");
    let interrupted_new_turn = async_question_rpc(
        &mut server,
        11,
        "turn/interrupt",
        json!({"threadId":thread_id,"turnId":new_turn_id}),
    );
    assert!(
        interrupted_new_turn.get("error").is_none(),
        "{interrupted_new_turn}"
    );
    assert_eq!(interrupted_new_turn["result"]["interrupted"], true);
    async_question_wait_completed(&server, &new_turn_id, "interrupted");
    let history = async_question_rpc(
        &mut server,
        12,
        "thread/read",
        json!({"threadId":thread_id,"limit":50}),
    );
    assert!(history.get("error").is_none(), "{history}");
    assert!(
        !history["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user"
                && message.to_string().contains("Answer: Include")),
        "a stale answer must not enter history or steer the new turn: {history}"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn async_question_rpc_is_rejected_without_negotiated_capability() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = async_question_initialize(&mut server, false);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["asyncUserQuestionsV1"], false,
        "{initialized}"
    );
    let unsupported = async_question_rpc(
        &mut server,
        2,
        "asyncQuestion/list",
        json!({"threadId":"unknown-thread"}),
    );
    assert!(
        unsupported.get("error").is_some(),
        "an unnegotiated client must not access asynchronous questions: {unsupported}"
    );
    assert_eq!(unsupported["error"]["code"], -32601, "{unsupported}");
    assert!(
        unsupported["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("asyncUserQuestionsV1 negotiation is required"),
        "{unsupported}"
    );
    server.shutdown_successfully();
}
