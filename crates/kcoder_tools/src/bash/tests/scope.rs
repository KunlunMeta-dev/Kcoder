use super::*;

#[test]
fn scoped_inspection_normalizes_options_and_rejects_auxiliary_execution() {
    for command in [
        "rg --hostname-bin=helper needle",
        "rg '--pre' helper needle",
        "rg --p\\re helper needle",
        "find . -ex\\ec helper {} +",
        "find . '-fprint' result",
        "rg $FLAGS needle",
        "rg \"$FLAGS\" needle",
        "rg --unknown-future-option needle",
        "rg -z needle archive.gz",
        "file '--compile' -m magic",
    ] {
        assert!(!scoped_shell_command_is_read_only(command), "{command}");
        assert!(
            !scoped_shell_command_matches_allowed_prefixes(command, &["docker exec exact".into()]),
            "{command}"
        );
    }
    for command in [
        "rg -n 'a b' src",
        "rg --fixed-strings -- '--pre' sample.txt",
        "find . -name '*.rs'",
        "'pwd'",
    ] {
        assert!(scoped_shell_command_is_read_only(command), "{command}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn read_only_scope_blocks_normalized_auxiliary_options_before_execution() {
    let tmp = tempfile::tempdir().unwrap();
    let marker = tmp.path().join("must-not-exist");
    let helper = tmp.path().join("helper");
    std::fs::write(
        &helper,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(tmp.path().join("sample.txt"), "needle\n").unwrap();
    let ctx = ToolContext::new(AppState::new(tmp.path())).with_block_shell_file_mutation(true);
    for option in ["'--pre'", "--p\\re", "'--hostname-bin'"] {
        let output = BashTool.call(serde_json::json!({"command": format!("rg {option} '{}' --hyperlink-format default needle sample.txt", helper.display())}), &ctx).await.unwrap();
        assert!(output.is_error, "{option}");
        assert!(output.content.iter().any(|content| matches!(content,
            kcoder_types::ContentBlock::Text { text } if text.starts_with("Arrangement shell mutation guard is active")
        )), "{option}");
        assert!(!marker.exists(), "{option}");
    }
}

#[test]
fn scoped_shell_policy_is_fail_closed() {
    assert!(scoped_shell_command_is_read_only(
        "rg needle src | head -n 5"
    ));
    assert!(!scoped_shell_command_is_read_only("cargo test"));
    assert!(!scoped_shell_command_is_read_only("printf x>outside.txt"));
    assert!(!scoped_shell_command_is_read_only(
        "ruby -e 'File.write(%q{x}, %q{y})'"
    ));
    assert!(!scoped_shell_command_is_read_only("dd if=/dev/null of=x"));
    assert!(!scoped_shell_command_is_read_only("find . -exec rm {} +"));
    assert!(!scoped_shell_command_is_read_only(
        "rg --pre 'sh mutate.sh' needle"
    ));
    assert!(!scoped_shell_command_is_read_only(
        "LD_PRELOAD=./mutate.so rg needle"
    ));
    assert!(!scoped_shell_command_is_read_only(
        "sort -o outside.txt input"
    ));
}

#[test]
fn delegated_shell_prefix_requires_every_safe_top_level_segment() {
    let prefixes = vec!["docker exec -i exact-container".to_string()];
    assert!(scoped_shell_command_matches_allowed_prefixes(
        "docker exec -i exact-container python3 - < staging.py",
        &prefixes,
    ));
    assert!(scoped_shell_command_matches_allowed_prefixes(
        "pwd && docker exec -i exact-container python3 /tmp/staging.py",
        &prefixes,
    ));
    assert!(!scoped_shell_command_matches_allowed_prefixes(
        "docker exec -i other-container python3 - < staging.py",
        &prefixes,
    ));
    assert!(!scoped_shell_command_matches_allowed_prefixes(
        "docker exec -i exact-container python3 /tmp/staging.py; touch escaped",
        &prefixes,
    ));
    assert!(!scoped_shell_command_matches_allowed_prefixes(
        "docker exec -i exact-container true > escaped",
        &prefixes,
    ));
    assert!(!scoped_shell_command_matches_allowed_prefixes(
        "docker exec -i exact-container echo $(touch escaped)",
        &prefixes,
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn bounded_scope_honors_exact_delegated_shell_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("explicitly-authorized");
    let command = format!("touch {}", target.display());
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_allowed_write_paths(vec![tmp.path().join("staging.py").display().to_string()])
        .with_allowed_shell_prefixes(vec![command.clone()]);
    let output = BashTool
        .call(serde_json::json!({"command": command}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert!(target.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn filesystem_root_write_scope_allows_implementer_shell_execution() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("shell-created");
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_allowed_write_paths(vec!["/".to_string()]);
    let output = BashTool
        .call(
            serde_json::json!({
                "command": format!("touch {}", target.display())
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(!output.is_error);
    assert!(target.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn filesystem_root_write_scope_does_not_unblock_read_only_roles() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("must-not-exist");
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_allowed_write_paths(vec!["/".to_string()])
        .with_block_shell_file_mutation(true);
    let output = BashTool
        .call(
            serde_json::json!({
                "command": format!("touch {}", target.display())
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(!target.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn bounded_write_scope_keeps_implementer_shell_fail_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("inside-scope");
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_allowed_write_paths(vec![tmp.path().display().to_string()]);
    let output = BashTool
        .call(
            serde_json::json!({
                "command": format!("touch {}", target.display())
            }),
            &ctx,
        )
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(!target.exists());
}
