#[test]
fn sanitize_scrubs_credentials_in_freeform_command_text() {
    let input = json!({
        "command": "curl -H 'Authorization: Bearer sk-live-123' --api-key=sk-456 https://x && password=hunter2 ls"
    });
    let sanitized = sanitize_json(&input);
    let text = sanitized["command"].as_str().unwrap();
    assert!(!text.contains("sk-live-123"), "bearer token leaked: {text}");
    assert!(!text.contains("sk-456"), "flag value leaked: {text}");
    assert!(!text.contains("hunter2"), "bare secret leaked: {text}");
    assert!(text.contains("Bearer <redacted>"), "{text}");
    assert!(text.contains("--api-key=<redacted>"), "{text}");
}

#[test]
fn sanitize_redacts_new_sensitive_key_variants() {
    let input = json!({"passphrase": "x", "access_key": "y", "note": "ok"});
    let sanitized = sanitize_json(&input);
    assert_eq!(sanitized["passphrase"], "<redacted>");
    assert_eq!(sanitized["access_key"], "<redacted>");
    assert_eq!(sanitized["note"], "ok");
}

#[test]
fn repair_examples_redact_sensitive_values() {
    let mut recorder = ToolRepairSessionRecorder::default();
    let schema = schema_fingerprint(&json!({"type": "object"}));

    recorder.record_failure(
        "Config",
        &schema,
        "bad input",
        &json!({"api_key":"secret-value","safe":"visible"}),
    );
    recorder.record_success(
        "Config",
        &schema,
        &json!({"api_key":"secret-value","safe":"visible"}),
    );

    let examples = build_repair_examples("session-1", &recorder.events);
    assert_eq!(examples[0].failed_input["api_key"], "<redacted>");
    assert_eq!(examples[0].successful_input["api_key"], "<redacted>");
    assert_eq!(examples[0].successful_input["safe"], "visible");
}
