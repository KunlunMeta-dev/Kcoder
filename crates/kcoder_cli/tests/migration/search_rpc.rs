use super::*;

fn archived(fixture: &Fixture) -> (TestAppServer, String) {
    let mut server = fixture.start();
    let page = rpc(
        &mut server,
        80,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let job = uuid::Uuid::new_v4().to_string();
    create(&mut server, &page, &page["items"][0], &job);
    rpc(
        &mut server,
        81,
        "migration/history/run",
        json!({"jobId":job,"expectedSequence":0}),
    );
    wait(&mut server, &job, |value| {
        value["job"]["stage"] == "normalized"
    });
    (server, job)
}
fn find(server: &mut TestAppServer, job: &str, query: &str, cursor: Value) -> Value {
    rpc(
        server,
        82,
        "migration/history/search",
        json!({"jobId":job,"viewId":null,"query":query,"caseSensitive":false,"cursor":cursor,"limit":10}),
    )
}
#[test]
fn search_pages_beyond_previews_and_seals_body_positions_without_source_execution() {
    let fixture = Fixture::new();
    let file = fixture.source(0);
    let session = file.file_stem().unwrap().to_str().unwrap();
    let text = "x".repeat(5 * 1024 * 1024) + "LATE_NEEDLE终";
    let mut records = vec![
        json!({"type":"assistant","uuid":"long","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":text}}),
    ];
    records.extend((0..12).map(|i|json!({"type":"user","uuid":format!("row-{i}"),"sessionId":session,"version":"2.1.301","message":{"role":"user","content":format!("PAGED_NEEDLE {i}")}})));
    let original = records
        .into_iter()
        .map(|v| v.to_string() + "\n")
        .collect::<String>();
    fs::write(&file, &original).unwrap();
    let (mut server, job) = archived(&fixture);
    let first = find(&mut server, &job, "late_needle终", Value::Null);
    assert!(first["items"].as_array().unwrap().is_empty());
    assert!(first["nextCursor"].is_string());
    let second = find(
        &mut server,
        &job,
        "late_needle终",
        first["nextCursor"].clone(),
    );
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    let found = &second["items"][0];
    assert_eq!(found["matched"], "LATE_NEEDLE终");
    let body = rpc(
        &mut server,
        83,
        "migration/history/text",
        json!({"jobId":job,"record":found["position"],"blockIndex":found["block"]["index"],"cursor":found["bodyCursor"]}),
    );
    assert!(body["text"].as_str().unwrap().contains("LATE_NEEDLE终"));
    let paged = find(&mut server, &job, "paged_needle", Value::Null);
    let mut result = paged;
    while result["items"].as_array().unwrap().is_empty() {
        result = find(
            &mut server,
            &job,
            "paged_needle",
            result["nextCursor"].clone(),
        );
    }
    assert_eq!(result["items"].as_array().unwrap().len(), 10);
    let next = find(
        &mut server,
        &job,
        "paged_needle",
        result["nextCursor"].clone(),
    );
    assert_eq!(next["items"].as_array().unwrap().len(), 2);
    server.send(json!({"jsonrpc":"2.0","id":84,"method":"migration/history/search","params":{"jobId":job,"viewId":null,"query":"different","caseSensitive":false,"cursor":first["nextCursor"],"limit":10}}));
    assert!(server.response(84).get("error").is_some());
    let mut second_connection = fixture.start();
    second_connection.send(json!({"jsonrpc":"2.0","id":85,"method":"migration/history/search","params":{"jobId":job,"query":"late_needle终","cursor":first["nextCursor"]}}));
    assert!(second_connection.response(85).get("error").is_some());
    assert_eq!(fs::read_to_string(file).unwrap(), original);
}

#[test]
fn structured_tool_text_is_decoded_and_signed_body_reads_do_not_include_attachment_or_opaque_data()
{
    let fixture = Fixture::new();
    let file = fixture.source(0);
    let session = file.file_stem().unwrap().to_str().unwrap();
    let record = json!({"type":"user","uuid":"one","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":[{"type":"image","source":{"type":"base64","data":"BINARY_CANARY"}},{"type":"text","text":"中文 😀"},{"type":"redacted_thinking","data":"OPAQUE_CANARY"}]}]}});
    let original = (record.to_string() + "\n").replace("中文 😀", r"\u4e2d\u6587 \ud83d\ude00");
    fs::write(&file, &original).unwrap();
    let (mut server, job) = archived(&fixture);
    let result = find(&mut server, &job, "中文 😀", Value::Null);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert!(!result.to_string().contains("BINARY_CANARY"));
    assert!(!result.to_string().contains("OPAQUE_CANARY"));
    let hit = &result["items"][0];
    let body = rpc(
        &mut server,
        90,
        "migration/history/text",
        json!({"jobId":job,"record":hit["position"],"blockIndex":hit["block"]["index"],"cursor":hit["bodyCursor"]}),
    );
    assert_eq!(body["text"], "中文 😀");
    for query in ["BINARY_CANARY", "OPAQUE_CANARY"] {
        assert!(
            find(&mut server, &job, query, Value::Null)["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(fs::read_to_string(file).unwrap(), original);
}
