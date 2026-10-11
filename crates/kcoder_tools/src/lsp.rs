use crate::ToolContext;
use crate::owned_process::{OwnedProcess, drain_prefix};
use html_escape::{encode_double_quoted_attribute, encode_text};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::Command;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};
use url::Url;

const ENV_ENABLED: &str = "KCODER_LSP_ENABLED";
const ENV_REPORT_CLEAN: &str = "KCODER_LSP_REPORT_CLEAN";
const ENV_TIMEOUT_MS: &str = "KCODER_LSP_TIMEOUT_MS";
const ENV_PYRIGHT_COMMAND: &str = "KCODER_LSP_PYRIGHT_COMMAND";
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_LSP_HEADER_BYTES: usize = 8 * 1024;
const MAX_LSP_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_LSP_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_LSP_MESSAGES: usize = 1024;
const MAX_LSP_STDERR_BYTES: usize = 4096;
const MAX_DIAGNOSTICS_PER_FILE: usize = 20;
const MAX_DIAGNOSTICS_CHARS: usize = 4_000;

#[derive(Debug, Clone)]
pub struct LspBaseline {
    server: LspServer,
    diagnostics: Vec<LspDiagnostic>,
    cancel: CancellationToken,
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
    let cancel = ctx
        .abort_token
        .as_ref()
        .map(CancellationToken::child_token)
        .unwrap_or_default();
    let diagnostics = match content {
        Some(content) if !content.is_empty() => {
            diagnostics_for_content(path, content, server.clone(), &cancel).await
        }
        _ => Ok(Vec::new()),
    };
    match diagnostics {
        Ok(diagnostics) => Some(LspBaseline {
            server,
            diagnostics,
            cancel,
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

    match diagnostics_for_content(path, new_content, baseline.server.clone(), &baseline.cancel)
        .await
    {
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
    content: &str,
    server: LspServer,
    cancel: &CancellationToken,
) -> Result<Vec<LspDiagnostic>, String> {
    run_lsp_once(path, content, &server, cancel, timeout()).await
}

async fn run_lsp_once(
    path: &Path,
    content: &str,
    server: &LspServer,
    cancel: &CancellationToken,
    operation_timeout: Duration,
) -> Result<Vec<LspDiagnostic>, String> {
    if server.command.is_empty() {
        return Err("empty LSP command".to_string());
    }
    if cancel.is_cancelled() {
        return Err("LSP operation cancelled".to_string());
    }
    // JSON escaping can expand file text by six bytes per input byte.
    if content.len() > (MAX_LSP_BODY_BYTES - 4096) / 6 {
        return Err("LSP file content exceeds body limit".to_string());
    }
    info!(server = server.id, file = %path.display(), "lsp diagnostics start");
    let mut command = Command::new(&server.command[0]);
    command
        .args(&server.command[1..])
        .current_dir(&server.workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut owned = OwnedProcess::spawn(&mut command)
        .map_err(|error| format!("failed to spawn {}: {error}", server.command[0]))?;
    let mut stdin = owned.child.stdin.take().ok_or("failed to open LSP stdin")?;
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or("failed to open LSP stdout")?;
    let stderr = owned
        .child
        .stderr
        .take()
        .ok_or("failed to open LSP stderr")?;
    let mut reader = LspReader {
        stream: BufReader::new(stdout),
        messages: 0,
        bytes: 0,
    };
    let deadline = Instant::now() + operation_timeout;
    let work = async {
        let protocol = async {
            write_lsp_message(&mut stdin, &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "processId": std::process::id(),
                    "rootPath": server.workspace_root.to_string_lossy(),
                    "rootUri": file_uri(&server.workspace_root)?,
                    "capabilities": {
                        "textDocument": {"publishDiagnostics": {"relatedInformation": true, "versionSupport": true}},
                        "workspace": {"workspaceFolders": true, "configuration": false}
                    },
                    "workspaceFolders": [{"uri": file_uri(&server.workspace_root)?, "name": server.workspace_root.file_name().and_then(|s| s.to_str()).unwrap_or("workspace")}]
                }
            })).await?;
            wait_for_response(&mut reader, &mut stdin, 1).await?;
            write_lsp_message(
                &mut stdin,
                &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
            )
            .await?;
            let uri = file_uri(path)?;
            write_lsp_message(&mut stdin, &json!({
                "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
                    "textDocument": {"uri": uri, "languageId": server.language_id, "version": 1, "text": content}
                }
            })).await?;
            // Reserve time for shutdown writes inside the same operation deadline.
            let diagnostics = wait_for_diagnostics(
                &mut reader,
                &mut stdin,
                &uri,
                deadline - operation_timeout.min(Duration::from_millis(100)),
            )
            .await?;
            write_lsp_message(
                &mut stdin,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": null}),
            )
            .await?;
            write_lsp_message(
                &mut stdin,
                &json!({"jsonrpc": "2.0", "method": "exit", "params": null}),
            )
            .await?;
            stdin.shutdown().await.map_err(|error| error.to_string())?;
            drop(stdin);
            owned
                .child
                .wait()
                .await
                .map_err(|error| error.to_string())?;
            // The leader exiting does not release pipes inherited by its children.
            owned.terminate_group();
            Ok::<_, String>(diagnostics)
        };
        let diagnostic = async {
            drain_prefix(stderr, MAX_LSP_STDERR_BYTES)
                .await
                .map_err(|error| error.to_string())
        };
        let (diagnostics, stderr) = tokio::try_join!(protocol, diagnostic)?;
        if !stderr.is_empty() {
            debug!(stderr = %String::from_utf8_lossy(&stderr), "lsp stderr");
        }
        Ok::<_, String>(diagnostics)
    };
    let result = tokio::select! {
        result = tokio::time::timeout_at(deadline, work) => result.unwrap_or_else(|_| Err("LSP operation timed out".to_string())),
        _ = cancel.cancelled() => Err("LSP operation cancelled".to_string()),
    };
    owned
        .finish()
        .await
        .map_err(|error| format!("LSP cleanup failed: {error}"))?;
    let diagnostics = result?;
    info!(server = server.id, file = %path.display(), diagnostics = diagnostics.len(), "lsp diagnostics complete");
    Ok(diagnostics)
}

async fn write_lsp_message(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.len() > MAX_LSP_BODY_BYTES {
        return Err("LSP outgoing body limit exceeded".to_string());
    }
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&body)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

#[cfg(test)]
async fn read_lsp_message(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Option<Value>, String> {
    read_lsp_frame(reader, MAX_LSP_STREAM_BYTES)
        .await
        .map(|result| result.map(|(value, _)| value))
}

async fn read_lsp_frame(
    reader: &mut (impl AsyncBufRead + Unpin),
    remaining: usize,
) -> Result<Option<(Value, usize)>, String> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    loop {
        let mut line = Vec::new();
        loop {
            let chunk = reader.fill_buf().await.map_err(|error| error.to_string())?;
            if chunk.is_empty() {
                return if header_bytes == 0 {
                    Ok(None)
                } else {
                    Err("truncated LSP header".to_string())
                };
            }
            let take = chunk
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(chunk.len(), |index| index + 1);
            if take > MAX_LSP_HEADER_BYTES.saturating_sub(header_bytes) {
                return Err("LSP header limit exceeded".to_string());
            }
            let ended = chunk[take - 1] == b'\n';
            line.extend_from_slice(&chunk[..take]);
            header_bytes += take;
            reader.consume(take);
            if ended {
                break;
            }
        }
        let line = std::str::from_utf8(&line).map_err(|_| "invalid LSP header encoding")?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            if content_length.is_some() {
                return Err("duplicate Content-Length".to_string());
            }
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|error| format!("invalid Content-Length: {error}"))?;
            if length > MAX_LSP_BODY_BYTES {
                return Err("LSP body limit exceeded".to_string());
            }
            content_length = Some(length);
        }
    }
    let length = content_length.ok_or("missing Content-Length")?;
    if length > remaining.saturating_sub(header_bytes) {
        return Err("LSP stream budget exceeded".to_string());
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body)
        .map(|value| Some((value, header_bytes + length)))
        .map_err(|error| format!("invalid LSP JSON: {error}"))
}

