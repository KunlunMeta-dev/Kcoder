// F07: a failed input that carried an attachment keeps its committed resource
// after a continuation and is never injected twice, while a handle that has
// already been consumed is reported explicitly instead of being silently
// dropped.

fn attachment_prompt(record: Value) -> String {
    // Extra context travels before the attachment envelope, which must stay last.
    format!(
        "attachment black box\nextra-context-sentinel\n<kcoder_attachments version=\"1\">\n{record}\n</kcoder_attachments>"
    )
}

/// Counts how often the extra context survives in a request body.
fn extra_context_count(request: &Value) -> usize {
    request
        .to_string()
        .matches("extra-context-sentinel")
        .count()
}

/// Counts how many times the request body injects an image part.
fn image_parts(request: &Value) -> usize {
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| message.get("content").and_then(Value::as_array))
                .flatten()
                .filter(|part| {
                    part.get("type").and_then(Value::as_str) == Some("image_url")
                        || part.get("image_url").is_some()
                })
                .count()
        })
        .unwrap_or_default()
}

fn user_parts(request: &Value) -> usize {
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message["role"] == "user")
                .count()
        })
        .unwrap_or_default()
}

#[test]
fn a_continuation_keeps_the_committed_attachment_exactly_once() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "attachment/save",
        "params": {"filename": "photo.png", "content_base64": "cG5nLWJ5dGVz"}
    }));
    let staged_path = server.response(3)["result"]["path"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = attachment_prompt(json!({
        "path": staged_path,
        "filename": "photo.png",
        "mimeType": "image/png"
    }));

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": prompt}]}
    }));
    let started = server.response(4);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    // The staged handle is consumed by materialization; the durable copy is what
    // the committed input keeps.
    assert!(!std::path::Path::new(&staged_path).exists());
    let durable = find_named_file(temp.path(), "00-photo.png")
        .expect("the failed turn must still own its materialized attachment");
    assert_eq!(std::fs::read(&durable).unwrap(), b"png-bytes");

    server.send(continuation_request(&thread_id, &failed_turn, 5));
    let accepted = server.response(5);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    // The committed user message keeps the same single copy of the context.
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let final_transcript = server.response(7);
    assert_eq!(
        final_transcript
            .to_string()
            .matches("extra-context-sentinel")
            .count(),
        1,
        "the extra context must stay committed exactly once: {final_transcript}"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();

    // Both the failed attempt and the continuation carry the image once, so the
    // resource is neither dropped nor injected twice.
    let recorded = calls.lock().unwrap().clone();
    assert_eq!(recorded.len(), 2, "{recorded:?}");
    for (index, request) in recorded.iter().enumerate() {
        assert_eq!(user_parts(request), 1, "request {index}: {request}");
        assert_eq!(image_parts(request), 1, "request {index}: {request}");
        // The extra context around the attachment is neither dropped nor
        // duplicated by the recovery.
        assert_eq!(
            extra_context_count(request),
            1,
            "request {index} must carry the extra context exactly once: {request}"
        );
    }
}

#[test]
fn an_expired_attachment_handle_is_reported_without_running_the_turn() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "attachment/save",
        "params": {"filename": "photo.png", "content_base64": "cG5nLWJ5dGVz"}
    }));
    let staged_path = server.response(3)["result"]["path"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = attachment_prompt(json!({
        "path": staged_path,
        "filename": "photo.png",
        "mimeType": "image/png"
    }));

    // The first turn consumes the staged handle, then fails at the provider.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": prompt.clone()}]}
    }));
    assert!(server.response(4).get("error").is_none());
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    let after_first_turn = fixture_call_count(&calls);
    assert_eq!(after_first_turn, 1);

    // Re-submitting the consumed handle must be reported, not silently ignored.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": prompt}]}
    }));
    let refused = server.response(5);
    let code = refused["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("a consumed attachment handle must be refused: {refused}"));
    assert_eq!(code, -32602, "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(!message.is_empty(), "{refused}");
    assert!(
        message.contains("photo.png") || message.to_ascii_lowercase().contains("attachment"),
        "the refusal must name the expired resource: {refused}"
    );
    // The refused turn neither reached the provider nor appended a user message.
    assert_eq!(fixture_call_count(&calls), after_first_turn);
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
}
