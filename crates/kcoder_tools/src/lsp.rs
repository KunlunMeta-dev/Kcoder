use crate::ToolContext;
use html_escape::{encode_double_quoted_attribute, encode_text};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tracing::{debug, info};
use url::Url;

const ENV_ENABLED: &str = "KCODER_LSP_ENABLED";
const ENV_REPORT_CLEAN: &str = "KCODER_LSP_REPORT_CLEAN";
const ENV_TIMEOUT_MS: &str = "KCODER_LSP_TIMEOUT_MS";
const ENV_PYRIGHT_COMMAND: &str = "KCODER_LSP_PYRIGHT_COMMAND";
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const LSP_SHUTDOWN_GRACE_MS: u64 = 750;
const MAX_DIAGNOSTICS_PER_FILE: usize = 20;
const MAX_DIAGNOSTICS_CHARS: usize = 4_000;

#[derive(Debug, Clone)]
pub struct LspBaseline {
    server: LspServer,
    diagnostics: Vec<LspDiagnostic>,
}

#[derive(Debug, Clone)]
struct LspServer {
    id: &'static str,
    command: Vec<String>,
    workspace_root: PathBuf,
    language_id: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct LspDiagnostic {
    line: u64,
    character: u64,
    severity: u64,
    message: String,
    code: String,
    source: String,
}

pub async fn snapshot_baseline(
    ctx: &ToolContext,
    path: &Path,
    content: Option<&str>,
) -> Option<LspBaseline> {
    if !lsp_enabled() {
        return None;
    }
    let server = server_for_file(path, &ctx.state.cwd())?;
    let diagnostics = match content {
        Some(content) if !content.is_empty() => {
            diagnostics_for_content(path, content.to_string(), server.clone()).await
        }
        _ => Ok(Vec::new()),
    };
    match diagnostics {
        Ok(diagnostics) => Some(LspBaseline {
            server,
            diagnostics,
        }),
        Err(error) => {
            debug!(
                file = %path.display(),
                error = %error,
                "lsp baseline snapshot failed"
            );
            None
        }
    }
}

pub async fn append_post_write_diagnostics(
    mut text: String,
    path: &Path,
    baseline: Option<LspBaseline>,
    new_content: &str,
) -> String {
    let Some(baseline) = baseline else {
        return text;
    };

    match diagnostics_for_content(path, new_content.to_string(), baseline.server.clone()).await {
        Ok(after) => {
            let new_diagnostics = diagnostics_delta(&baseline.diagnostics, &after);
            let report = format_diagnostics_report(path, &baseline.server, &new_diagnostics)
                .or_else(|| {
                    report_clean_enabled()
                        .then(|| format_clean_report(path, &baseline.server, after.len()))
                });
            if let Some(report) = report {
                text.push_str("\n\n");
                text.push_str(&report);
            }
        }
        Err(error) => {
            debug!(
                file = %path.display(),
                server = baseline.server.id,
                error = %error,
                "lsp post-write diagnostics failed"
            );
        }
    }

    text
}

fn lsp_enabled() -> bool {
    match std::env::var(ENV_ENABLED) {
        Ok(value) => truthy(&value),
        Err(_) => true,
    }
}

fn report_clean_enabled() -> bool {
    std::env::var(ENV_REPORT_CLEAN)
        .ok()
        .is_some_and(|value| truthy(&value))
}

fn truthy(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value != "0"
        && !value.eq_ignore_ascii_case("false")
        && !value.eq_ignore_ascii_case("off")
        && !value.eq_ignore_ascii_case("no")
}

fn timeout() -> Duration {
    let millis = std::env::var(ENV_TIMEOUT_MS)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 250)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(millis)
}

fn server_for_file(path: &Path, cwd: &Path) -> Option<LspServer> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ext != "py" && ext != "pyi" {
        return None;
    }

    let command = pyright_command()?;
    Some(LspServer {
        id: "pyright",
        command,
        workspace_root: resolve_workspace_root(path, cwd),
        language_id: "python",
    })
}

fn pyright_command() -> Option<Vec<String>> {
    if let Ok(command) = std::env::var(ENV_PYRIGHT_COMMAND)
        && !command.trim().is_empty()
    {
        return Some(vec![command]);
    }
    which::which("pyright-langserver")
        .ok()
        .map(|path| vec![path.to_string_lossy().into_owned(), "--stdio".to_string()])
}

