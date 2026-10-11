use kcoder_config::PermissionMode;
use kcoder_permissions::{
    AuditRecord, PermissionDecision, PermissionEngine, bash_command_matches,
    classify_bash_read_only, classify_powershell_read_only, split_bash_command,
};
use kcoder_tools::{BashTool, FileReadTool, FileWriteTool};
use serde_json::json;
use std::path::Path;
use std::time::{Duration, Instant};

#[test]
fn compound_shell_commands_are_classified_per_segment() {
    assert_eq!(
        split_bash_command("pwd && git status; cargo test | tee result.log"),
        ["pwd", "git status", "cargo test", "tee result.log"]
    );
    assert!(bash_command_matches(
        "git status",
        "pwd && git status",
        false
    ));
    assert!(!bash_command_matches(
        "git status",
        "pwd && git status",
        true
    ));
}

#[test]
fn read_only_classifiers_fail_closed_for_mutating_commands() {
    assert!(classify_bash_read_only("pwd && rg contract README.md"));
    assert!(!classify_bash_read_only("pwd && rm result.log"));
    assert!(classify_powershell_read_only(
        "Get-ChildItem; Get-Content README.md"
    ));
    assert!(!classify_powershell_read_only("Remove-Item result.log"));
}

fn poll_audit_records(path: &Path, expected: usize) -> Vec<AuditRecord> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            let complete_lines = text
                .rsplit_once('\n')
                .map(|(complete, _)| complete)
                .unwrap_or("");
            let records = complete_lines
                .lines()
                .map(|line| serde_json::from_str::<AuditRecord>(line).unwrap())
                .collect::<Vec<_>>();
            if records.len() >= expected {
                return records;
            }
        }
        assert!(Instant::now() < deadline, "permission audit 未在期限内落盘");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn real_tools_cover_allow_ask_deny_and_append_audit_jsonl() {
    let temporary = tempfile::tempdir().unwrap();
    let audit_path = temporary.path().join("audit/permissions.jsonl");
    let mut engine = PermissionEngine::default();
    engine.mode = PermissionMode::Auto;
    let mut engine = engine.with_audit_log(audit_path.clone());
    engine.allowed_tools.push("bash".to_string());
    engine.denied_tools.push("bash".to_string());

    let read = FileReadTool;
    let write = FileWriteTool;
    let bash = BashTool;
    assert_eq!(
        engine.decide(&read, &json!({"file_path": "src/lib.rs"})),
        PermissionDecision::Allow
    );
    assert_eq!(
        engine.decide(
            &write,
            &json!({"file_path": "out.txt", "content": "changed"})
        ),
        PermissionDecision::Ask
    );
    assert_eq!(
        engine.decide(&bash, &json!({"command": "rm -rf target"})),
        PermissionDecision::Deny
    );

    let records = poll_audit_records(&audit_path, 3);
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].tool_name, "read");
    assert_eq!(records[0].reason, "mode_allow");
    assert_eq!(records[1].tool_name, "write");
    assert_eq!(records[1].reason, "mode_ask");
    assert_eq!(records[2].tool_name, "bash");
    assert_eq!(records[2].reason, "deny_list");
    assert_eq!(records[2].input["command"], "rm -rf target");
}
