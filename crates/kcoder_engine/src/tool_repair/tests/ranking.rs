fn best_match<'a>(
    index: &'a ToolRepairIndex,
    tool_name: &str,
    schema_fingerprint: &str,
    current_input: &Value,
    error_summary: &str,
) -> Option<&'a ToolRepairExample> {
    index
        .best_matches(
            tool_name,
            schema_fingerprint,
            current_input,
            error_summary,
            1,
        )
        .into_iter()
        .next()
}

#[test]
fn unrelated_error_examples_are_not_returned_for_blank_todolist_string() {
    let schema = schema_fingerprint(&json!({"type": "object"}));
    let index = ToolRepairIndex {
            examples: vec![ToolRepairExample {
                version: STORE_VERSION,
                session_id: "session-1".to_string(),
                tool_name: "TodoWrite".to_string(),
                schema_fingerprint: schema.clone(),
                failure_signature:
                    "invalid input: unknown variant `done`, expected one of `pending`, `in_progress`, `completed`"
                        .to_string(),
                error_summary:
                    "invalid input: unknown variant `done`, expected one of `pending`, `in_progress`, `completed`"
                        .to_string(),
                failed_input: json!({
                    "TodoList": [{
                        "content": "Run tests",
                        "activeForm": "Running tests",
                        "status": "done"
                    }]
                }),
                successful_input: json!({
                    "TodoList": [{
                        "content": "Run tests",
                        "activeForm": "Running tests",
                        "status": "completed"
                    }]
                }),
                created_at_ms: 1,
            }],
        };

    let found = index.best_matches(
        "TodoWrite",
        &schema,
        &json!({"TodoList":[""]}),
        "$.TodoList[0]: expected object `{...}`, but got string",
        MODEL_REPAIR_HINT_LIMIT,
    );

    assert!(
        found.is_empty(),
        "wrong-status repair examples should not be shown for blank string TodoList items"
    );
}

#[test]
fn bm25_top1_selects_expected_repair_from_ten_simulated_examples() {
    let schema = simulated_schema_fingerprint();
    let examples = simulated_repair_examples(&schema)
        .into_iter()
        .take(10)
        .collect::<Vec<_>>();
    let index = ToolRepairIndex { examples };
    let cases = simulated_repair_queries()
        .into_iter()
        .take(10)
        .collect::<Vec<_>>();

    let mut hits = 0;
    for (expected, input, error) in &cases {
        let found = best_match(&index, "DemoTool", &schema, input, error)
            .expect("expected BM25 to return a repair example");
        if found.failure_signature == *expected {
            hits += 1;
        }
        assert_eq!(
            found.failure_signature, *expected,
            "wrong top-1 repair for query input {input} and error {error}"
        );
    }

    assert_eq!(hits, cases.len());
}

#[test]
fn bm25_top3_selects_expected_repair_from_thirty_simulated_examples() {
    let schema = simulated_schema_fingerprint();
    let examples = simulated_repair_examples(&schema);
    assert_eq!(examples.len(), 30);
    let index = ToolRepairIndex { examples };
    let cases = simulated_repair_queries();
    assert_eq!(cases.len(), 30);

    let mut hits = 0;
    for (expected, input, error) in &cases {
        let found = index.best_matches("DemoTool", &schema, input, error, 3);
        let signatures = found
            .iter()
            .map(|example| example.failure_signature.as_str())
            .collect::<Vec<_>>();
        if signatures.contains(expected) {
            hits += 1;
        }
        assert!(
            signatures.contains(expected),
            "expected {expected} in top-3, got {signatures:?} for input {input} and error {error}"
        );
    }

    assert_eq!(hits, cases.len());
}

#[test]
fn formats_multiple_repair_hints_for_model_visible_error_output() {
    let schema = simulated_schema_fingerprint();
    let examples = simulated_repair_examples(&schema);
    let refs = examples.iter().take(3).collect::<Vec<_>>();

    let text = format_repair_hints(&refs);

    assert!(text.contains("Top 3 previous failed-to-successful repair examples"));
    assert!(text.contains("Repair example 1"));
    assert!(text.contains("Repair example 2"));
    assert!(text.contains("Repair example 3"));
    assert_eq!(text.matches("Successful corrected call:").count(), 3);
    assert!(text.contains("Use the corrected JSON shapes"));
}