struct LspReader<R> {
    stream: R,
    messages: usize,
    bytes: usize,
}
impl<R: AsyncBufRead + Unpin> LspReader<R> {
    async fn next(&mut self) -> Result<Option<Value>, String> {
        if self.messages >= MAX_LSP_MESSAGES || self.bytes >= MAX_LSP_STREAM_BYTES {
            return Err("LSP stream budget exceeded".to_string());
        }
        let frame = read_lsp_frame(&mut self.stream, MAX_LSP_STREAM_BYTES - self.bytes).await?;
        self.messages += 1;
        // No queue: retain only the current frame and the latest diagnostics.
        if let Some((value, bytes)) = frame {
            self.bytes += bytes;
            Ok(Some(value))
        } else {
            Ok(None)
        }
    }
}

async fn wait_for_response<R: AsyncBufRead + Unpin>(
    reader: &mut LspReader<R>,
    writer: &mut (impl AsyncWrite + Unpin),
    request_id: u64,
) -> Result<(), String> {
    loop {
        let value = reader
            .next()
            .await?
            .ok_or("LSP closed before initialization")?;
        respond_to_server_request(writer, &value).await?;
        if value.get("id").and_then(Value::as_u64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified error")
                    .chars()
                    .take(1024)
                    .collect::<String>();
                return Err(format!(
                    "LSP response error (code {:?}): {message}",
                    error.get("code").and_then(Value::as_i64)
                ));
            }
            return Ok(());
        }
    }
}

