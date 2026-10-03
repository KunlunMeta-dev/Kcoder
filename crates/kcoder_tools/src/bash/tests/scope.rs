use super::*;

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
