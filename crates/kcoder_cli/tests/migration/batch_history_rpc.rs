use super::{Fixture, json, rpc};

#[test]
fn a_config_and_history_selection_share_one_confirmation_and_reopen_the_same_child() {
    let fixture = Fixture::new();
    let source = fixture.source(3);
    let original = std::fs::read(&source).unwrap();
    std::fs::write(
        fixture.claude.join("settings.json"),
        r#"{"mcpServers":{"documents":{"command":"never-execute-history-batch-fixture"}}}"#,
    )
    .unwrap();
    let mut server = fixture.start();
    let sources = rpc(
        &mut server,
        301,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let source_id = sources["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["scope"] == "user")
        .unwrap()["sourceId"]
        .clone();
    let histories = rpc(
        &mut server,
        302,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let selected = json!({"catalogId":histories["catalogId"],
        "sourceHandle":histories["items"][0]["sourceHandle"]});
    let scanned = rpc(
        &mut server,
        303,
        "migration/batch/scan",
        json!({
        "sourceIds":[source_id], "historySources":[selected]}),
    );
    assert_eq!(scanned["job"]["totalItems"], 2);
    let job = scanned["job"]["jobId"].clone();
    let planned = rpc(
        &mut server,
        304,
        "migration/batch/plan",
        json!({
        "jobId":job, "expectedSequence":scanned["job"]["sequence"],
        "choices":[], "includeDefaultItems":true}),
    );
    assert_eq!(planned["batch"]["selectedItems"], 2);
    assert_eq!(
        std::fs::read_to_string(fixture.profile.join("settings.json")).unwrap(),
        "{}"
    );
    let page = rpc(&mut server, 305, "migration/items", json!({"jobId":job}));
    let item = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["category"] == "history")
        .unwrap()["id"]
        .clone();
    let history_plan = rpc(
        &mut server,
        306,
        "migration/batch/item/plan",
        json!({
        "jobId":job, "itemId":item}),
    );
    let child = history_plan["item"]["historyJobId"].clone();
    assert!(child.is_string());
    let applied = rpc(
        &mut server,
        307,
        "migration/batch/apply",
        json!({
        "jobId":job, "planId":planned["batch"]["planId"],
        "requestId":"confirmed-history-batch", "expectedSequence":planned["job"]["sequence"]}),
    );
    assert_eq!(applied["job"]["committedItems"], 2);
    let archived = rpc(
        &mut server,
        308,
        "migration/history/read",
        json!({"jobId":child}),
    );
    assert_eq!(archived["job"]["stage"], "normalized");
    assert_eq!(archived["job"]["normalization"]["normalizedRecords"], 3);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    std::fs::remove_file(&source).unwrap();
    drop(server);
    let mut server = fixture.start();
    let repeated = rpc(
        &mut server,
        309,
        "migration/batch/apply",
        json!({
        "jobId":job, "planId":planned["batch"]["planId"], "requestId":"confirmed-history-batch",
        "expectedSequence":planned["job"]["sequence"]}),
    );
    assert_eq!(repeated, applied);
    let observed = rpc(
        &mut server,
        310,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":item}),
    );
    assert_eq!(observed["item"]["historyJobId"], child);
}

#[test]
fn a_history_batch_only_accepts_unique_native_grants_not_source_paths() {
    let fixture = Fixture::new();
    fixture.source(1);
    let mut server = fixture.start();
    let page = rpc(
        &mut server,
        321,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let grant =
        json!({"catalogId":page["catalogId"], "sourceHandle":page["items"][0]["sourceHandle"]});
    for (index, selections) in [
        json!([grant, grant]),
        json!([{"catalogId":page["catalogId"],
        "sourceHandle":page["items"][0]["sourceHandle"], "path":"/other-account"}]),
    ]
    .into_iter()
    .enumerate()
    {
        let id = 322 + index as i64;
        server.send(
            json!({"jsonrpc":"2.0","id":id,"method":"migration/batch/scan",
            "params":{"sourceIds":[],"historySources":selections}}),
        );
        assert!(server.response(id).get("error").is_some());
    }
    let jobs = rpc(&mut server, 325, "migration/jobs/list", json!({}));
    assert!(jobs["jobs"].as_array().unwrap().is_empty());
}