fn resolve_workspace_root(path: &Path, cwd: &Path) -> PathBuf {
    let start = path.parent().unwrap_or(cwd);
    for ancestor in start.ancestors() {
        if ancestor.join("pyproject.toml").exists()
            || ancestor.join("setup.py").exists()
            || ancestor.join(".git").exists()
        {
            return ancestor.to_path_buf();
        }
    }
    cwd.to_path_buf()
}

async fn diagnostics_for_content(
    path: &Path,
    content: String,
    server: LspServer,
) -> Result<Vec<LspDiagnostic>, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || run_lsp_once(&path, &content, &server))
        .await
        .map_err(|error| format!("lsp task join failed: {error}"))?
}

fn run_lsp_once(
    path: &Path,
    content: &str,
    server: &LspServer,
) -> Result<Vec<LspDiagnostic>, String> {
    if server.command.is_empty() {
        return Err("empty LSP command".to_string());
    }

    info!(
        server = server.id,
        file = %path.display(),
        workspace = %server.workspace_root.display(),
        "lsp diagnostics start"
    );

    let mut command = Command::new(&server.command[0]);
    command.args(&server.command[1..]);
    command.current_dir(&server.workspace_root);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", server.command[0]))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open LSP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open LSP stdout".to_string())?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    let reader_handle = std::thread::spawn(move || read_lsp_messages(stdout, tx));
    let stderr_handle = stderr.map(|stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut text);
            if !text.trim().is_empty() {
                debug!(stderr = %text.trim(), "lsp stderr");
            }
        })
    });

    let protocol_result = (|| -> Result<Vec<LspDiagnostic>, String> {
        let mut request_id = 1u64;
        write_lsp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "initialize",
                "params": {
                    "processId": std::process::id(),
                    "rootPath": server.workspace_root.to_string_lossy(),
                    "rootUri": file_uri(&server.workspace_root)?,
                    "capabilities": {
                        "textDocument": {
                            "publishDiagnostics": {
                                "relatedInformation": true,
                                "versionSupport": true
                            }
                        },
                        "workspace": {
                            "workspaceFolders": true,
                            "configuration": false
                        }
                    },
                    "workspaceFolders": [{
                        "uri": file_uri(&server.workspace_root)?,
                        "name": server
                            .workspace_root
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("workspace")
                    }]
                }
            }),
        )?;

        wait_for_response(&rx, request_id, timeout())?;
        write_lsp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "initialized",
                "params": {}
            }),
        )?;

        let file_uri = file_uri(path)?;
        write_lsp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": file_uri,
                        "languageId": server.language_id,
                        "version": 1,
                        "text": content
                    }
                }
            }),
        )?;

        let diagnostics = wait_for_diagnostics(&rx, &mut stdin, &file_uri, timeout())?;

        request_id += 1;
        let _ = write_lsp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "shutdown",
                "params": null
            }),
        );
        let _ = write_lsp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "exit",
                "params": null
            }),
        );
        Ok(diagnostics)
    })();

    drop(stdin);
    finish_lsp_child(&mut child, protocol_result.is_ok());
    let _ = reader_handle.join();
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    let diagnostics = protocol_result?;

    info!(
        server = server.id,
        file = %path.display(),
        diagnostics = diagnostics.len(),
        "lsp diagnostics complete"
    );
    Ok(diagnostics)
}

fn finish_lsp_child(child: &mut std::process::Child, allow_graceful_exit: bool) {
    if allow_graceful_exit {
        let deadline = Instant::now() + Duration::from_millis(LSP_SHUTDOWN_GRACE_MS);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) | Err(_) => break,
            }
        }
    }

    #[cfg(windows)]
    {
        // npm-installed language servers are commonly launched through a
        // `.cmd` shim. Kill the complete shim tree so its node.exe child does
        // not survive an initialization or protocol failure.
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn write_lsp_message(stdin: &mut impl Write, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|error| error.to_string())?;
    stdin.write_all(&body).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn read_lsp_messages(stdout: impl Read, tx: mpsc::Sender<Result<Value, String>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_lsp_message(&mut reader) {
            Ok(Some(value)) => {
                if tx.send(Ok(value)).is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(error) => {
                let _ = tx.send(Err(error));
                return;
            }
        }
    }
}

fn read_lsp_message(reader: &mut BufReader<impl Read>) -> Result<Option<Value>, String> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|error| format!("invalid Content-Length: {error}"))?,
            );
        }
    }
    let length = content_length.ok_or_else(|| "missing Content-Length".to_string())?;
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        format!(
            "invalid LSP JSON: {error}; body={}",
            String::from_utf8_lossy(&body)
        )
    })
}

