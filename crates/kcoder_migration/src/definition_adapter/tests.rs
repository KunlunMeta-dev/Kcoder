use super::*;
#[test]
fn known_fields_are_reported_without_values_or_unknown_names_and_opaque_data_stays_pending() {
    for (format,bytes) in [
        (Format::ClaudeAgentMarkdown,b"---\nname: fixture\ndescription: private description\npermissionMode: bypassPermissions\nSYNTHETIC_SECRET_KEY: secret-value\n---\nRun no commands\n".as_slice()),
        (Format::CodexAgentToml,b"name='fixture'\ndescription='private description'\ndeveloper_instructions='Run no commands'\nSYNTHETIC_SECRET_KEY='secret-value'\n".as_slice()),
        (Format::ClaudeHooksJson,br#"{"hooks":{"UnknownSecretEvent":[{"SYNTHETIC_SECRET_KEY":"secret-value","hooks":[{"type":"command","command":"private command"}]}]}}"#.as_slice())
    ] {
        let result=report(format,bytes);assert_eq!(result.parse_status,Status::Parsed);assert!(!result.execution_allowed&&result.requires_review);assert!(result.unknown_fields.unwrap()>0);
        let public=serde_json::to_string(&result).unwrap();for secret in ["private description","SYNTHETIC_SECRET_KEY","secret-value","UnknownSecretEvent","private command"] {assert!(!public.contains(secret));}
    }
    assert_eq!(
        report(Format::CodexAgentToml, &[0xff, 0]).parse_status,
        Status::Opaque
    );
    assert_eq!(
        report(Format::ClaudeAgentMarkdown, b"malformed agent").parse_status,
        Status::Malformed
    );
    assert_eq!(
        report(Format::CodexHooksJson, &vec![b' '; MAX_PARSE_BYTES + 1]).parse_status,
        Status::BudgetExceeded
    );
}
#[test]
fn duplicate_keys_deep_nodes_and_excessive_reports_do_not_claim_parsed() {
    assert_eq!(
        report(Format::CodexHooksJson, br#"{"hooks":{},"hooks":{}}"#).parse_status,
        Status::Malformed
    );
    let nested = format!("{}0{}", "[".repeat(65), "]".repeat(65));
    assert_eq!(
        report(Format::CodexHooksJson, nested.as_bytes()).parse_status,
        Status::BudgetExceeded
    );
    let value = serde_json::json!({"hooks":{"PreToolUse":[{"hooks":(0..600).map(|_|serde_json::json!({"type":"command","command":"never"})).collect::<Vec<_>>()}]}});
    let result = report(Format::CodexHooksJson, &serde_json::to_vec(&value).unwrap());
    assert_eq!(result.parse_status, Status::BudgetExceeded);
    assert!(result.fields.is_empty());
    assert!(!result.execution_allowed);
}
#[test]
fn inline_hooks_extract_only_selected_subtree_and_refuse_malformed_documents() {
    for (kind, input) in [
        (
            kcoder_types::migration::MigrationSourceKind::ClaudeCode,
            r#"{"env":{"ANTHROPIC_API_KEY":"SYNTHETIC_NONHOOK_SECRET"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"never-run"}]}]}}"#,
        ),
        (
            kcoder_types::migration::MigrationSourceKind::Codex,
            "api_key='SYNTHETIC_NONHOOK_SECRET'\n[hooks]\nStop=[{hooks=[{type='command',command='never-run'}]}]\n",
        ),
    ] {
        let bytes = hooks_fragment(kind, input).unwrap().unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(
            !text.contains("SYNTHETIC_NONHOOK_SECRET")
                && !text.contains("api_key")
                && !text.contains("env")
        );
        assert!(text.contains("never-run"));
        assert!(hooks_fragment(kind, "malformed document {[").is_err());
    }
}