fn simulated_schema_fingerprint() -> String {
    schema_fingerprint(&json!({
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "tags": {"type": "array"},
            "questions": {"type": "array"},
            "timeout": {"type": "integer"},
            "mode": {"enum": ["fast", "deep"]},
            "file_path": {"type": "string"},
            "patch": {"type": "object"},
            "items": {"type": "array"},
            "TodoList": {"type": "array"},
            "allowed_domains": {"type": "array"},
            "include_hidden": {"type": "boolean"},
            "max_results": {"type": "integer"},
            "replace_all": {"type": "boolean"},
            "offset": {"type": "integer"},
            "limit": {"type": "integer"},
            "pattern": {"type": "string"},
            "command": {"type": "string"},
            "description": {"type": "string"},
            "url": {"type": "string"},
            "method": {"enum": ["GET", "POST"]},
            "headers": {"type": "object"},
            "body": {"type": "string"},
            "recipient_email": {"type": "string"},
            "subject": {"type": "string"},
            "model": {"type": "string"},
            "temperature": {"type": "number"},
            "workdir": {"type": "string"},
            "nodeId": {"type": "string"},
            "fileKey": {"type": "string"},
            "duration": {"type": "integer"}
        }
    }))
}

fn simulated_repair_examples(schema: &str) -> Vec<ToolRepairExample> {
    vec![
        simulated_example(
            "case-query",
            schema,
            "$.query required string field is missing",
            json!({"q":"rust news","limit":5}),
            json!({"query":"rust news","limit":5}),
        ),
        simulated_example(
            "case-tags",
            schema,
            "$.tags expected array got string",
            json!({"tags":"rust"}),
            json!({"tags":["rust"]}),
        ),
        simulated_example(
            "case-options",
            schema,
            "$.questions[0].options expected array got object",
            json!({"questions":[{"question":"Deploy?","options":{"label":"Yes"}}]}),
            json!({"questions":[{"question":"Deploy?","options":[{"label":"Yes","description":"Deploy now"},{"label":"No","description":"Skip deploy"}]}]}),
        ),
        simulated_example(
            "case-timeout",
            schema,
            "$.timeout expected integer milliseconds got string",
            json!({"command":"cargo test","timeout":"fast"}),
            json!({"command":"cargo test","timeout":20000}),
        ),
        simulated_example(
            "case-mode",
            schema,
            "$.mode invalid enum value quick expected fast or deep",
            json!({"query":"release notes","mode":"quick"}),
            json!({"query":"release notes","mode":"deep"}),
        ),
        simulated_example(
            "case-file-path",
            schema,
            "$.file_path required string field is missing",
            json!({"path":"src/lib.rs"}),
            json!({"file_path":"src/lib.rs"}),
        ),
        simulated_example(
            "case-patch",
            schema,
            "$.patch expected object with old_string and new_string got string",
            json!({"patch":"replace alpha with beta"}),
            json!({"patch":{"old_string":"alpha","new_string":"beta"}}),
        ),
        simulated_example(
            "case-items",
            schema,
            "$.items[0] expected object got string",
            json!({"items":["write tests"]}),
            json!({"items":[{"content":"write tests","status":"pending"}]}),
        ),
        simulated_example(
            "case-active-form",
            schema,
            "$.TodoList[0].activeForm required string field is missing",
            json!({"TodoList":[{"content":"Run tests","status":"pending"}]}),
            json!({"TodoList":[{"content":"Run tests","activeForm":"Running tests","status":"pending"}]}),
        ),
        simulated_example(
            "case-domains",
            schema,
            "$.allowed_domains expected array got string",
            json!({"query":"docs","allowed_domains":"example.com"}),
            json!({"query":"docs","allowed_domains":["example.com"]}),
        ),
        simulated_example(
            "case-include-hidden",
            schema,
            "$.include_hidden expected boolean got string",
            json!({"include_hidden":"yes"}),
            json!({"include_hidden":true}),
        ),
        simulated_example(
            "case-max-results",
            schema,
            "$.max_results expected integer got string",
            json!({"query":"rust","max_results":"ten"}),
            json!({"query":"rust","max_results":10}),
        ),
        simulated_example(
            "case-replace-all",
            schema,
            "$.replace_all expected boolean got string",
            json!({"old_string":"foo","new_string":"bar","replace_all":"true"}),
            json!({"old_string":"foo","new_string":"bar","replace_all":true}),
        ),
        simulated_example(
            "case-offset",
            schema,
            "$.offset expected integer got string",
            json!({"file_path":"src/lib.rs","offset":"20"}),
            json!({"file_path":"src/lib.rs","offset":20}),
        ),
        simulated_example(
            "case-limit",
            schema,
            "$.limit expected integer got string",
            json!({"file_path":"src/lib.rs","limit":"200"}),
            json!({"file_path":"src/lib.rs","limit":200}),
        ),
        simulated_example(
            "case-pattern",
            schema,
            "$.pattern required string field is missing",
            json!({"regex":"struct QueryEngine"}),
            json!({"pattern":"struct QueryEngine"}),
        ),
        simulated_example(
            "case-command",
            schema,
            "$.command required string field is missing",
            json!({"cmd":"cargo test"}),
            json!({"command":"cargo test"}),
        ),
        simulated_example(
            "case-description",
            schema,
            "$.description required string field is missing",
            json!({"command":"cargo test"}),
            json!({"command":"cargo test","description":"Run focused tests"}),
        ),
        simulated_example(
            "case-url",
            schema,
            "$.url required string field is missing",
            json!({"link":"https://example.com"}),
            json!({"url":"https://example.com"}),
        ),
        simulated_example(
            "case-method",
            schema,
            "$.method invalid enum value PUT expected GET or POST",
            json!({"url":"https://example.com","method":"PUT"}),
            json!({"url":"https://example.com","method":"POST"}),
        ),
        simulated_example(
            "case-headers",
            schema,
            "$.headers expected object got array",
            json!({"headers":["Accept: application/json"]}),
            json!({"headers":{"Accept":"application/json"}}),
        ),
        simulated_example(
            "case-body",
            schema,
            "$.body expected string got object",
            json!({"body":{"message":"hello"}}),
            json!({"body":"{\"message\":\"hello\"}"}),
        ),
        simulated_example(
            "case-recipient",
            schema,
            "$.recipient_email required string field is missing",
            json!({"to":"user@example.com","subject":"Hello"}),
            json!({"recipient_email":"user@example.com","subject":"Hello"}),
        ),
        simulated_example(
            "case-subject",
            schema,
            "$.subject required string field is missing",
            json!({"recipient_email":"user@example.com","title":"Hello"}),
            json!({"recipient_email":"user@example.com","subject":"Hello"}),
        ),
        simulated_example(
            "case-model",
            schema,
            "$.model expected string got number",
            json!({"model":5}),
            json!({"model":"MiniMax-M3"}),
        ),
        simulated_example(
            "case-temperature",
            schema,
            "$.temperature expected number got string",
            json!({"temperature":"0.2"}),
            json!({"temperature":0.2}),
        ),
        simulated_example(
            "case-workdir",
            schema,
            "$.workdir required string field is missing",
            json!({"cwd":"/tmp/project"}),
            json!({"workdir":"/tmp/project"}),
        ),
        simulated_example(
            "case-node-id",
            schema,
            "$.nodeId expected string got number",
            json!({"nodeId":12345}),
            json!({"nodeId":"123:45"}),
        ),
        simulated_example(
            "case-file-key",
            schema,
            "$.fileKey required string field is missing",
            json!({"key":"abc123"}),
            json!({"fileKey":"abc123"}),
        ),
        simulated_example(
            "case-duration",
            schema,
            "$.duration expected integer got string",
            json!({"duration":"7"}),
            json!({"duration":7}),
        ),
    ]
}

