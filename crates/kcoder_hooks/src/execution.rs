use crate::effects::process_hook_output;
use crate::matching::{matches_if_rule, matches_pattern};
use crate::redaction::{hook_bytes_preview, hook_text_preview};
use crate::types::{
    HookCommand, HookEffect, HookEvent, HookInput, HookMatcher, HookOutcome, HookResult,
    HookSource, HookSourceKind,
};
use futures::StreamExt;
use futures::future::join_all;
use kcoder_api::{AnthropicProvider, GeminiProvider, OpenAiProvider, Provider};
use kcoder_types::{ContentDelta, Message, MessagesRequest, StreamEvent};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{timeout, timeout_at};
use tracing::{debug, warn};

const SLOW_HOOK_WARNING_THRESHOLD: Duration = Duration::from_secs(1);
const MAX_HOOK_OUTPUT_BYTES: usize = 1024 * 1024;
const HOOK_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

/// Hook registry holding the active configuration snapshot.
#[derive(Debug, Clone, Default)]
pub struct HookRegistry {
    /// Hooks loaded from settings files.
    pub settings_hooks: Vec<(HookEvent, HookMatcher)>,
    /// Whether hooks are globally disabled.
    pub disabled: bool,
}

impl HookRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_settings(hooks: crate::config::HooksSettings) -> Self {
        Self::from_matchers(hooks.into_matchers())
    }

    pub fn from_matchers(matchers: Vec<(HookEvent, HookMatcher)>) -> Self {
        Self {
            settings_hooks: matchers,
            disabled: false,
        }
    }

    pub fn extend(&mut self, matchers: Vec<(HookEvent, HookMatcher)>) {
        self.settings_hooks.extend(matchers);
    }

    pub fn disable(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Remove hooks that implicitly call a model while retaining command and HTTP automation.
    pub fn without_model_calls(mut self) -> Self {
        for (_, matcher) in &mut self.settings_hooks {
            matcher.hooks.retain(|hook| {
                !matches!(hook, HookCommand::Prompt { .. } | HookCommand::Agent { .. })
            });
        }
        self.settings_hooks
            .retain(|(_, matcher)| !matcher.hooks.is_empty());
        self
    }
}

/// Execute all hooks matching the given input and yield each result.
///
/// This is a simplified port of the TypeScript `executeHooks()` async
/// generator. Matching hooks are spawned concurrently, and explicit async
/// command hooks detach after stdin/stdout/stderr plumbing is in place.
pub async fn execute_hooks(registry: &HookRegistry, input: HookInput) -> Vec<HookResult> {
    if registry.disabled {
        return Vec::new();
    }

    let matched: Vec<_> = registry
        .settings_hooks
        .iter()
        .filter(|(event, matcher)| {
            *event == input.event
                && matches_pattern(&input.query, matcher.matcher.as_deref().unwrap_or("*"))
        })
        .flat_map(|(_, matcher)| {
            matcher
                .hooks
                .iter()
                .filter(|hook| hook_matches_if_rule(&input, hook))
                .map(|hook| {
                    (
                        matcher.matcher.clone(),
                        matcher.source.clone(),
                        hook.clone(),
                    )
                })
        })
        .collect();

    if matched.is_empty() {
        return Vec::new();
    }

    debug!(
        "executing {} hook(s) for {}::{}",
        matched.len(),
        input.event.as_str(),
        hook_text_preview(&input.query)
    );

    let futures = matched.into_iter().map(|(matcher, source, hook)| {
        let input = input.clone();
        async move {
            let description = hook_description(&hook);
            let started_at = Instant::now();
            let outcome = execute_hook(&hook, &input, source.as_ref()).await;
            let elapsed = started_at.elapsed();
            if elapsed >= SLOW_HOOK_WARNING_THRESHOLD {
                warn!(
                    event = input.event.as_str(),
                    elapsed_ms = elapsed.as_millis(),
                    hook = %description,
                    "slow hook delayed tool execution"
                );
            }
            let matcher_label = matcher.as_deref().unwrap_or("*");
            HookResult {
                hook_description: format!(
                    "{}{} (matcher: {})",
                    description,
                    source_label(source.as_ref()),
                    hook_text_preview(matcher_label)
                ),
                outcome,
            }
        }
    });
    join_all(futures).await
}

pub(crate) fn hook_matches_if_rule(input: &HookInput, hook: &HookCommand) -> bool {
    match hook {
        HookCommand::Command { if_rule, .. } => if_rule
            .as_ref()
            .map(|rule| matches_if_rule(&input.query, &input.data, rule))
            .unwrap_or(true),
        _ => true,
    }
}

pub(crate) fn hook_description(hook: &HookCommand) -> String {
    match hook {
        HookCommand::Command { command, .. } => {
            format!("command: {}", hook_text_preview(command))
        }
        HookCommand::Prompt { prompt, .. } => format!("prompt: {}", hook_text_preview(prompt)),
        HookCommand::Agent { .. } => "agent".to_string(),
        HookCommand::Http { url, .. } => format!("http: {}", hook_text_preview(url)),
    }
}

pub(crate) fn source_label(source: Option<&HookSource>) -> String {
    source
        .map(|source| {
            format!(
                " from {} '{}'",
                source.kind.as_str(),
                hook_text_preview(&source.name)
            )
        })
        .unwrap_or_default()
}

