//! Real CLI subprocesses test the public HTTP boundary; this fixture is not a Native transfer.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const TOKEN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const REQUEST: &str = "11111111-1111-4111-8111-111111111111";

struct Fixture {
    root: tempfile::TempDir,
    input: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("request.json");
        Self { root, input }
    }
    fn invoke(&self, endpoint: &str, args: &[&str]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kcoder"))
            .args([
                "migrate",
                "transfer",
                "--gateway",
                endpoint,
                "--access-token-env",
                "OWNED_TRANSFER_ACCESS",
            ])
            .args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("OWNED_TRANSFER_ACCESS", TOKEN)
            .current_dir(self.root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if child.try_wait().unwrap().is_some() {
                return child.wait_with_output().unwrap();
            }
            if Instant::now() > deadline {
                child.kill().unwrap();
                let _ = child.wait();
                panic!("owned terminal transfer timed out")
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn request(&self, value: Value) {
        std::fs::write(&self.input, value.to_string()).unwrap();
    }
}
fn target() -> Value {
    json!({"sessionId":"22222222-2222-4222-8222-222222222222","purpose":"target_recovery","targetId":"owned-target"})
}

#[test]
fn terminal_transfer_requires_explicit_mutation_consent_and_rejects_private_or_oversized_requests_without_network()
 {
    let f = Fixture::new();
    f.request(json!({"requestId":REQUEST,"target":target(),"attemptId":REQUEST}));
    let path = f.input.to_str().unwrap();
    let no = f.invoke(
        "http://127.0.0.1:9",
        &["copy", "target-finish", "--input", path],
    );
    assert!(!no.status.success());
    assert!(String::from_utf8_lossy(&no.stderr).contains("source_transfer_confirmation_required"));
    f.request(json!({"requestId":REQUEST,"target":target(),"kcoderPrivateMigrationSource":{"secret":"NEVER_ECHO_PRIVATE_INPUT"}}));
    let invalid = f.invoke(
        "http://127.0.0.1:9",
        &["copy", "target-read", "--input", path],
    );
    assert!(!invalid.status.success());
    let error = String::from_utf8_lossy(&invalid.stderr);
    assert!(error.contains("source_transfer_invalid_request"));
    assert!(!error.contains("NEVER_ECHO_PRIVATE_INPUT"));
    std::fs::write(&f.input, vec![b'x'; 64 * 1024 + 1]).unwrap();
    let oversized = f.invoke(
        "http://127.0.0.1:9",
        &["copy", "target-read", "--input", path],
    );
    assert!(
        String::from_utf8_lossy(&oversized.stderr)
            .contains("source_transfer_request_budget_exceeded")
    );
    assert!(
        !f.root.path().join(".config").exists(),
        "transfer never bootstraps a local Agent profile"
    );
}

#[test]
fn terminal_transfer_selection_queries_require_confirmation_before_any_network_request() {
    let f = Fixture::new();
    let source = json!({"sessionId":REQUEST,"purpose":"source","targetId":"owned-source"});
    for query in [
        json!({"kind":"directory_select","params":{"selectionId":REQUEST,"source":"codex","directory":"/owned-explicit-codex-root"}}),
        json!({"kind":"codex_layers_select","params":{"sourceId":"src-owned-config","includeProject":true}}),
    ] {
        f.request(json!({"session":source,"query":query}));
        let output = f.invoke(
            "http://127.0.0.1:9",
            &["query", "--input", f.input.to_str().unwrap()],
        );
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("source_transfer_confirmation_required")
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("owned-explicit-codex-root"));
    }
    assert!(!f.root.path().join(".config").exists());
}

#[test]
fn terminal_transfer_http_uses_existing_bearer_does_not_follow_redirects_and_rejects_cross_request_observation()
 {
    let f = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for index in 0..4 {
            let deadline = Instant::now() + Duration::from_secs(15);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(stream) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("owned fixture accept: {e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let mut authorization = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("authorization") {
                        authorization = value.trim().into()
                    }
                    if key.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse::<usize>().unwrap()
                    }
                }
            }
            assert_eq!(authorization, format!("Bearer {TOKEN}"));
            assert!(length <= 64 * 1024);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            requests.push((first.trim().to_owned(), body));
            let (status,extra,body)=match index {
                0=>("200 OK","",json!({"requestId":REQUEST,"coordinatorState":"idle","observation":"unobserved","result":null,"progress":null,"errorCode":null}).to_string()),
                1=>("200 OK","",json!({"requestId":"33333333-3333-4333-8333-333333333333","coordinatorState":"idle","observation":"unobserved","result":null,"progress":null,"errorCode":null}).to_string()),
                2=>("302 Found","Location: http://127.0.0.1:9/NEVER_FOLLOW\r\n","{}".into()),
                _=>("403 Forbidden","","{\"error\":\"NEVER_ECHO_SERVER_SECRET\"}".into())};
            write!(stream,"HTTP/1.1 {status}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    });
    f.request(json!({"requestId":REQUEST,"target":target()}));
    let args = ["copy", "target-read", "--input", f.input.to_str().unwrap()];
    let accepted = f.invoke(&base, &args);
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let result: Value = serde_json::from_slice(&accepted.stdout).unwrap();
    assert_eq!(result["result"], Value::Null, "unknown is never Ready");
    let mismatch = f.invoke(&base, &args);
    assert!(String::from_utf8_lossy(&mismatch.stderr).contains("source_transfer_invalid_response"));
    assert!(mismatch.stdout.is_empty());
    let redirect = f.invoke(&base, &args);
    assert!(!redirect.status.success());
    assert!(String::from_utf8_lossy(&redirect.stderr).contains("source_transfer_outcome_unknown"));
    let forbidden = f.invoke(&base, &args);
    assert!(!forbidden.status.success());
    assert!(!String::from_utf8_lossy(&forbidden.stderr).contains("NEVER_ECHO_SERVER_SECRET"));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests
            .iter()
            .all(|(line, _)| line == "POST /api/migration/source-transfer/target-read HTTP/1.1")
    );
}

#[path = "transfer_cli/plugins.rs"]
mod plugins;
