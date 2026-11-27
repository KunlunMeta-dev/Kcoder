#[test]
fn tool_input_log_summary_omits_values_and_redacts_sensitive_fields() {
    let input = serde_json::json!({
        "command": "curl -H 'Authorization: Bearer secret-token' https://example.test",
        "mcp_servers": [
            {
                "name": "internal",
                "env": {
                    "OPENAI_API_KEY": "sk-secret-value",
                    "PUBLIC_FLAG": "visible"
                }
            }
        ],
        "count": 3
    });

    let summary = tool_input_log_summary(&input);

    assert!(summary.contains("command:string:"));
    assert!(summary.contains("OPENAI_API_KEY:redacted"));
    assert!(summary.contains("PUBLIC_FLAG:string:7c"));
    assert!(summary.contains("count:number"));
    assert!(!summary.contains("curl -H"));
    assert!(!summary.contains("secret-token"));
    assert!(!summary.contains("sk-secret-value"));
    assert!(!summary.contains("visible"));
}
