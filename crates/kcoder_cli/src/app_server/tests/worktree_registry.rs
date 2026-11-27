#[tokio::test]
async fn root_sidebar_pinning_is_persistent_without_fabricating_workspace_records() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let initial = workspace_request(&engine, "runtime.workspaces.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(initial["rootProjectPinned"], true);
    for pinned in [false, true, false] {
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": workspace.path(), "rootProject": true, "pinned": pinned
            }),
        )
        .await
        .unwrap();
        let reader = runtime_context_test_engine(workspace.path(), None);
        let listed = workspace_request(&reader, "runtime.workspaces.list", &json!({}))
            .await
            .unwrap();
        assert_eq!(listed["rootProjectPinned"], pinned);
        assert!(listed["items"].as_array().unwrap().is_empty());
    }
    let other = tempfile::tempdir().unwrap();
    assert!(
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": other.path(), "rootProject": true, "pinned": true
            })
        )
        .await
        .is_err()
    );
    assert!(
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": workspace.path(), "rootProject": "true", "pinned": true
            })
        )
        .await
        .is_err()
    );
    assert_eq!(
        workspace_request(&engine, "runtime.workspaces.list", &json!({}))
            .await
            .unwrap()["rootProjectPinned"],
        false
    );
}