pub(crate) async fn execute_hook(
    hook: &HookCommand,
    input: &HookInput,
    source: Option<&HookSource>,
) -> HookOutcome {
    if let Some(required) = source.and_then(|source| source.required_trust.as_ref()) {
        let trusted = kcoder_config::FolderTrustStore::trust_all_from_environment()
            || required.config_dir.as_ref().is_some_and(|config_dir| {
                kcoder_config::FolderTrustStore::load(config_dir).check(&required.directory)
                    == kcoder_config::FolderTrust::Trusted
            });
        if !trusted {
            return HookOutcome::Error(
                "hook directory trust was revoked; execution refused".to_owned(),
            );
        }
    }
    match hook {
        HookCommand::Command {
            shell,
            command,
            timeout: timeout_secs,
            async_hook,
            ..
        } => execute_command_hook(shell, command, *timeout_secs, *async_hook, input, source).await,
        HookCommand::Prompt {
            prompt,
            timeout,
            model,
        } => execute_llm_hook(prompt, input, *timeout, model.as_deref(), "prompt").await,
        HookCommand::Agent {
            instructions,
            timeout,
            model,
            ..
        } => execute_llm_hook(instructions, input, *timeout, model.as_deref(), "agent").await,
        HookCommand::Http {
            url,
            method,
            headers,
            timeout,
        } => execute_http_hook(url, method, headers, *timeout, input).await,
    }
}

async fn execute_command_hook(
    shell: &str,
    command: &str,
    timeout_secs: u64,
    async_hook: bool,
    input: &HookInput,
    source: Option<&HookSource>,
) -> HookOutcome {
    let Some(deadline) = tokio::time::Instant::now().checked_add(Duration::from_secs(timeout_secs))
    else {
        return HookOutcome::Error("hook timeout is too large".to_string());
    };
    let json_input = match serde_json::to_string(input) {
        Ok(s) => s,
        Err(e) => return HookOutcome::Error(format!("failed to serialize hook input: {}", e)),
    };
    let shell_program = resolve_hook_shell(shell);
    let mut command_builder = Command::new(&shell_program);
    let shell_name = shell_program
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_powershell = matches!(shell_name.as_str(), "powershell" | "pwsh");
    let template_mode = if is_powershell {
        TemplateMode::PowerShell
    } else {
        TemplateMode::Shell
    };
    let rendered_command = render_hook_template(command, input, template_mode, &json_input);
    if is_powershell {
        command_builder
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(powershell_utf8_command(&rendered_command));
    } else {
        command_builder.arg("-c").arg(&rendered_command);
    }
    #[cfg(not(windows))]
    command_builder
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("TERM", "xterm-256color");
    #[cfg(windows)]
    {
        command_builder.env_clear();
        for name in [
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "PATHEXT",
            "PATH",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
            "ALLUSERSPROFILE",
            "CommonProgramFiles",
            "CommonProgramFiles(x86)",
            "CommonProgramW6432",
            "LOCALAPPDATA",
            "PSModulePath",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command_builder.env(name, value);
            }
        }
    }
    #[cfg(windows)]
    if is_posix_shell(&shell_name) {
        // Non-login Git Bash hooks still need bash and the adjacent Unix utilities
        // when the Windows PATH only contains Git/cmd.
        match posix_hook_path(&shell_program, std::env::var_os("PATH")) {
            Ok(path) => {
                command_builder.env("PATH", path);
            }
            Err(_) => return HookOutcome::Error("failed to prepare hook shell PATH".into()),
        }
    }
    command_builder
        .env("SHELL", &shell_program)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KCODER_HOOK_EVENT", input.event.as_str())
        .env("KCODER_HOOK_QUERY", &input.query)
        .kill_on_drop(true);
    if let Some(source) = source.filter(|source| source.kind == HookSourceKind::Plugin) {
        // External plugins commonly use these variables to address their own files.
        // Provide all three names for compatibility with existing plugin conventions.
        let root = plugin_root_environment(&source.root, &shell_name, cfg!(windows));
        command_builder
            .env("CLAUDE_PLUGIN_ROOT", &root)
            .env("CODEX_PLUGIN_ROOT", &root)
            .env("PLUGIN_ROOT", &root);
    }
    #[cfg(unix)]
    command_builder.process_group(0);

    if let Some(cwd) = hook_working_dir(input) {
        command_builder.env("PWD", &cwd).current_dir(cwd);
    }

    let child = match command_builder.spawn() {
        Ok(c) => c,
        Err(e) => return HookOutcome::Error(format!("failed to spawn hook: {}", e)),
    };
    let process_tree = match child.id() {
        Some(pid) => HookProcessTreeTerminator::new(pid),
        None => return HookOutcome::Error("spawned hook has no process ID".to_string()),
    };

    // The three pipes and process share one owner and total deadline; cancelling the future closes pipes and terminates the process group.
    let execution = collect_command_hook_output(
        child,
        process_tree,
        json_input.into_bytes(),
        deadline,
        timeout_secs,
    );
    if async_hook {
        let runtime_guard = source.and_then(|source| source.runtime_guard.clone());
        tokio::spawn(async move {
            // Detached execution may outlive the conversation that dispatched it.
            let _runtime_guard = runtime_guard;
            let command = hook_text_preview(&rendered_command);
            match execution.await {
                Ok((status, stdout, stderr)) => debug!(
                    %command, %status,
                    stdout = %hook_bytes_preview(&stdout),
                    stderr = %hook_bytes_preview(&stderr),
                    "async hook finished"
                ),
                Err(error) => debug!(%command, %error, "async hook failed"),
            }
        });
        return HookOutcome::Effects(vec![crate::types::HookEffect::Message {
            text: "async hook started".to_string(),
            is_error: false,
        }]);
    }

    let (status, stdout, stderr) = match execution.await {
        Ok(output) => output,
        Err(error) => return HookOutcome::Error(error),
    };
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();

    if !status.success() {
        let output = if stderr.is_empty() { stdout } else { stderr };
        return HookOutcome::Error(format!(
            "hook exited with status {}: {}",
            format_hook_exit_status(&status),
            hook_text_preview(&output)
        ));
    }

    // A successful advisory hook may have nothing to report. Only non-empty
    // stdout needs a JSON payload; nonzero exits above remain failures.
    if stdout.trim().is_empty() {
        return HookOutcome::Effects(Vec::new());
    }

    // Preserve compatibility with first-line stdout markers while the same owner still finalizes process lifetime.
    if stdout.lines().next() == Some("{\"async\":true}") {
        return HookOutcome::Effects(vec![crate::types::HookEffect::Message {
            text: "async hook started".to_string(),
            is_error: false,
        }]);
    }

    // Try to parse the full stdout as JSON hook output.
    match serde_json::from_str::<crate::types::HookJSONOutput>(&stdout) {
        Ok(json_output) => HookOutcome::Effects(process_hook_output(json_output, &stdout)),
        Err(e) => {
            warn!(
                "hook produced invalid JSON output: {} (stdout: {})",
                e,
                hook_text_preview(&stdout)
            );
            HookOutcome::InvalidOutput(hook_text_preview(&stdout))
        }
    }
}

