use kcoder_migration::history_records::parse_reader;
use kcoder_types::{imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};

fn parse(role: &str, parts: Vec<Value>) -> HistoricalRecord {
    let bytes = serde_json::to_vec(
        &json!({"type":"response_item","payload":{"type":"message","role":role,"content":parts}}),
    )
    .unwrap();
    parse_reader(MigrationSourceKind::Codex, 0, &bytes[..], |_| true).unwrap()
}
fn text(value: &str) -> Value {
    json!({"type":"input_text","text":value})
}
fn boundary(role: &str, value: &str) -> Option<bool> {
    parse(role, vec![text(value)])
        .codex
        .unwrap()
        .user_turn_boundary
}

#[test]
fn contextual_wrappers_are_trimmed_and_case_insensitive_without_consuming_rollback_turns() {
    for (open, close) in [
        (
            "# AGENTS.md instructions for /owned/project",
            "</INSTRUCTIONS>",
        ),
        ("<environment_context>", "</environment_context>"),
        (
            "<agent_message_board_notification>",
            "</agent_message_board_notification>",
        ),
        ("<skills_instructions>", "</skills_instructions>"),
        ("<user_shell_command>", "</user_shell_command>"),
        ("<turn_aborted>", "</turn_aborted>"),
        ("<subagent_notification>", "</subagent_notification>"),
        ("<recommended_plugins>", "</recommended_plugins>"),
    ] {
        let value = format!(
            "{}{}{}{}{}",
            "\u{2003}".repeat(2000),
            open.to_uppercase(),
            "x".repeat(9000),
            close.to_uppercase(),
            "\u{2003}".repeat(2000)
        );
        assert_eq!(boundary("user", &value), Some(false));
        assert_eq!(boundary("user", &format!("{open}incomplete")), Some(true));
        assert_eq!(
            boundary("user", &format!("ordinary quotation {open}{close}")),
            Some(true)
        );
        assert_eq!(
            boundary("user", &format!("{open}{close} ordinary suffix")),
            Some(true)
        );
    }
    let record = parse(
        "user",
        vec![
            text("human-looking text"),
            text("<environment_context>old</environment_context>"),
        ],
    );
    assert_eq!(record.codex.unwrap().user_turn_boundary, Some(false));
    assert_eq!(boundary("user", "ordinary user instruction"), Some(true));
    assert_eq!(boundary("user", ""), Some(true));
    assert_eq!(
        boundary("assistant", "ordinary assistant response"),
        Some(false)
    );
}

#[test]
fn variable_context_tags_follow_the_pinned_case_and_source_identifier_rules() {
    for value in [
        "<external_calendar>old context</external_calendar>",
        "<codex_internal_context source=\"goal_update\">old context</codex_internal_context>",
        "<goal_context>old context</goal_context>",
    ] {
        assert_eq!(boundary("user", value), Some(false));
    }
    for value in [
        "<external_calendar>old context</external_mail>",
        "<EXTERNAL_calendar>old context</EXTERNAL_calendar>",
        "<codex_internal_context source=\"Goal\">old</codex_internal_context>",
        "<codex_internal_context source=\"goal-update\">old</codex_internal_context>",
        "<codex_internal_context source=\"\">old</codex_internal_context>",
    ] {
        assert_eq!(boundary("user", value), Some(true));
    }
    let record = parse(
        "user",
        vec![text(&format!(
            "<external_{}>x</external_{}>",
            "a".repeat(600),
            "a".repeat(600)
        ))],
    );
    assert_eq!(record.codex.as_ref().unwrap().user_turn_boundary, None);
    assert!(
        record.diagnostics.iter().any(
            |issue| issue.code == "unresolved_codex_user_boundary" && issue.blocks_continuation
        )
    );
}

#[test]
fn hook_xml_requires_actual_deserialization_and_large_unverified_hooks_stay_unknown() {
    assert_eq!(
        boundary(
            "user",
            r#"<hook_prompt hook_run_id="owned-hook">old result</hook_prompt>"#
        ),
        Some(false)
    );
    assert_eq!(
        boundary(
            "user",
            r#"<hook_prompt hook_run_id="  ">old result</hook_prompt>"#
        ),
        Some(true)
    );
    assert_eq!(
        boundary("user", r#"<hook_prompt hook_run_id="owned-hook">broken"#),
        Some(true)
    );
    assert_eq!(
        boundary("user", r#"<hook_prompt>old result</hook_prompt>"#),
        Some(true)
    );
    let record = parse(
        "user",
        vec![text(&format!(
            "<hook_prompt hook_run_id=\"owned-hook\">{}</hook_prompt>",
            "x".repeat(5000)
        ))],
    );
    assert_eq!(record.codex.as_ref().unwrap().user_turn_boundary, None);
    assert!(
        record
            .diagnostics
            .iter()
            .any(|issue| issue.blocks_continuation)
    );
}

#[test]
fn serialized_agent_instructions_are_boundaries_but_arbitrary_assistant_json_is_not() {
    let value = json!({"author":"/root/research","recipient":"/root","content":"old task","trigger_turn":true});
    assert_eq!(boundary("assistant", &value.to_string()), Some(true));
    for path in ["/root/a_b/child9", "/morpheus"] {
        let mut input = value.clone();
        input["author"] = path.into();
        assert_eq!(boundary("assistant", &input.to_string()), Some(true));
    }
    for path in [
        "root",
        "/root/",
        "/root/root",
        "/root/Upper",
        "/root/name-with-dash",
    ] {
        let mut input = value.clone();
        input["author"] = path.into();
        assert_eq!(boundary("assistant", &input.to_string()), Some(false));
    }
    for patch in [
        json!({"trigger_turn":"yes"}),
        json!({"content":{}}),
        json!({"other_recipients":null}),
        json!({"internal_chat_message_metadata_passthrough":{"create_time":"bad"}}),
    ] {
        let mut input = value.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert_eq!(boundary("assistant", &input.to_string()), Some(false));
    }
    let mut long = value;
    long["content"] = "x".repeat(5000).into();
    assert_eq!(boundary("assistant", &long.to_string()), None);
    assert_eq!(
        parse("assistant", vec![text("{}"), text("{}")])
            .codex
            .unwrap()
            .user_turn_boundary,
        Some(false)
    );
}