fn wait_for_response(
    rx: &mpsc::Receiver<Result<Value, String>>,
    request_id: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(format!("timed out waiting for response id {request_id}"));
        };
        let value = rx
            .recv_timeout(remaining)
            .map_err(|_| format!("timed out waiting for response id {request_id}"))??;
        if value.get("id").and_then(Value::as_u64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("LSP response error: {error}"));
            }
            return Ok(());
        }
    }
}

fn wait_for_diagnostics(
    rx: &mpsc::Receiver<Result<Value, String>>,
    writer: &mut impl Write,
    file_uri: &str,
    timeout: Duration,
) -> Result<Vec<LspDiagnostic>, String> {
    let deadline = Instant::now() + timeout;
    let mut latest: Option<Vec<LspDiagnostic>> = None;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(latest.unwrap_or_default());
        };
        match rx.recv_timeout(remaining.min(Duration::from_millis(300))) {
            Ok(Ok(value)) => {
                respond_to_server_request(writer, &value)?;
                if value.get("method").and_then(Value::as_str)
                    == Some("textDocument/publishDiagnostics")
                {
                    let params = value.get("params").unwrap_or(&Value::Null);
                    if params
                        .get("uri")
                        .and_then(Value::as_str)
                        .is_some_and(|published_uri| file_uris_match(published_uri, file_uri))
                    {
                        latest = Some(parse_diagnostics(params));
                    }
                }
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout)
                if latest
                    .as_ref()
                    .is_some_and(|diagnostics| !diagnostics.is_empty()) =>
            {
                return Ok(latest.unwrap_or_default());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(latest.unwrap_or_default()),
        }
    }
}

fn file_uris_match(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let (Ok(left), Ok(right)) = (Url::parse(left), Url::parse(right)) else {
        return false;
    };
    let (Ok(left), Ok(right)) = (left.to_file_path(), right.to_file_path()) else {
        return false;
    };
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .replace('\\', "/")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn respond_to_server_request(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let Some(id) = value.get("id") else {
        return Ok(());
    };
    if value.get("method").and_then(Value::as_str).is_none() {
        return Ok(());
    }
    let result = if value.get("method").and_then(Value::as_str) == Some("workspace/configuration") {
        let item_count = value
            .pointer("/params/items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        Value::Array(vec![Value::Null; item_count])
    } else {
        Value::Null
    };
    write_lsp_message(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }),
    )
}

