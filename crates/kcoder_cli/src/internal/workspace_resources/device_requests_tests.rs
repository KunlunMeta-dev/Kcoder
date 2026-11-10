//! Workspace device RPC tests through the device command dispatcher.
use crate::workspace_fs::tree;
use serde_json::json;
use sha2::Digest as _;

#[tokio::test]
async fn device_workspace_tree_is_bounded_to_the_configured_root() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join("src")).unwrap();
    std::fs::write(workspace.path().join("README.md"), "hello").unwrap();
    let result = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({"command_key": "workspace_tree", "path": workspace.path()}))
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(result.success);
    assert_eq!(result.stdout["entries"][0]["name"], "src");
    assert_eq!(result.stdout["entries"][0]["is_directory"], true);
    assert!(
        result.stdout["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == "README.md")
    );
    let file = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "workspace_read_text_file",
            "path": workspace.path(),
            "args": ["README.md"],
            "max_output_bytes": 1024,
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(file.stdout["content"], "hello");
    assert_eq!(file.stdout["editable"], true);
    assert_eq!(
        file.stdout["revision"],
        format!("sha256:{:x}", sha2::Sha256::digest(b"hello"))
    );

    let revision = file.stdout["revision"].as_str().unwrap().to_string();
    let saved = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "workspace_write_text_file",
            "path": workspace.path(),
            "args": ["README.md", revision],
            "stdin": "updated",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(saved.stdout["content"], "updated");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("README.md")).unwrap(),
        "updated"
    );

    let stale = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "workspace_write_text_file",
            "path": workspace.path(),
            "args": ["README.md", "sha256:stale"],
            "stdin": "must-not-win",
        }))
        .unwrap(),
    )
    .await
    .unwrap_err();
    assert!(stale.to_string().contains("changed on disk"));
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("README.md")).unwrap(),
        "updated"
    );

    std::fs::write(workspace.path().join("bytes.bin"), [0_u8, 1, 2, 3]).unwrap();
    let chunk = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "workspace_read_file_chunk",
            "path": workspace.path(),
            "args": ["bytes.bin", "1"],
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(chunk.stdout["content_base64"], "AQID");
    assert_eq!(chunk.stdout["offset"], 1);
    assert_eq!(chunk.stdout["eof"], true);

    let outside = tempfile::tempdir().unwrap();
    let error = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({"command_key": "workspace_tree", "path": outside.path()}))
            .unwrap(),
    )
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("outside the configured workspace")
    );

    for index in 0..200 {
        std::fs::write(workspace.path().join(format!("entry-{index:03}.txt")), "x").unwrap();
    }
    let full_tree = tree(workspace.path(), workspace.path()).await.unwrap();
    assert_eq!(full_tree["entries"].as_array().unwrap().len(), 203);
    assert!(
        full_tree["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == "README.md")
    );
}

#[tokio::test]
async fn device_directory_commands_can_select_another_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join("existing")).unwrap();
    std::fs::write(workspace.path().join("README.md"), "hello").unwrap();

    let listed = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "ls_dirs",
            "path": workspace.path(),
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(listed.stdout, json!(["existing"]));

    let created_path = workspace.path().join("created");
    let created = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "mkdir_p",
            "args": [created_path],
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(created.stdout, json!(created_path));
    assert!(created_path.is_dir());

    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(outside.path().join("another-workspace")).unwrap();
    let outside_result = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "ls_dirs",
            "path": outside.path(),
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(outside_result.stdout, json!(["another-workspace"]));

    let relative_error = super::device_execute(
        workspace.path(),
        &serde_json::from_value(json!({
            "command_key": "ls_dirs",
            "path": "relative/path",
        }))
        .unwrap(),
    )
    .await
    .unwrap_err();
    assert!(relative_error.to_string().contains("must be absolute"));
}
