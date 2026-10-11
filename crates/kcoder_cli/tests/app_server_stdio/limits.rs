#[test]
fn invalid_utf8_stdio_frame_is_rejected_without_stopping_the_server() {
// Validate transport recovery without depending on model output.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    server.write_raw(b"\xff\n");
    let error = server.next_value(Instant::now() + Duration::from_secs(5));
    assert_eq!(error["id"], Value::Null);
    assert_eq!(error["error"]["code"], -32700);
    assert_eq!(server.initialize(1)["result"]["protocolVersion"], "2026-07-27");
    server.write_raw(b"\xc3\r\n");
    let error = server.next_value(Instant::now() + Duration::from_secs(5));
    assert_eq!(error["error"]["code"], -32700);
    server.shutdown();
}

#[test]
fn oversized_stdio_request_is_rejected_and_the_next_frame_remains_usable() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    let mut request = vec![b'x'; 2 * 1024 * 1024 + 1];
    request.push(b'\n');
    server.write_raw(&request);
    let error = server.next_value(Instant::now() + Duration::from_secs(5));
    assert_eq!(error["id"], Value::Null);
    assert_eq!(error["error"]["code"], -32600);

    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["protocolVersion"], "2026-07-27");
    server.shutdown();
}