fn parse_diagnostics(params: &Value) -> Vec<LspDiagnostic> {
    params
        .get("diagnostics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|diagnostic| {
            let start = diagnostic
                .get("range")?
                .get("start")
                .unwrap_or(&Value::Null);
            Some(LspDiagnostic {
                line: start.get("line").and_then(Value::as_u64).unwrap_or(0),
                character: start.get("character").and_then(Value::as_u64).unwrap_or(0),
                severity: diagnostic
                    .get("severity")
                    .and_then(Value::as_u64)
                    .unwrap_or(1),
                message: diagnostic
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                code: diagnostic
                    .get("code")
                    .map(|code| match code {
                        Value::String(value) => value.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default(),
                source: diagnostic
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn diagnostics_delta(before: &[LspDiagnostic], after: &[LspDiagnostic]) -> Vec<LspDiagnostic> {
    // Line numbers shift when text is inserted above an unchanged
    // diagnostic; an exact-struct diff then reports stale diagnostics as new
    // (and swallows genuinely new ones sharing a position). Compare on
    // diagnostic identity instead of coordinates.
    fn key(d: &LspDiagnostic) -> (u64, String, String, String) {
        (
            d.severity,
            d.code.clone(),
            d.message.clone(),
            d.source.clone(),
        )
    }
    // Preserve multiplicity. A file may legitimately contain the same
    // diagnostic at multiple locations; a HashSet would hide a newly added
    // second occurrence merely because one identical occurrence existed
    // before the edit.
    let mut before_counts = HashMap::new();
    for diagnostic in before {
        *before_counts.entry(key(diagnostic)).or_insert(0usize) += 1;
    }
    after
        .iter()
        .filter(|diagnostic| {
            let remaining = before_counts.entry(key(diagnostic)).or_insert(0);
            if *remaining == 0 {
                true
            } else {
                *remaining -= 1;
                false
            }
        })
        .cloned()
        .collect()
}

fn format_diagnostics_report(
    path: &Path,
    server: &LspServer,
    diagnostics: &[LspDiagnostic],
) -> Option<String> {
    let error_diagnostics = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == 1)
        .collect::<Vec<_>>();
    if error_diagnostics.is_empty() {
        return None;
    }
    let hidden_count = error_diagnostics
        .len()
        .saturating_sub(MAX_DIAGNOSTICS_PER_FILE);
    let diagnostics = error_diagnostics
        .into_iter()
        .take(MAX_DIAGNOSTICS_PER_FILE)
        .collect::<Vec<_>>();

    let file_text = path.to_string_lossy();
    let mut output = format!(
        "<diagnostics source=\"lsp\" server=\"{}\" file=\"{}\">\n",
        encode_double_quoted_attribute(server.id),
        encode_double_quoted_attribute(file_text.as_ref())
    );
    for diagnostic in diagnostics {
        let code = if diagnostic.code.trim().is_empty() {
            String::new()
        } else {
            format!(" [{}]", sanitize_field(&diagnostic.code, 80))
        };
        let source = if diagnostic.source.trim().is_empty() {
            String::new()
        } else {
            format!(" ({})", sanitize_field(&diagnostic.source, 80))
        };
        output.push_str(&format!(
            "ERROR [{}:{}] {}{}{}\n",
            diagnostic.line + 1,
            diagnostic.character + 1,
            sanitize_field(&diagnostic.message, 300),
            code,
            source
        ));
    }
    if hidden_count > 0 {
        output.push_str(&format!("... and {hidden_count} more\n"));
    }
    output.push_str("</diagnostics>");
    Some(truncate_report(output))
}

fn format_clean_report(path: &Path, server: &LspServer, total_diagnostics: usize) -> String {
    let file_text = path.to_string_lossy();
    let warning_note = if total_diagnostics == 0 {
        "No diagnostics were published."
    } else {
        "No new error diagnostics were published."
    };
    format!(
        "<diagnostics source=\"lsp\" server=\"{}\" file=\"{}\" status=\"no-new-errors\">\n{}\n</diagnostics>",
        encode_double_quoted_attribute(server.id),
        encode_double_quoted_attribute(file_text.as_ref()),
        warning_note
    )
}

fn sanitize_field(value: &str, limit: usize) -> String {
    let collapsed = value
        .replace(['\r', '\n'], " ")
        .chars()
        .filter(|ch| *ch == ' ' || ch.is_ascii_graphic() || !ch.is_control())
        .take(limit)
        .collect::<String>();
    encode_text(collapsed.trim()).to_string()
}

fn truncate_report(mut value: String) -> String {
    if value.len() <= MAX_DIAGNOSTICS_CHARS {
        return value;
    }
    let marker = "\n...[truncated]\n</diagnostics>";
    value.truncate(MAX_DIAGNOSTICS_CHARS.saturating_sub(marker.len()));
    value.push_str(marker);
    value
}

fn file_uri(path: &Path) -> Result<String, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    Url::from_file_path(&absolute)
        .map(|url| url.to_string())
        .map_err(|_| format!("failed to convert path to file URI: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_delta_filters_existing_diagnostics() {
        let old = LspDiagnostic {
            line: 1,
            character: 2,
            severity: 1,
            message: "old".to_string(),
            code: "x".to_string(),
            source: "pyright".to_string(),
        };
        let new = LspDiagnostic {
            line: 3,
            character: 4,
            severity: 1,
            message: "new".to_string(),
            code: "y".to_string(),
            source: "pyright".to_string(),
        };

        assert_eq!(
            diagnostics_delta(std::slice::from_ref(&old), &[old.clone(), new.clone()]),
            vec![new]
        );
    }

    #[test]
    fn server_requests_receive_protocol_responses() {
        let mut output = Vec::new();
        respond_to_server_request(
            &mut output,
            &json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "workspace/configuration",
                "params": {"items": [{"section": "python"}, {"section": "python.analysis"}]}
            }),
        )
        .unwrap();

        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("Content-Length:"));
        assert!(text.contains(r#""id":7"#));
        assert!(text.contains(r#""result":[null,null]"#));
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_uri_matching_ignores_drive_case_and_uri_colon_encoding() {
        assert!(file_uris_match(
            "file:///d%3A/work/%E8%AF%8A%E6%96%AD%20fixture/lsp_case.py",
            "file:///D:/work/%E8%AF%8A%E6%96%AD%20fixture/lsp_case.py"
        ));
    }

    #[test]
    fn diagnostics_report_escapes_lsp_text() {
        let server = LspServer {
            id: "pyright",
            command: vec!["pyright-langserver".to_string(), "--stdio".to_string()],
            workspace_root: PathBuf::from("/repo"),
            language_id: "python",
        };
        let diagnostic = LspDiagnostic {
            line: 0,
            character: 1,
            severity: 1,
            message: "bad </diagnostics>\n\"quoted\" next".to_string(),
            code: "report<bad>".to_string(),
            source: "pyright".to_string(),
        };

        let report =
            format_diagnostics_report(Path::new("/repo/a.py"), &server, &[diagnostic]).unwrap();

        assert!(report.contains("<diagnostics source=\"lsp\" server=\"pyright\""));
        assert!(report.contains("ERROR [1:2]"));
        assert!(report.contains("&lt;/diagnostics&gt;"));
        assert!(report.contains("\"quoted\" next"));
        assert!(!report.contains("&quot;quoted&quot;"));
        assert!(!report.contains("bad </diagnostics>"));
    }

    #[test]
    fn clean_report_marks_lsp_success_without_errors() {
        let server = LspServer {
            id: "pyright",
            command: vec!["pyright-langserver".to_string(), "--stdio".to_string()],
            workspace_root: PathBuf::from("/repo"),
            language_id: "python",
        };

        let report = format_clean_report(Path::new("/repo/a.py"), &server, 0);

        assert!(report.contains("<diagnostics source=\"lsp\" server=\"pyright\""));
        assert!(report.contains("status=\"no-new-errors\""));
        assert!(report.contains("No diagnostics were published."));
        assert!(report.ends_with("</diagnostics>"));
    }

    #[test]
    fn false_env_values_disable_lsp() {
        assert!(!truthy("0"));
        assert!(!truthy("false"));
        assert!(truthy("1"));
    }

    #[test]
    fn failed_lsp_session_terminates_and_reaps_child() {
        #[cfg(unix)]
        let mut command = Command::new("sleep");
        #[cfg(unix)]
        command.arg("30");

        #[cfg(windows)]
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);

        let mut child = command.spawn().expect("spawn long-running child");
        let started = Instant::now();
        finish_lsp_child(&mut child, false);

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "failed LSP cleanup should not wait for the child command"
        );
        assert!(
            child.try_wait().expect("query child status").is_some(),
            "failed LSP child should be reaped"
        );
    }

    fn diag(line: u64, message: &str) -> LspDiagnostic {
        LspDiagnostic {
            line,
            character: 0,
            severity: 1,
            message: message.to_string(),
            code: String::new(),
            source: "pyright".to_string(),
        }
    }

    #[test]
    fn diagnostics_delta_ignores_line_shifts_for_unchanged_diagnostics() {
        let before = vec![diag(10, "unused variable")];
        // Same diagnostic shifted down by an edit above it: not a new error.
        let shifted = vec![diag(13, "unused variable")];
        assert!(
            diagnostics_delta(&before, &shifted).is_empty(),
            "line-shifted diagnostics must not be reported as new"
        );

        // A genuinely new diagnostic (different message) is reported.
        let with_new = vec![diag(13, "unused variable"), diag(20, "type mismatch")];
        let delta = diagnostics_delta(&before, &with_new);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].message, "type mismatch");
    }

    #[test]
    fn diagnostics_delta_preserves_new_duplicate_occurrences() {
        let before = vec![diag(10, "unused variable")];
        let after = vec![diag(13, "unused variable"), diag(20, "unused variable")];

        let delta = diagnostics_delta(&before, &after);

        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].line, 20);
    }
}