fn simulated_repair_queries() -> Vec<(&'static str, Value, &'static str)> {
    vec![
        (
            "case-query",
            json!({"q":"tokio tutorial","limit":3}),
            "$.query required string field is missing",
        ),
        (
            "case-tags",
            json!({"tags":"async"}),
            "$.tags expected array got string",
        ),
        (
            "case-options",
            json!({"questions":[{"question":"Run?","options":{"label":"Run"}}]}),
            "$.questions[0].options expected array got object",
        ),
        (
            "case-timeout",
            json!({"command":"cargo build","timeout":"slow"}),
            "$.timeout expected integer milliseconds got string",
        ),
        (
            "case-mode",
            json!({"query":"api docs","mode":"quick"}),
            "$.mode invalid enum value quick expected fast or deep",
        ),
        (
            "case-file-path",
            json!({"path":"crates/app/src/main.rs"}),
            "$.file_path required string field is missing",
        ),
        (
            "case-patch",
            json!({"patch":"replace foo with bar"}),
            "$.patch expected object with old_string and new_string got string",
        ),
        (
            "case-items",
            json!({"items":["implement feature"]}),
            "$.items[0] expected object got string",
        ),
        (
            "case-active-form",
            json!({"TodoList":[{"content":"Inspect logs","status":"pending"}]}),
            "$.TodoList[0].activeForm required string field is missing",
        ),
        (
            "case-domains",
            json!({"query":"pricing","allowed_domains":"openai.com"}),
            "$.allowed_domains expected array got string",
        ),
        (
            "case-include-hidden",
            json!({"include_hidden":"false"}),
            "$.include_hidden expected boolean got string",
        ),
        (
            "case-max-results",
            json!({"query":"tokio","max_results":"five"}),
            "$.max_results expected integer got string",
        ),
        (
            "case-replace-all",
            json!({"old_string":"alpha","new_string":"beta","replace_all":"yes"}),
            "$.replace_all expected boolean got string",
        ),
        (
            "case-offset",
            json!({"file_path":"crates/lib.rs","offset":"50"}),
            "$.offset expected integer got string",
        ),
        (
            "case-limit",
            json!({"file_path":"crates/lib.rs","limit":"400"}),
            "$.limit expected integer got string",
        ),
        (
            "case-pattern",
            json!({"regex":"fn execute_tool"}),
            "$.pattern required string field is missing",
        ),
        (
            "case-command",
            json!({"cmd":"cargo build"}),
            "$.command required string field is missing",
        ),
        (
            "case-description",
            json!({"command":"cargo clippy"}),
            "$.description required string field is missing",
        ),
        (
            "case-url",
            json!({"link":"https://docs.example.com"}),
            "$.url required string field is missing",
        ),
        (
            "case-method",
            json!({"url":"https://api.example.com","method":"PATCH"}),
            "$.method invalid enum value PATCH expected GET or POST",
        ),
        (
            "case-headers",
            json!({"headers":["Authorization: Bearer token"]}),
            "$.headers expected object got array",
        ),
        (
            "case-body",
            json!({"body":{"event":"ping"}}),
            "$.body expected string got object",
        ),
        (
            "case-recipient",
            json!({"to":"dev@example.com","subject":"Status"}),
            "$.recipient_email required string field is missing",
        ),
        (
            "case-subject",
            json!({"recipient_email":"dev@example.com","title":"Status"}),
            "$.subject required string field is missing",
        ),
        (
            "case-model",
            json!({"model":42}),
            "$.model expected string got number",
        ),
        (
            "case-temperature",
            json!({"temperature":"0.7"}),
            "$.temperature expected number got string",
        ),
        (
            "case-workdir",
            json!({"cwd":"/data/project"}),
            "$.workdir required string field is missing",
        ),
        (
            "case-node-id",
            json!({"nodeId":987}),
            "$.nodeId expected string got number",
        ),
        (
            "case-file-key",
            json!({"key":"xyz789"}),
            "$.fileKey required string field is missing",
        ),
        (
            "case-duration",
            json!({"duration":"14"}),
            "$.duration expected integer got string",
        ),
    ]
}

fn simulated_example(
    id: &str,
    schema_fingerprint: &str,
    error_summary: &str,
    failed_input: Value,
    successful_input: Value,
) -> ToolRepairExample {
    ToolRepairExample {
        version: STORE_VERSION,
        session_id: "simulated-session".to_string(),
        tool_name: "DemoTool".to_string(),
        schema_fingerprint: schema_fingerprint.to_string(),
        failure_signature: id.to_string(),
        error_summary: error_summary.to_string(),
        failed_input,
        successful_input,
        created_at_ms: 1,
    }
}