fn powershell_utf8_command(command: &str) -> String {
    format!(
        "$KCoderUtf8 = [System.Text.UTF8Encoding]::new($false); \
         [Console]::OutputEncoding = $KCoderUtf8; \
         $OutputEncoding = $KCoderUtf8; {command}"
    )
}

fn format_hook_exit_status(status: &std::process::ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("exit code: {code}"))
        .unwrap_or_else(|| status.to_string())
}

struct HookProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
}

impl HookProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            finished: AtomicBool::new(false),
        }
    }

    fn terminate(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            let pid = self.pid as libc::pid_t;
            // Leader exit does not imply descendant exit; terminate only the process group created for this run.
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

impl Drop for HookProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn collect_command_hook_output(
    mut child: tokio::process::Child,
    process_tree: HookProcessTreeTerminator,
    input: Vec<u8>,
    deadline: tokio::time::Instant,
    timeout_secs: u64,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut stdin = child.stdin.take().ok_or("hook stdin pipe is missing")?;
    let stdout = child.stdout.take().ok_or("hook stdout pipe is missing")?;
    let stderr = child.stderr.take().ok_or("hook stderr pipe is missing")?;
    let result = timeout_at(deadline, async {
        let write_input = async move {
            let result = async {
                stdin.write_all(&input).await?;
                stdin.shutdown().await
            }
            .await;
            // A hook may ignore stdin; all other I/O failures must return to the sole lifecycle owner.
            match result {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                Err(error) => Err(format!("hook stdin error: {error}")),
            }
        };
        tokio::try_join!(
            async {
                child
                    .wait()
                    .await
                    .map_err(|error| format!("hook process error: {error}"))
            },
            write_input,
            read_hook_output(stdout, "stdout"),
            read_hook_output(stderr, "stderr"),
        )
        .map(|(status, (), stdout, stderr)| (status, stdout, stderr))
    })
    .await
    .unwrap_or_else(|_| Err(format!("hook timed out after {timeout_secs} seconds")));

    // Clean descendants that retain or closed pipes even after the leader exits
    // successfully. The combined future above is gone, so finalization does not
    // depend on descendants cooperatively closing pipes.
    process_tree.terminate();
    match timeout(HOOK_CLEANUP_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => result,
        Ok(Err(error)) => Err(format!("hook failed to terminate cleanly: {error}")),
        Err(_) => Err("hook process cleanup timed out".to_string()),
    }
}

async fn read_hook_output(mut pipe: impl AsyncRead + Unpin, name: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .map_err(|error| format!("hook {name} read error: {error}"))?;
        if count == 0 {
            return Ok(output);
        }
        if count > MAX_HOOK_OUTPUT_BYTES.saturating_sub(output.len()) {
            return Err(format!(
                "hook {name} output exceeds {MAX_HOOK_OUTPUT_BYTES} bytes"
            ));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

async fn execute_http_hook(
    url: &str,
    method: &str,
    headers: &std::collections::HashMap<String, String>,
    timeout_secs: u64,
    input: &HookInput,
) -> HookOutcome {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
    {
        Ok(c) => c,
        Err(e) => return HookOutcome::Error(format!("failed to build http client: {}", e)),
    };

    let method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return HookOutcome::Error(format!("unsupported http method: {}", other)),
    };

    let body = match serde_json::to_vec(input) {
        Ok(b) => b,
        Err(e) => return HookOutcome::Error(format!("failed to serialize hook input: {}", e)),
    };

    let mut request = client.request(method, url).body(body);
    request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
    for (key, value) in headers {
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(key.as_bytes()) {
            request = request.header(name, value);
        } else {
            warn!("ignoring invalid http header name: {}", key);
        }
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return HookOutcome::Error(format!("http hook request failed: {}", e)),
    };

    let status = response.status();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => return HookOutcome::Error(format!("failed to read http hook response: {}", e)),
    };

    if !status.is_success() {
        return HookOutcome::Error(format!(
            "http hook returned status {}: {}",
            status,
            hook_text_preview(&text)
        ));
    }

    match serde_json::from_str::<crate::types::HookJSONOutput>(&text) {
        Ok(json_output) => HookOutcome::Effects(process_hook_output(json_output, &text)),
        Err(e) => {
            warn!(
                "http hook produced invalid JSON output: {} (body: {})",
                e,
                hook_text_preview(&text)
            );
            HookOutcome::InvalidOutput(hook_text_preview(&text))
        }
    }
}

const HOOK_SYSTEM_PROMPT: &str = r#"You are evaluating a lifecycle hook in KCoder.

Your response must be a JSON object with the following schema:
{"ok": true}

If the condition in the prompt is not met, return:
{"ok": false, "reason": "short reason why the condition is not met"}

Do not include any markdown formatting or additional keys."#;

#[derive(Debug, Clone, Copy)]
enum TemplateMode {
    Raw,
    Shell,
    PowerShell,
}

fn add_arguments_to_prompt(prompt: &str, input: &HookInput, arguments: &str) -> String {
    render_hook_template(prompt, input, TemplateMode::Raw, arguments)
}

fn render_hook_template(
    template: &str,
    input: &HookInput,
    mode: TemplateMode,
    arguments: &str,
) -> String {
    let rendered = template.replace("$ARGUMENTS", &format_template_value(arguments, mode));
    hook_placeholder_regex()
        .replace_all(&rendered, |captures: &regex::Captures<'_>| {
            let key = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            match resolve_hook_template_value(input, key, arguments) {
                Some(value) => format_template_value(&value, mode),
                None => captures
                    .get(0)
                    .map(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string(),
            }
        })
        .into_owned()
}

fn hook_placeholder_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}").unwrap())
}

