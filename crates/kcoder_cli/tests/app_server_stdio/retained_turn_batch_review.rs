// Real private-parent app-server JSONL coverage for retained-turn batch proofs.
// The public capability remains disabled while this trusted stdio lane is tested.

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct RetainedTurnBatchReceipt {
    retention_id: String,
    expected_revision: u64,
    entry_id: String,
    filename: String,
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_request(
    id: i64,
    method: &str,
    context: &Value,
    target_id: &str,
    mut params: Value,
) -> Value {
    if method.starts_with("attachment/retention/") {
        params["trustedContext"] = context.clone();
    }
    workspace_receipts_v2_stdio_request(id, method, context, params, target_id, None)
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn retained_turn_batch_create_receipt(
    server: &mut RetentionAuthorityServer,
    initialized: &Value,
    context: &Value,
    target_id: &str,
    thread_id: &str,
    index: u64,
    upload_request_id: i64,
    reserve_request_id: i64,
    filename: &str,
    bytes: &[u8],
) -> RetainedTurnBatchReceipt {
    use sha2::{Digest, Sha256};

    let admission = &initialized["result"]["attachmentUploadAdmission"];
    let namespace = admission["rootNamespace"].as_str().unwrap();
    let epoch = admission["admissionEpoch"].as_u64().unwrap();
    let unique = format!("{index:032x}");

    let mut upload = retained_upload_stdio_params(initialized);
    upload["ownerRequest"]["clientOwnerRequestId"] =
        json!(format!("o1.{namespace}.{epoch}.{unique}"));
    upload["clientUploadId"] = json!(format!("u1.{namespace}.{epoch}.{unique}"));
    upload["filename"] = json!(filename);
    upload["size"] = json!(bytes.len());
    upload["contentSha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    upload["contentBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    server.send(retained_turn_batch_request(
        upload_request_id,
        "attachment/retention/upload/save",
        context,
        target_id,
        upload,
    ));
    let saved = server.response(upload_request_id);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["lookup"]["recovery"]["state"], "sealed");
    let stage = saved["result"]["lookup"]["recovery"]["stageRef"].clone();

    let request_id = format!("r1.{namespace}.{epoch}.{unique}");
    server.send(retained_turn_batch_request(
        reserve_request_id,
        kcoder_app_protocol::METHOD_ATTACHMENT_RETENTION_RESERVE,
        context,
        target_id,
        json!({
            "clientRequestId": request_id,
            "threadId": thread_id,
            "stageRefs": [stage.clone()],
        }),
    ));
    let reserved = server.response(reserve_request_id);
    assert!(reserved.get("error").is_none(), "{reserved}");
    let receipt = &reserved["result"]["result"]["receipt"];
    assert_eq!(receipt["state"], "ready", "{reserved}");
    RetainedTurnBatchReceipt {
        retention_id: receipt["retentionId"].as_str().unwrap().to_string(),
        expected_revision: receipt["revision"].as_u64().unwrap(),
        entry_id: stage["entryId"].as_str().unwrap().to_string(),
        filename: filename.into(),
    }
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_params(
    thread_id: &str,
    client_message_id: &str,
    prompt: &str,
    receipts: &[RetainedTurnBatchReceipt],
) -> Value {
    let references = receipts
        .iter()
        .map(|receipt| {
            json!({
                "retentionId": receipt.retention_id,
                "expectedRevision": receipt.expected_revision,
                "entryIds": [receipt.entry_id],
            })
        })
        .collect::<Vec<_>>();
    let attachments = receipts
        .iter()
        .map(|receipt| {
            json!({
                "entryId": receipt.entry_id,
                "filename": receipt.filename,
                "mimeType": "text/plain",
            })
        })
        .collect::<Vec<_>>();
    json!({
        "threadId": thread_id,
        "clientMessageId": client_message_id,
        "input": [{"type": "text", "text": prompt}],
        "retention": {"references": references, "attachments": attachments},
    })
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_start(
    server: &mut RetentionAuthorityServer,
    request_id: i64,
    context: &Value,
    target_id: &str,
    params: Value,
) -> Value {
    server.send(retained_turn_batch_request(
        request_id,
        "turn/start",
        context,
        target_id,
        params,
    ));
    server.response(request_id)
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_terminal_receipt(
    server: &mut RetentionAuthorityServer,
    thread_id: &str,
    client_message_id: &str,
    first_request_id: i64,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut request_id = first_request_id;
    loop {
        server.send(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "turn/receipt/read",
            "params": {"threadId": thread_id, "clientMessageId": client_message_id},
        }));
        let response = server.response(request_id);
        assert!(response.get("error").is_none(), "{response}");
        let receipt = &response["result"]["receipt"];
        if matches!(
            receipt["status"].as_str(),
            Some("completed" | "failed" | "interrupted")
        ) {
            return receipt.clone();
        }
        assert!(
            Instant::now() < deadline,
            "turn did not reach a terminal receipt"
        );
        request_id += 1;
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_read(
    server: &mut RetentionAuthorityServer,
    request_id: i64,
    context: &Value,
    target_id: &str,
    receipt: &RetainedTurnBatchReceipt,
) -> Value {
    server.send(retained_turn_batch_request(
        request_id,
        kcoder_app_protocol::METHOD_ATTACHMENT_RETENTION_READ,
        context,
        target_id,
        json!({
            "selector": {
                "by": "retentionId",
                "retentionId": receipt.retention_id,
            },
        }),
    ));
    let response = server.response(request_id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"]["result"]["receipt"].clone()
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_ack(
    receipt: &RetainedTurnBatchReceipt,
    terminal_revision: u64,
    client_ack_id: &str,
) -> Value {
    json!({
        "retentionId": receipt.retention_id,
        "terminalRevision": terminal_revision,
        "clientAckId": client_ack_id,
    })
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_consume(
    server: &mut RetentionAuthorityServer,
    request_id: i64,
    context: &Value,
    target_id: &str,
    acks: Vec<Value>,
) -> Value {
    server.send(retained_turn_batch_request(
        request_id,
        kcoder_app_protocol::METHOD_ATTACHMENT_RETENTION_CONSUME,
        context,
        target_id,
        json!({"acks": acks}),
    ));
    server.response(request_id)
}

#[cfg(target_os = "linux")]
fn retained_turn_batch_assert_state(
    server: &mut RetentionAuthorityServer,
    request_id: i64,
    context: &Value,
    target_id: &str,
    receipt: &RetainedTurnBatchReceipt,
    expected_state: &str,
) -> Value {
    let read = retained_turn_batch_read(server, request_id, context, target_id, receipt);
    assert_eq!(read["retentionId"], receipt.retention_id, "{read}");
    assert_eq!(read["state"], expected_state, "{read}");
    read
}

#[test]
#[cfg(target_os = "linux")]
fn retained_turn_stdio_batches_share_full_acceptance_and_validate_each_ack_scope_and_identity() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let (endpoint, calls, provider_fixture) = serving_fixture_scripted(Vec::new());
    write_fixture_provider_settings(&fixture.settings, &endpoint);
    let context = retention_authority_local_context();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["stagedAttachmentRetentionReceiptsV1"],
        false,
        "the public attachment retention capability remains closed"
    );

    // Retained reservations require a durable live source before the first
    // turn. Stable creation identity materializes that source before its ACK.
    server.send(json!({"jsonrpc":"2.0", "id":2, "method":"thread/start",
        "params":{"clientRequestId":"retained-turn-batch-thread-create"}}));
    let started = server.response(2);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let batch_a = vec![
        retained_turn_batch_create_receipt(
            &mut server,
            &initialized,
            &context,
            "target-a",
            &thread_id,
            1,
            10,
            11,
            "alpha.txt",
            b"first retained payload",
        ),
        retained_turn_batch_create_receipt(
            &mut server,
            &initialized,
            &context,
            "target-a",
            &thread_id,
            2,
            12,
            13,
            "beta.txt",
            b"second retained payload",
        ),
    ];
    let params_a = retained_turn_batch_params(
        &thread_id,
        "retained-client-a",
        "inspect the two retained notes",
        &batch_a,
    );
    let accepted_a =
        retained_turn_batch_start(&mut server, 20, &context, "target-a", params_a.clone());
    assert!(accepted_a.get("error").is_none(), "{accepted_a}");
    assert_eq!(accepted_a["result"]["turn"]["status"], "running");
    let terminal_a =
        retained_turn_batch_terminal_receipt(&mut server, &thread_id, "retained-client-a", 21);
    assert_eq!(terminal_a["status"], "completed", "{terminal_a}");
    let original_turn_id = terminal_a["turnId"].as_str().unwrap().to_string();
    let original_attempt_id = terminal_a["attemptId"].as_str().unwrap().to_string();
    assert_eq!(fixture_call_count(&calls), 1);

    // Retrying the same retained client message returns its durable original IDs.
    let replayed_a =
        retained_turn_batch_start(&mut server, 30, &context, "target-a", params_a.clone());
    assert!(replayed_a.get("error").is_none(), "{replayed_a}");
    assert_eq!(replayed_a["result"]["turn"]["id"], original_turn_id);
    assert_eq!(
        replayed_a["result"]["turn"]["attemptId"],
        original_attempt_id
    );
    assert_eq!(replayed_a["result"]["turn"]["status"], "completed");
    assert_eq!(
        fixture_call_count(&calls),
        1,
        "replay must not call Provider"
    );

    let batch_b = vec![
        retained_turn_batch_create_receipt(
            &mut server,
            &initialized,
            &context,
            "target-b",
            &thread_id,
            3,
            40,
            41,
            "gamma.txt",
            b"third retained payload",
        ),
        retained_turn_batch_create_receipt(
            &mut server,
            &initialized,
            &context,
            "target-b",
            &thread_id,
            4,
            42,
            43,
            "delta.txt",
            b"fourth retained payload",
        ),
    ];
    let params_b = retained_turn_batch_params(
        &thread_id,
        "retained-client-b",
        "inspect the other two retained notes",
        &batch_b,
    );
    let accepted_b = retained_turn_batch_start(&mut server, 50, &context, "target-b", params_b);
    assert!(accepted_b.get("error").is_none(), "{accepted_b}");
    let terminal_b =
        retained_turn_batch_terminal_receipt(&mut server, &thread_id, "retained-client-b", 51);
    assert_eq!(terminal_b["status"], "completed", "{terminal_b}");
    assert_eq!(fixture_call_count(&calls), 2);

    // A replay with the original client ID cannot borrow a receipt from another batch/scope.
    let mixed_batch = retained_turn_batch_params(
        &thread_id,
        "retained-client-a",
        "inspect the two retained notes",
        &[batch_a[0].clone(), batch_b[0].clone()],
    );
    let refused_replay =
        retained_turn_batch_start(&mut server, 60, &context, "target-a", mixed_batch);
    assert_eq!(
        refused_replay["error"]["code"],
        kcoder_app_protocol::RETENTION_ERROR_CONFLICT,
        "{refused_replay}"
    );
    assert_eq!(fixture_call_count(&calls), 2);
    let replay_receipt =
        retained_turn_batch_terminal_receipt(&mut server, &thread_id, "retained-client-a", 61);
    assert_eq!(replay_receipt["turnId"], original_turn_id);
    assert_eq!(replay_receipt["attemptId"], original_attempt_id);

    let transferred_a = batch_a
        .iter()
        .enumerate()
        .map(|(index, receipt)| {
            let read = retained_turn_batch_assert_state(
                &mut server,
                70 + index as i64,
                &context,
                "target-a",
                receipt,
                "transferred",
            );
            (receipt.clone(), read["revision"].as_u64().unwrap())
        })
        .collect::<Vec<_>>();
    let transferred_b = batch_b
        .iter()
        .enumerate()
        .map(|(index, receipt)| {
            let read = retained_turn_batch_assert_state(
                &mut server,
                72 + index as i64,
                &context,
                "target-b",
                receipt,
                "transferred",
            );
            (receipt.clone(), read["revision"].as_u64().unwrap())
        })
        .collect::<Vec<_>>();

    // A foreign-scope ACK is rejected during proof collection, before any valid ACK is applied.
    let mixed_scope = retained_turn_batch_consume(
        &mut server,
        80,
        &context,
        "target-a",
        vec![
            retained_turn_batch_ack(&transferred_a[0].0, transferred_a[0].1, "ack-scope-a"),
            retained_turn_batch_ack(&transferred_b[0].0, transferred_b[0].1, "ack-scope-b"),
        ],
    );
    assert_eq!(
        mixed_scope["error"]["code"],
        kcoder_app_protocol::RETENTION_ERROR_CONFLICT,
        "{mixed_scope}"
    );
    for (index, receipt) in batch_a.iter().enumerate() {
        retained_turn_batch_assert_state(
            &mut server,
            81 + index as i64,
            &context,
            "target-a",
            receipt,
            "transferred",
        );
    }
    for (index, receipt) in batch_b.iter().enumerate() {
        retained_turn_batch_assert_state(
            &mut server,
            83 + index as i64,
            &context,
            "target-b",
            receipt,
            "transferred",
        );
    }

    // A multi-ACK request returns one status per ACK; one invalid revision cannot
    // make the whole vector look successful or consume the unrelated receipt.
    let partial = retained_turn_batch_consume(
        &mut server,
        90,
        &context,
        "target-a",
        vec![
            retained_turn_batch_ack(&transferred_a[0].0, transferred_a[0].1, "ack-a1"),
            retained_turn_batch_ack(
                &transferred_a[1].0,
                transferred_a[1].1 + 1,
                "ack-a2-wrong-revision",
            ),
        ],
    );
    assert!(partial.get("error").is_none(), "{partial}");
    let results = partial["result"]["result"]["consumeResults"]
        .as_array()
        .unwrap();
    assert_eq!(results.len(), 2, "{partial}");
    let result_for = |ack_id: &str| {
        results
            .iter()
            .find(|result| result["clientAckId"] == ack_id)
            .unwrap_or_else(|| panic!("missing ACK result {ack_id}: {partial}"))
    };
    assert_eq!(
        result_for("ack-a1")["status"]["status"],
        "consumed",
        "{partial}"
    );
    assert_eq!(
        result_for("ack-a2-wrong-revision")["status"]["status"],
        "rejected",
        "{partial}"
    );
    assert_eq!(
        result_for("ack-a2-wrong-revision")["status"]["reason"],
        "ackConflict",
        "{partial}"
    );
    retained_turn_batch_assert_state(
        &mut server,
        91,
        &context,
        "target-a",
        &batch_a[0],
        "consumed",
    );
    retained_turn_batch_assert_state(
        &mut server,
        92,
        &context,
        "target-a",
        &batch_a[1],
        "transferred",
    );
    for (index, receipt) in batch_b.iter().enumerate() {
        retained_turn_batch_assert_state(
            &mut server,
            93 + index as i64,
            &context,
            "target-b",
            receipt,
            "transferred",
        );
    }

    let remaining_a = retained_turn_batch_consume(
        &mut server,
        100,
        &context,
        "target-a",
        vec![retained_turn_batch_ack(
            &transferred_a[1].0,
            transferred_a[1].1,
            "ack-a2-retry",
        )],
    );
    assert!(remaining_a.get("error").is_none(), "{remaining_a}");
    assert_eq!(
        remaining_a["result"]["result"]["consumeResults"][0]["status"]["status"], "consumed",
        "{remaining_a}"
    );
    assert_eq!(
        remaining_a["result"]["result"]["consumeResults"][0]["clientAckId"], "ack-a2-retry",
        "{remaining_a}"
    );
    for (index, receipt) in batch_a.iter().enumerate() {
        retained_turn_batch_assert_state(
            &mut server,
            101 + index as i64,
            &context,
            "target-a",
            receipt,
            "consumed",
        );
    }

    let valid_b = retained_turn_batch_consume(
        &mut server,
        110,
        &context,
        "target-b",
        transferred_b
            .iter()
            .enumerate()
            .map(|(index, (receipt, revision))| {
                retained_turn_batch_ack(receipt, *revision, &format!("ack-b{index}"))
            })
            .collect(),
    );
    assert!(valid_b.get("error").is_none(), "{valid_b}");
    let results = valid_b["result"]["result"]["consumeResults"]
        .as_array()
        .unwrap();
    assert_eq!(results.len(), 2, "{valid_b}");
    for ack_id in ["ack-b0", "ack-b1"] {
        let result = results
            .iter()
            .find(|result| result["clientAckId"] == ack_id)
            .unwrap_or_else(|| panic!("missing ACK result {ack_id}: {valid_b}"));
        assert_eq!(result["status"]["status"], "consumed", "{valid_b}");
    }
    for (index, receipt) in batch_b.iter().enumerate() {
        retained_turn_batch_assert_state(
            &mut server,
            111 + index as i64,
            &context,
            "target-b",
            receipt,
            "consumed",
        );
    }
    assert_eq!(
        fixture_call_count(&calls),
        2,
        "receipt reads/ACKs do not call Provider"
    );
    let provider_requests = calls.lock().unwrap();
    for (index, filenames) in [["alpha.txt", "beta.txt"], ["gamma.txt", "delta.txt"]]
        .into_iter()
        .enumerate()
    {
        let request = provider_requests[index].to_string();
        for filename in filenames {
            assert!(
                request.contains(filename),
                "request {index} omitted {filename}"
            );
        }
    }

    server.shutdown_successfully();
    provider_fixture.join().unwrap();
}
