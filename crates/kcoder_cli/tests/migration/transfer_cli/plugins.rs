//! The real terminal decodes bounded plugin query results; this HTTP fixture does not install packages.
use super::*;
fn candidate(id: &str, source: &str) -> Value {
    json!({"candidateId":id,"source":source,"name":"owned-plugin","installedVersion":null,"scope":"user","sourceEnabled":false,"pending":[]})
}
#[test]
fn plugin_queries_preserve_the_source_session_cursor_and_reject_unbounded_duplicate_or_wrong_source_results()
 {
    let f = Fixture::new();
    let source = json!({"sessionId":REQUEST,"purpose":"source","targetId":"owned-source"});
    f.request(json!({"session":source,"query":{"kind":"plugins","params":{"sources":["claude-code"],"cursor":"owned-first-page"}}}));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let cases = vec![
            vec![candidate("plugin-owned", "claude-code")],
            (0..11)
                .map(|id| candidate(&format!("plugin-{id}"), "claude-code"))
                .collect::<Vec<_>>(),
            vec![
                candidate("same", "claude-code"),
                candidate("same", "claude-code"),
            ],
            vec![candidate("foreign", "codex")],
        ];
        for candidates in cases {
            let deadline = Instant::now() + Duration::from_secs(15);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(stream) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("owned plugin query fixture: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim(),
                "POST /api/migration/source-session/query HTTP/1.1"
            );
            let mut length = 0usize;
            let mut authorized = false;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                };
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("authorization") {
                        authorized = value.trim() == format!("Bearer {TOKEN}");
                    }
                    if key.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            assert!(authorized && length <= 64 * 1024);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["session"]["purpose"], "source");
            assert_eq!(body["query"]["kind"], "plugins");
            assert_eq!(body["query"]["params"]["cursor"], "owned-first-page");
            assert!(
                body["query"]["params"].get("includeProject").is_none(),
                "default false preserves the old plugin discovery shape"
            );
            let response =
                json!({"candidates":candidates,"nextCursor":null,"problems":[]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
    });
    for index in 0..4 {
        let output = f.invoke(&endpoint, &["query", "--input", f.input.to_str().unwrap()]);
        if index == 0 {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["candidates"][0]["candidateId"], "plugin-owned");
        } else {
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("source_transfer_invalid_response")
            );
        }
    }
    server.join().unwrap();
    let wrong_page = f.invoke(
        "http://127.0.0.1:9",
        &["query", "--input", f.input.to_str().unwrap(), "--page", "1"],
    );
    assert!(!wrong_page.status.success());
    assert!(
        String::from_utf8_lossy(&wrong_page.stderr).contains("source_transfer_use_plugin_cursor")
    );
    assert!(!f.root.path().join(".config").exists());
}