fn resolve_hook_template_value(input: &HookInput, key: &str, arguments: &str) -> Option<String> {
    match key {
        "arguments" | "json" => Some(arguments.to_string()),
        "event" => Some(input.event.as_str().to_string()),
        "query" => Some(input.query.clone()),
        "data" => Some(json_value_to_template_string(&input.data)),
        "extra" => serde_json::to_string(&input.extra).ok(),
        _ => {
            if let Some(path) = key.strip_prefix("data.") {
                return lookup_json_path(&input.data, path).map(json_value_to_template_string);
            }
            if let Some(path) = key.strip_prefix("extra.") {
                let extra_value = serde_json::Value::Object(
                    input
                        .extra
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                );
                return lookup_json_path(&extra_value, path).map(json_value_to_template_string);
            }
            input.extra.get(key).map(json_value_to_template_string)
        }
    }
}

fn lookup_json_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            return None;
        }
        match current {
            serde_json::Value::Object(map) => current = map.get(segment)?,
            serde_json::Value::Array(items) => {
                current = items.get(segment.parse::<usize>().ok()?)?
            }
            _ => return None,
        }
    }
    Some(current)
}

fn json_value_to_template_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => value.to_string(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
    }
}

fn format_template_value(value: &str, mode: TemplateMode) -> String {
    match mode {
        TemplateMode::Raw => value.to_string(),
        TemplateMode::Shell => shell_quote(value),
        TemplateMode::PowerShell => powershell_quote(value),
    }
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn anthropic_model_prefix() -> &'static str {
    concat!("cla", "ude")
}

fn build_provider(model: Option<&str>) -> Result<Arc<dyn Provider>, String> {
    if let Some(model) = model {
        if model.starts_with(&format!("{}-", anthropic_model_prefix())) {
            if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
                return AnthropicProvider::new(key)
                    .map(|p| Arc::new(p) as Arc<dyn Provider>)
                    .map_err(|e| e.to_string());
            }
        } else if model.starts_with("gemini-") {
            if let Ok(key) = std::env::var("GEMINI_API_KEY") {
                return GeminiProvider::new(key, model)
                    .map(|p| Arc::new(p) as Arc<dyn Provider>)
                    .map_err(|e| e.to_string());
            }
        } else {
            if let Ok(key) = std::env::var("OPENAI_API_KEY") {
                return OpenAiProvider::new(key, model)
                    .map(|p| Arc::new(p) as Arc<dyn Provider>)
                    .map_err(|e| e.to_string());
            }
        }
    }

    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        return AnthropicProvider::new(key)
            .map(|p| Arc::new(p) as Arc<dyn Provider>)
            .map_err(|e| e.to_string());
    }
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        return OpenAiProvider::new(key, "gpt-4o-mini")
            .map(|p| Arc::new(p) as Arc<dyn Provider>)
            .map_err(|e| e.to_string());
    }
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        return GeminiProvider::new(key, "gemini-2.0-flash")
            .map(|p| Arc::new(p) as Arc<dyn Provider>)
            .map_err(|e| e.to_string());
    }

    Err("no LLM API key found for prompt/agent hook (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)".into())
}

fn hook_working_dir(input: &HookInput) -> Option<PathBuf> {
    input
        .extra
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(PathBuf::from)
        .filter(|cwd| cwd.is_dir())
}

fn is_posix_shell(name: &str) -> bool {
    matches!(name, "bash" | "sh" | "dash" | "zsh")
}

fn plugin_root_environment(root: &Path, shell_name: &str, windows: bool) -> std::ffi::OsString {
    if windows && is_posix_shell(shell_name) {
        if let Some(root) = root.to_str() {
            let root = root.strip_prefix(r"\\?\").unwrap_or(root);
            let root = root
                .strip_prefix(r"UNC\")
                .map(|tail| format!("//{tail}"))
                .unwrap_or_else(|| root.to_owned());
            return root.replace('\\', "/").into();
        }
    }
    root.as_os_str().to_owned()
}

#[cfg(any(windows, test))]
fn posix_hook_path(
    shell: &Path,
    inherited: Option<std::ffi::OsString>,
) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    let mut paths = Vec::new();
    if let Some(parent) = shell
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        paths.push(parent.to_path_buf());
        if let Some(root) = parent.parent() {
            let utilities = root.join("usr").join("bin");
            if utilities.is_dir() && utilities != parent {
                paths.push(utilities);
            }
        }
    }
    if let Some(path) = inherited {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths)
}