async fn wait_for_diagnostics<R: AsyncBufRead + Unpin>(
    reader: &mut LspReader<R>,
    writer: &mut (impl AsyncWrite + Unpin),
    uri: &str,
    deadline: Instant,
) -> Result<Vec<LspDiagnostic>, String> {
    let mut latest = None;
    loop {
        // A read future may have consumed a partial frame. Only end the entire
        // diagnostics phase at a quiet deadline; never restart a cancelled read.
        let quiet = latest
            .as_ref()
            .is_some_and(|d: &Vec<LspDiagnostic>| !d.is_empty());
        let read_deadline = if quiet {
            deadline.min(Instant::now() + Duration::from_millis(300))
        } else {
            deadline
        };
        let value = match tokio::time::timeout_at(read_deadline, reader.next()).await {
            Err(_) | Ok(Ok(None)) => return Ok(latest.unwrap_or_default()),
            Ok(result) => result?.unwrap(),
        };
        respond_to_server_request(writer, &value).await?;
        if value.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") {
            let params = value.get("params").unwrap_or(&Value::Null);
            if params
                .get("uri")
                .and_then(Value::as_str)
                .is_some_and(|published| file_uris_match(published, uri))
            {
                latest = Some(parse_diagnostics(params));
            }
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

async fn respond_to_server_request(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &Value,
) -> Result<(), String> {
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
    .await
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
    let mut end = MAX_DIAGNOSTICS_CHARS.saturating_sub(marker.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
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

    #[cfg(unix)]
    fn fixture_server(root: &Path, mode: &str) -> (LspServer, PathBuf) {
        let pid = root.join("server-pids");
        let script = root.join("fixture.py");
        std::fs::write(&script, r#"import json, os, subprocess, sys, time
mode, pid_path = sys.argv[1:]
child = subprocess.Popen(["sleep", "60"])
with open(pid_path, "w") as f:
    f.write(f"{os.getpid()} {child.pid}")
def read():
    length = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line: raise EOFError()
        if line.startswith(b"Content-Length:"): length = int(line.split(b":")[1])
        if line in (b"\r\n", b"\n"): break
    return json.loads(sys.stdin.buffer.read(length))
def send(value):
    body = json.dumps(value).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()
if mode == "hold": time.sleep(60)
read()
send({"jsonrpc":"2.0", "id":1, "result":{}})
if mode == "blocked-write":
    sys.stderr.buffer.write(b"x" * 1048576)
    sys.stderr.buffer.flush()
    time.sleep(60)
read()
opened = read()
send({"jsonrpc":"2.0", "method":"textDocument/publishDiagnostics", "params":{"uri":opened["params"]["textDocument"]["uri"], "diagnostics":[{"range":{"start":{"line":0,"character":0}},"message":"fixture error"}]}})
read()
read()
"#).unwrap();
        (
            LspServer {
                id: "fixture",
                command: vec![
                    "python3".to_string(),
                    script.to_string_lossy().into_owned(),
                    mode.to_string(),
                    pid.to_string_lossy().into_owned(),
                ],
                workspace_root: root.to_path_buf(),
                language_id: "python",
            },
            pid,
        )
    }

    #[cfg(unix)]
    async fn fixture_pids(path: &Path) -> Vec<u32> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(path).await {
                    let pids: Vec<u32> = text
                        .split_whitespace()
                        .filter_map(|p| p.parse().ok())
                        .collect();
                    if pids.len() == 2 {
                        break pids;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    #[cfg(target_os = "linux")]
    async fn assert_fixture_stopped(pids: &[u32]) {
        let running = |pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|s| {
                    s.rsplit_once(") ")
                        .map(|(_, fields)| !fields.starts_with('Z'))
                })
                .unwrap_or(false)
        };
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            while pids.iter().any(|pid| running(*pid)) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if result.is_err() {
            for pid in pids {
                unsafe {
                    libc::kill(*pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        assert!(
            result.is_ok(),
            "LSP process survived ownership cleanup: {pids:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn lsp_stdin_block_and_stderr_flood_obey_the_whole_operation_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let (server, pid_path) = fixture_server(tmp.path(), "blocked-write");
        let started = Instant::now();
        let result = run_lsp_once(
            &tmp.path().join("fixture.py"),
            &"x".repeat(1024 * 1024),
            &server,
            &CancellationToken::new(),
            Duration::from_millis(250),
        )
        .await;
        let pids = fixture_pids(&pid_path).await;
        assert_fixture_stopped(&pids).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn lsp_success_cleans_descendants_holding_both_pipes() {
        let tmp = tempfile::tempdir().unwrap();
        let (server, pid_path) = fixture_server(tmp.path(), "success");
        let result = run_lsp_once(
            &tmp.path().join("fixture.py"),
            "x",
            &server,
            &CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await;
        let pids = fixture_pids(&pid_path).await;
        assert_fixture_stopped(&pids).await;
        assert_eq!(result.unwrap().len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn lsp_context_cancel_and_dropped_future_stop_owned_processes() {
        for abort_future in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let (server, pid_path) = fixture_server(tmp.path(), "hold");
            let mut ctx = ToolContext::new(kcoder_state::AppState::new(tmp.path()));
            let cancel = CancellationToken::new();
            ctx.abort_token = Some(cancel.clone());
            let owned_cancel = ctx.abort_token.as_ref().unwrap().child_token();
            let path = tmp.path().join("fixture.py");
            let task = tokio::spawn(async move {
                run_lsp_once(&path, "x", &server, &owned_cancel, Duration::from_secs(30)).await
            });
            let pids = fixture_pids(&pid_path).await;
            if abort_future {
                task.abort();
                let _ = task.await;
            } else {
                cancel.cancel();
                assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
            }
            assert_fixture_stopped(&pids).await;
        }
    }

    #[tokio::test]
    async fn lsp_rejects_large_declared_body_before_reading_it() {
        let wire = b"Content-Length: 16777217\r\n\r\n";
        let error = read_lsp_message(&mut BufReader::new(&wire[..]))
            .await
            .unwrap_err();
        assert!(error.contains("body limit"), "{error}");
    }

    #[tokio::test]
    async fn lsp_rejects_large_header_before_reading_the_body() {
        let wire = format!("X-Padding: {}\r\n\r\n", "x".repeat(16384));
        let error = read_lsp_message(&mut BufReader::new(wire.as_bytes()))
            .await
            .unwrap_err();
        assert!(error.contains("header limit"), "{error}");
    }

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

    #[tokio::test]
    async fn server_requests_receive_protocol_responses() {
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
        .await
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

    #[tokio::test]
    async fn failed_lsp_session_terminates_and_reaps_child() {
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

        let mut owned = OwnedProcess::spawn(&mut command).expect("spawn long-running child");
        let started = Instant::now();
        owned.finish().await.unwrap();

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "failed LSP cleanup should not wait for the child command"
        );
        assert!(
            owned
                .child
                .try_wait()
                .expect("query child status")
                .is_some(),
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