fn resolve_hook_shell(shell: &str) -> PathBuf {
    let shell_path = PathBuf::from(shell);
    if shell_path.components().count() > 1 || shell_path.is_absolute() {
        return shell_path;
    }

    #[cfg(windows)]
    if shell.eq_ignore_ascii_case("bash") || shell.eq_ignore_ascii_case("bash.exe") {
        for candidate in [
            std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .map(|path| path.join("Git").join("bin").join("bash.exe")),
            std::env::var_os("ProgramFiles(x86)")
                .map(PathBuf::from)
                .map(|path| path.join("Git").join("bin").join("bash.exe")),
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| {
                    path.join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe")
                }),
        ]
        .into_iter()
        .flatten()
        {
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    for dir in ["/usr/local/bin", "/usr/bin", "/bin"] {
        let candidate = Path::new(dir).join(shell);
        if candidate.exists() {
            return candidate;
        }
    }

    shell_path
}

async fn collect_text_with_timeout(
    mut stream: kcoder_api::ProviderStream,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now()
        .checked_add(Duration::from_secs(timeout_secs))
        .ok_or("hook timeout is too large")?;
    loop {
        // Even a heartbeat stream that always returns Ready must obey the total budget.
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "hook LLM call timed out after {timeout_secs} seconds"
            ));
        }
        match timeout_at(deadline, stream.next()).await {
            Ok(Some(Ok(event))) => match event {
                StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text: delta },
                    ..
                } => {
                    if delta.len() > MAX_HOOK_OUTPUT_BYTES.saturating_sub(text.len()) {
                        return Err(format!(
                            "hook LLM output exceeds {MAX_HOOK_OUTPUT_BYTES} bytes"
                        ));
                    }
                    text.push_str(&delta);
                }
                StreamEvent::MessageStop => break,
                StreamEvent::Error { error } => {
                    return Err(format!("{}: {}", error.error_type, error.message));
                }
                _ => {}
            },
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "hook LLM call timed out after {} seconds",
                    timeout_secs
                ));
            }
        }
    }
    Ok(text)
}

fn parse_llm_hook_response(text: &str) -> HookOutcome {
    let trimmed = text.trim();
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return HookOutcome::InvalidOutput(format!(
                "invalid JSON response: {} (raw: {})",
                e,
                hook_text_preview(text)
            ));
        }
    };

    match value.get("ok").and_then(|v| v.as_bool()) {
        Some(true) => HookOutcome::Effects(vec![HookEffect::Message {
            text: "hook condition met".to_string(),
            is_error: false,
        }]),
        Some(false) => {
            let reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("condition not met");
            HookOutcome::Effects(vec![HookEffect::BlockingError {
                message: format!("Hook condition was not met: {}", hook_text_preview(reason)),
            }])
        }
        None => HookOutcome::InvalidOutput(format!(
            "missing 'ok' field in response: {}",
            hook_text_preview(text)
        )),
    }
}

async fn execute_llm_hook(
    template: &str,
    input: &HookInput,
    timeout_secs: u64,
    model: Option<&str>,
    kind: &str,
) -> HookOutcome {
    let provider = match build_provider(model) {
        Ok(p) => p,
        Err(e) => return HookOutcome::Error(e),
    };

    let rendered = match serde_json::to_string(input) {
        Ok(json) => add_arguments_to_prompt(template, input, &json),
        Err(e) => return HookOutcome::Error(format!("failed to serialize hook input: {}", e)),
    };

    let model_id = model
        .map(String::from)
        .unwrap_or_else(|| match provider.name() {
            "anthropic" => format!("{}-3-5-haiku-latest", anthropic_model_prefix()),
            "openai" => "gpt-4o-mini".to_string(),
            "gemini" => "gemini-2.0-flash".to_string(),
            _ => "default".to_string(),
        });

    let request = MessagesRequest::new(model_id, vec![Message::user_text(rendered)])
        .with_system(HOOK_SYSTEM_PROMPT)
        .with_max_tokens(1024);

    let stream = match provider.stream_messages(request) {
        Ok(s) => s,
        Err(e) => {
            return HookOutcome::Error(format!("failed to start {} hook LLM stream: {}", kind, e));
        }
    };

    let text = match collect_text_with_timeout(stream, timeout_secs).await {
        Ok(t) => t,
        Err(e) => return HookOutcome::Error(e),
    };

    parse_llm_hook_response(&text)
}

/// Execute hooks for a tool event and return the first blocking error, if any.
pub fn first_blocking_error(results: &[HookResult]) -> Option<String> {
    for result in results {
        if let HookOutcome::Error(msg) | HookOutcome::InvalidOutput(msg) = &result.outcome {
            return Some(format!("{} failed: {}", result.hook_description, msg));
        }
        if let HookOutcome::Effects(effects) = &result.outcome {
            for effect in effects {
                if let crate::types::HookEffect::BlockingError { message } = effect {
                    return Some(message.clone());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn sample_input() -> HookInput {
        HookInput::new(
            HookEvent::PreToolUse,
            "Bash; exit 42",
            json!({
                "command": "cargo test",
                "args": ["--workspace", "--all-targets"],
            }),
        )
        .with_extra("cwd", json!("/tmp/kcoder code"))
    }

    #[test]
    fn model_hook_filter_preserves_non_model_automation() {
        let matcher = HookMatcher {
            matcher: None,
            hooks: vec![
                HookCommand::Command {
                    shell: "bash".to_string(),
                    command: "true".to_string(),
                    if_rule: None,
                    timeout: 5,
                    async_hook: false,
                },
                HookCommand::Prompt {
                    prompt: "review this event".to_string(),
                    timeout: 5,
                    model: None,
                },
                HookCommand::Agent {
                    instructions: "review this event".to_string(),
                    timeout: 5,
                    max_turns: 2,
                    model: None,
                },
                HookCommand::Http {
                    url: "https://example.test/hook".to_string(),
                    method: "POST".to_string(),
                    headers: Default::default(),
                    timeout: 5,
                },
            ],
            source: None,
        };

        let registry = HookRegistry::from_matchers(vec![(HookEvent::PreToolUse, matcher)])
            .without_model_calls();

        assert!(!registry.disabled);
        let hooks = &registry.settings_hooks[0].1.hooks;
        assert_eq!(hooks.len(), 2);
        assert!(matches!(hooks[0], HookCommand::Command { .. }));
        assert!(matches!(hooks[1], HookCommand::Http { .. }));
    }

    #[test]
    fn render_hook_template_expands_raw_values() {
        let input = sample_input();
        let arguments = serde_json::to_string(&input).unwrap();

        let rendered = render_hook_template(
            "{{event}} {{query}} {{data.command}} {{data.args.1}} {{cwd}} {{missing}} $ARGUMENTS",
            &input,
            TemplateMode::Raw,
            &arguments,
        );

        assert!(rendered.starts_with(
            "PreToolUse Bash; exit 42 cargo test --all-targets /tmp/kcoder code {{missing}} {"
        ));
    }

    #[test]
    fn render_hook_template_quotes_shell_values() {
        let input = sample_input();
        let rendered = render_hook_template(
            "printf %s {{query}} {{cwd}}",
            &input,
            TemplateMode::Shell,
            "{}",
        );

        assert_eq!(rendered, "printf %s 'Bash; exit 42' '/tmp/kcoder code'");
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("it's ready"), "'it'\"'\"'s ready'");
    }

    #[test]
    fn hook_text_preview_redacts_sensitive_tokens() {
        let preview = hook_text_preview(
            "OPENAI_API_KEY=sk-secret curl -H 'Authorization: Bearer token-value' https://example.test",
        );

        assert!(preview.contains("[redacted]"));
        assert!(!preview.contains("sk-secret"));
        assert!(!preview.contains("token-value"));
        assert!(!preview.contains("OPENAI_API_KEY=sk-secret"));
    }

    #[test]
    fn plugin_roots_are_shell_compatible_without_changing_native_or_unix_paths() {
        for (input, expected) in [
            (r"C:\Users\Test User\plugin", "C:/Users/Test User/plugin"),
            (
                r"\\?\C:\Users\Test User\plugin",
                "C:/Users/Test User/plugin",
            ),
            (r"\\?\UNC\server\share\plugin", "//server/share/plugin"),
        ] {
            assert_eq!(
                plugin_root_environment(Path::new(input), "bash", true),
                std::ffi::OsString::from(expected)
            );
            assert_eq!(
                plugin_root_environment(Path::new(input), "powershell", true),
                std::ffi::OsString::from(input)
            );
            assert_eq!(
                plugin_root_environment(Path::new(input), "bash", false),
                std::ffi::OsString::from(input)
            );
        }
    }

    #[test]
    fn posix_hook_path_includes_shell_and_git_utilities_before_inherited_path() {
        let temp = tempfile::tempdir().unwrap();
        let shell = temp.path().join("Git/bin/bash.exe");
        let utilities = temp.path().join("Git/usr/bin");
        std::fs::create_dir_all(&utilities).unwrap();
        let inherited = temp.path().join("system");
        let result = posix_hook_path(&shell, Some(inherited.clone().into_os_string())).unwrap();
        assert_eq!(
            std::env::split_paths(&result).collect::<Vec<_>>(),
            vec![shell.parent().unwrap().to_path_buf(), utilities, inherited]
        );
    }

    #[tokio::test]
    async fn asynchronous_hook_keeps_runtime_resources_until_its_process_finishes() {
        #[derive(Debug)]
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let released = Arc::new(AtomicBool::new(false));
        let mut source = HookSource::plugin("fixture", "fixture", temp.path());
        source.runtime_guard = Some(Arc::new(Guard(Arc::clone(&released))));
        let hook = HookCommand::Command {
            shell: "bash".into(),
            command: "while [ ! -f release ]; do sleep 0.01; done".into(),
            timeout: 5,
            if_rule: None,
            async_hook: true,
        };
        let input = HookInput::new(HookEvent::Notification, "fixture", serde_json::json!({}))
            .with_extra("cwd", serde_json::json!(temp.path()));
        let result = execute_hook(&hook, &input, Some(&source)).await;
        assert!(matches!(result, HookOutcome::Effects(_)));
        assert!(
            serde_json::to_value(&source)
                .unwrap()
                .get("runtime_guard")
                .is_none()
        );
        drop(source);
        assert!(!released.load(Ordering::SeqCst));
        std::fs::write(temp.path().join("release"), "go").unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !released.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn successful_silent_command_hooks_do_not_block_a_turn() {
        let commands = if cfg!(windows) {
            [
                ("powershell.exe", "exit 0"),
                ("powershell.exe", "Write-Output '   '"),
            ]
        } else {
            [("bash", "exit 0"), ("bash", "printf ' \n\t'")]
        };
        for (shell, command) in commands {
            let outcome =
                execute_command_hook(shell, command, 5, false, &sample_input(), None).await;
            assert!(
                matches!(&outcome, HookOutcome::Effects(effects) if effects.is_empty()),
                "{outcome:?}"
            );
            assert!(
                first_blocking_error(&[HookResult {
                    hook_description: "silent advisory".into(),
                    outcome
                }])
                .is_none()
            );
        }
    }

    #[tokio::test]
    async fn silent_nonzero_exit_still_blocks_the_turn() {
        let shell = if cfg!(windows) {
            "powershell.exe"
        } else {
            "bash"
        };
        let outcome = execute_command_hook(shell, "exit 2", 5, false, &sample_input(), None).await;
        assert!(
            matches!(&outcome, HookOutcome::Error(message) if message.contains("exit code: 2")),
            "{outcome:?}"
        );
        assert!(
            first_blocking_error(&[HookResult {
                hook_description: "blocking hook".into(),
                outcome
            }])
            .is_some()
        );
    }

    #[tokio::test]
    async fn explicit_async_command_hook_detaches() {
        let input = sample_input();

        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            execute_command_hook("bash", "sleep 1", 5, true, &input, None),
        )
        .await
        .expect("async hook should return before the child process exits");

        match outcome {
            HookOutcome::Effects(effects) => {
                assert!(matches!(
                    effects.as_slice(),
                    [HookEffect::Message { text, is_error: false }] if text == "async hook started"
                ));
            }
            other => panic!("expected async hook message, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_hook_deadline_includes_pipes_after_leader_exit() {
        let outcome = execute_command_hook(
            "bash",
            "sleep 2 & printf '{}'",
            1,
            false,
            &sample_input(),
            None,
        )
        .await;
        assert!(matches!(outcome, HookOutcome::Error(message) if message.contains("timed out")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_hook_rejects_excessive_unbroken_output() {
        let outcome = execute_command_hook(
            "bash",
            "head -c 2097152 /dev/zero",
            5,
            false,
            &sample_input(),
            None,
        )
        .await;
        assert!(
            matches!(outcome, HookOutcome::Error(message) if message.contains("output exceeds"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_hook_stops_infinite_unbroken_output() {
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            execute_command_hook(
                "bash",
                "yes x | tr -d '\\n'",
                10,
                false,
                &sample_input(),
                None,
            ),
        )
        .await
        .expect("无限输出必须由容量上限终止");
        assert!(
            matches!(outcome, HookOutcome::Error(message) if message.contains("output exceeds"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_command_hook_cleans_up_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let input = sample_input().with_extra("cwd", json!(temp.path()));
        let task = tokio::spawn(async move {
            execute_command_hook(
                "bash",
                "(sleep 1; printf escaped > late-marker) & printf ready > ready-marker; wait",
                10,
                false,
                &input,
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !temp.path().join("ready-marker").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Hook 应已启动");
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!temp.path().join("late-marker").exists());
    }

    #[tokio::test]
    async fn hook_output_read_errors_are_not_silently_ignored() {
        struct FailedReader;
        impl AsyncRead for FailedReader {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                _buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::Error::other("injected read failure")))
            }
        }
        assert!(
            read_hook_output(FailedReader, "stdout")
                .await
                .unwrap_err()
                .contains("injected read failure")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn async_command_hook_retains_its_deadline() {
        let temp = tempfile::tempdir().unwrap();
        let input = sample_input().with_extra("cwd", json!(temp.path()));
        let outcome = execute_command_hook(
            "bash",
            "sleep 2; printf escaped > late-marker",
            1,
            true,
            &input,
            None,
        )
        .await;
        assert!(matches!(outcome, HookOutcome::Effects(_)));
        tokio::time::sleep(Duration::from_millis(2300)).await;
        assert!(
            !temp.path().join("late-marker").exists(),
            "async hook ran beyond its timeout"
        );
    }

    #[tokio::test]
    async fn llm_hook_deadline_is_not_reset_by_stream_progress() {
        let stream = futures::stream::unfold(0, |index| async move {
            if index == 5 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            Some((
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "tick".into(),
                    },
                }),
                index + 1,
            ))
        });
        let result = collect_text_with_timeout(Box::pin(stream), 1).await;
        assert!(matches!(result, Err(message) if message.contains("timed out")));
    }

    #[tokio::test]
    async fn failed_command_hook_redacts_stderr_in_error() {
        let input = sample_input();

        let outcome = execute_command_hook(
            "bash",
            "printf 'OPENAI_API_KEY=sk-secret\\n' >&2; exit 2",
            5,
            false,
            &input,
            None,
        )
        .await;

        match outcome {
            HookOutcome::Error(message) => {
                assert!(message.contains("[redacted]"));
                assert!(!message.contains("sk-secret"));
                assert!(!message.contains("OPENAI_API_KEY=sk-secret"));
            }
            other => panic!("expected redacted hook error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_command_hook_output_is_redacted() {
        let input = sample_input();

        let outcome = execute_command_hook(
            "bash",
            "printf 'api_key=sk-secret\\n'",
            5,
            false,
            &input,
            None,
        )
        .await;

        match outcome {
            HookOutcome::InvalidOutput(output) => {
                assert!(output.contains("[redacted]"));
                assert!(!output.contains("sk-secret"));
                assert!(!output.contains("api_key=sk-secret"));
            }
            other => panic!("expected redacted invalid-output outcome, got {other:?}"),
        }
    }

    #[test]
    fn hook_description_redacts_sensitive_values() {
        let command_description = hook_description(&HookCommand::Command {
            shell: "bash".to_string(),
            command: "curl -H 'Authorization: Bearer token-value' https://example.test".to_string(),
            if_rule: None,
            timeout: 5,
            async_hook: false,
        });
        let prompt_description = hook_description(&HookCommand::Prompt {
            prompt: "OPENAI_API_KEY=sk-secret".to_string(),
            timeout: 5,
            model: None,
        });
        let http_description = hook_description(&HookCommand::Http {
            url: "https://example.test/hook?api_key=sk-secret".to_string(),
            method: "POST".to_string(),
            headers: Default::default(),
            timeout: 5,
        });

        for description in [command_description, prompt_description, http_description] {
            assert!(description.contains("[redacted]"));
            assert!(!description.contains("token-value"));
            assert!(!description.contains("sk-secret"));
            assert!(!description.contains("api_key=sk-secret"));
        }
    }

    #[test]
    fn llm_missing_ok_response_is_redacted() {
        let outcome = parse_llm_hook_response(r#"{"api_key":"sk-secret","message":"visible"}"#);

        match outcome {
            HookOutcome::InvalidOutput(message) => {
                assert!(message.contains("[redacted]"));
                assert!(!message.contains("sk-secret"));
                assert!(!message.contains("api_key"));
            }
            other => panic!("expected invalid-output outcome, got {other:?}"),
        }
    }

    #[test]
    fn llm_blocking_reason_is_redacted() {
        let outcome = parse_llm_hook_response(
            r#"{"ok":false,"reason":"OPENAI_API_KEY=sk-secret should not leak"}"#,
        );

        match outcome {
            HookOutcome::Effects(effects) => {
                assert!(matches!(
                    effects.as_slice(),
                    [HookEffect::BlockingError { message }]
                        if message.contains("[redacted]")
                            && !message.contains("sk-secret")
                            && !message.contains("OPENAI_API_KEY=sk-secret")
                ));
            }
            other => panic!("expected blocking effect, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plugin_hook_root_with_spaces_and_missing_script_are_distinct() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin root with spaces");
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        std::fs::write(
            root.join("hooks/check.sh"),
            "#!/bin/bash\ncat >/dev/null\nprintf '{}'\n",
        )
        .unwrap();
        let source = HookSource {
            kind: HookSourceKind::Plugin,
            id: "owned@fixture".into(),
            name: "owned".into(),
            root,
            required_trust: None,
            runtime_guard: None,
        };
        let good = execute_command_hook(
            "bash",
            "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/check.sh\"",
            5,
            false,
            &sample_input(),
            Some(&source),
        )
        .await;
        assert!(matches!(good, HookOutcome::Effects(_)), "{good:?}");
        let missing = execute_command_hook(
            "bash",
            "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/missing.sh\"",
            5,
            false,
            &sample_input(),
            Some(&source),
        )
        .await;
        assert!(
            matches!(missing, HookOutcome::Error(ref message) if message.contains("missing.sh") && !message.contains("timed out")),
            "{missing:?}"
        );
    }

    #[tokio::test]
    async fn command_hook_uses_clean_environment_and_input_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let input = sample_input().with_extra("cwd", json!(tmp.path()));

        let outcome = execute_command_hook(
            "bash",
            "printf 'manifest=%s\\nevent=%s\\nquery=%s\\npwd=%s\\n' \"${CARGO_MANIFEST_DIR-unset}\" \"$KCODER_HOOK_EVENT\" \"$KCODER_HOOK_QUERY\" \"$PWD\"",
            5,
            false,
            &input,
            None,
        )
        .await;

        match outcome {
            HookOutcome::InvalidOutput(output) => {
                assert!(output.contains("manifest=unset"));
                assert!(output.contains("event=PreToolUse"));
                assert!(output.contains("query=Bash; exit 42"));
                assert!(output.contains(&format!("pwd={}", tmp.path().display())));
            }
            other => panic!("expected raw stdout invalid-output outcome, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn timed_out_command_hook_terminates_quickly() {
        let input = sample_input();

        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            execute_command_hook("bash", "sleep 10", 0, false, &input, None),
        )
        .await
        .expect("timed-out hook should terminate the child and return promptly");

        match outcome {
            HookOutcome::Error(message) => {
                assert!(message.contains("hook timed out after 0 seconds"));
            }
            other => panic!("expected timeout error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn timed_out_command_hook_does_not_wait_for_grandchild_pipes() {
        let input = sample_input();

        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            execute_command_hook("bash", "sleep 10 & wait", 0, false, &input, None),
        )
        .await
        .expect("timeout path should not wait for a grandchild to close inherited pipes");

        match outcome {
            HookOutcome::Error(message) => {
                assert!(message.contains("hook timed out after 0 seconds"));
            }
            other => panic!("expected timeout error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn command_hook_nonzero_exit_status_is_platform_neutral() {
        let input = sample_input();
        let (shell, command) = if cfg!(windows) {
            ("powershell.exe", "exit 7")
        } else {
            ("bash", "exit 7")
        };

        let outcome = execute_command_hook(shell, command, 5, false, &input, None).await;

        assert!(matches!(
            outcome,
            HookOutcome::Error(message) if message.contains("hook exited with status exit code: 7")
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_command_hook_terminates_unix_child_process_group() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("hook-child.pid");
        let command = format!(
            "sleep 60 & child=$!; printf '%s' \"$child\" > '{}'; wait",
            pid_path.display()
        );
        let input = sample_input().with_extra("cwd", json!(tmp.path()));

        let outcome = execute_command_hook("bash", &command, 1, false, &input, None).await;
        assert!(matches!(outcome, HookOutcome::Error(message) if message.contains("timed out")));
        let child_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<libc::pid_t>()
            .unwrap();
        let terminated = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if unsafe { libc::kill(child_pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();

        if !terminated {
            unsafe {
                let _ = libc::kill(child_pid, libc::SIGKILL);
            }
        }
        assert!(terminated, "hook timeout left child PID {child_pid}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_hook_preserves_unicode_and_quotes_template_values() {
        let tmp = tempfile::tempdir().unwrap();
        let input = HookInput::new(
            HookEvent::PreToolUse,
            "昆仑 O'Brien 你好",
            json!({ "command": "测试" }),
        )
        .with_extra("cwd", json!(tmp.path()));

        let outcome = execute_command_hook(
            "powershell.exe",
            "@{ systemMessage = {{query}} } | ConvertTo-Json -Compress",
            5,
            false,
            &input,
            None,
        )
        .await;

        assert!(matches!(
            outcome,
            HookOutcome::Effects(effects)
                if matches!(effects.as_slice(), [HookEffect::Message { text, is_error: false }] if text == "昆仑 O'Brien 你好")
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_hook_keeps_required_windows_user_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let input = sample_input().with_extra("cwd", json!(tmp.path()));
        let outcome = execute_command_hook(
            "powershell.exe",
            "@{ systemMessage = $env:APPDATA } | ConvertTo-Json -Compress",
            5,
            false,
            &input,
            None,
        )
        .await;
        let app_data = std::env::var("APPDATA").unwrap();

        assert!(matches!(
            outcome,
            HookOutcome::Effects(effects)
                if matches!(effects.as_slice(), [HookEffect::Message { text, is_error: false }] if text == &app_data)
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timed_out_powershell_hook_terminates_child_process_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("hook-child.pid");
        let escaped_pid_path = pid_path.display().to_string().replace('\'', "''");
        let command = format!(
            "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; $child.Id | Set-Content -LiteralPath '{escaped_pid_path}'; Start-Sleep -Seconds 60"
        );
        let input = sample_input().with_extra("cwd", json!(tmp.path()));

        let outcome =
            execute_command_hook("powershell.exe", &command, 1, false, &input, None).await;
        assert!(matches!(outcome, HookOutcome::Error(message) if message.contains("timed out")));
        let child_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let terminated = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        &format!("Get-Process -Id {child_pid} -ErrorAction SilentlyContinue"),
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap();
                if !status.success() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();

        if !terminated {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &child_pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        assert!(terminated, "hook timeout left child PID {child_pid}");
    }
}
