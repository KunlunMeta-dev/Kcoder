use anyhow::{Context, Result};
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use kcoder_app_protocol::{
    BrowserAction, BrowserActionParams, BrowserActionResult, BrowserCloseResult,
    BrowserEvaluateParams, BrowserEvaluateResult, BrowserPageState, BrowserScreenshotResult,
    BrowserSessionParams, BrowserStartParams, BrowserStartResult,
};
#[cfg(windows)]
use kcoder_process_supervisor::client::{SpawnSpec, SupervisedChild, locate_supervisor_or_sibling};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
#[cfg(not(windows))]
use tokio::process::{Child, Command};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use super::MAX_DEVICE_RESULT_BYTES;

const MAX_BROWSER_SESSIONS: usize = 4;
const MAX_BROWSER_FRAME_BYTES: usize = 1_200_000;
const MAX_BROWSER_EVALUATE_BYTES: usize = 256 * 1024;
const MAX_BROWSER_CDP_MESSAGE_BYTES: usize = MAX_DEVICE_RESULT_BYTES;
const MAX_BROWSER_PAGE_FIELD_BYTES: usize = 4096;
const MAX_BROWSER_HISTORY_ENTRIES: usize = 128;
const MAX_BROWSER_HISTORY_BYTES: usize = 64 * 1024;
const BROWSER_PROCESS_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const MAX_CHROMIUM_STARTUP_ERROR_LINES: usize = 8;
const MAX_CHROMIUM_STARTUP_ERROR_LINE_CHARS: usize = 512;

type BrowserSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
struct BrowserExecutionContextUnavailable;

impl std::fmt::Display for BrowserExecutionContextUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Chromium execution context is changing during navigation")
    }
}

impl std::error::Error for BrowserExecutionContextUnavailable {}

struct BrowserSession {
    socket: BrowserSocket,
    cdp_session_id: String,
    target_id: String,
    process: OwnedChromiumProcess,
    _profile: tempfile::TempDir,
    next_command_id: u64,
    width: u32,
    height: u32,
    history: Vec<String>,
    history_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserTargetInfo {
    target_id: String,
    url: String,
    opener_id: Option<String>,
}

struct OwnedChromiumProcess {
    #[cfg(not(windows))]
    child: Child,
    #[cfg(windows)]
    child: SupervisedChild,
    #[cfg(unix)]
    pgid: i32,
    terminated: bool,
}

impl OwnedChromiumProcess {
    #[cfg(not(windows))]
    fn new(child: Child) -> Self {
        #[cfg(unix)]
        let pgid = child
            .id()
            .map(|pid| pid as i32)
            .expect("spawned Chromium has a process id");
        Self {
            child,
            #[cfg(unix)]
            pgid,
            terminated: false,
        }
    }

    #[cfg(windows)]
    fn new(child: SupervisedChild) -> Self {
        Self {
            child,
            terminated: false,
        }
    }

    #[cfg(not(windows))]
    fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    #[cfg(windows)]
    fn take_stderr(&mut self) -> Option<tokio::fs::File> {
        use std::os::windows::io::{FromRawHandle, IntoRawHandle};

        let stderr = self.child.take_stderr()?;
        let raw = stderr.into_raw_handle();
        let file = unsafe { std::fs::File::from_raw_handle(raw) };
        Some(tokio::fs::File::from_std(file))
    }

    async fn terminate(&mut self) -> Result<()> {
        if self.terminated {
            return Ok(());
        }
        self.signal_process_tree();
        #[cfg(not(windows))]
        tokio::time::timeout(BROWSER_PROCESS_SHUTDOWN_TIMEOUT, self.child.wait())
            .await
            .context("timed out waiting for the Chromium process leader")??;
        #[cfg(windows)]
        {
            let deadline = tokio::time::Instant::now() + BROWSER_PROCESS_SHUTDOWN_TIMEOUT;
            while self.child.try_wait()?.is_none() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            anyhow::ensure!(
                self.child.try_wait()?.is_some(),
                "Chromium Job did not terminate within the shutdown bound"
            );
        }
        #[cfg(unix)]
        {
            let deadline = tokio::time::Instant::now() + BROWSER_PROCESS_SHUTDOWN_TIMEOUT;
            while process_group_exists(self.pgid) && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if process_group_exists(self.pgid) {
                anyhow::bail!("Chromium process group did not terminate within the shutdown bound")
            }
        }
        self.terminated = true;
        Ok(())
    }

    fn signal_process_tree(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        #[cfg(not(windows))]
        let _ = self.child.start_kill();
        #[cfg(windows)]
        let _ = self.child.kill();
    }
}

impl Drop for OwnedChromiumProcess {
    fn drop(&mut self) {
        if self.terminated {
            return;
        }
        self.signal_process_tree();
        let deadline = std::time::Instant::now() + BROWSER_PROCESS_SHUTDOWN_TIMEOUT;
        loop {
            let child_done = self.child.try_wait().ok().flatten().is_some();
            #[cfg(unix)]
            let tree_done = !process_group_exists(self.pgid);
            #[cfg(not(unix))]
            let tree_done = child_done;
            if child_done && tree_done || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        #[cfg(unix)]
        if process_group_exists(self.pgid) {
            tracing::error!(
                pgid = self.pgid,
                "Chromium process group remained alive after bounded Drop cleanup"
            );
        }
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: i32) -> bool {
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

pub(super) struct BrowserRegistry {
    sessions: HashMap<String, BrowserSession>,
    next_browser_id: u64,
}

impl Default for BrowserRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserRegistry {
    pub(super) fn resource_count(&self) -> usize {
        self.sessions.len()
    }

    pub(super) fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_browser_id: 1,
        }
    }

    pub(super) async fn start(
        &mut self,
        engine_session_id: &str,
        params: BrowserStartParams,
    ) -> Result<BrowserStartResult> {
        let result = browser_start(
            engine_session_id,
            self.next_browser_id,
            params,
            &mut self.sessions,
        )
        .await;
        if result.is_ok() {
            self.next_browser_id = self.next_browser_id.saturating_add(1);
        }
        result
    }

    pub(super) async fn screenshot(
        &mut self,
        params: BrowserSessionParams,
    ) -> Result<BrowserScreenshotResult> {
        browser_screenshot(&mut self.sessions, &params.session_id).await
    }

    pub(super) async fn action(
        &mut self,
        params: BrowserActionParams,
    ) -> Result<BrowserActionResult> {
        browser_action(&mut self.sessions, params).await
    }

    pub(super) async fn evaluate(
        &mut self,
        params: BrowserEvaluateParams,
    ) -> Result<BrowserEvaluateResult> {
        browser_evaluate(&mut self.sessions, params).await
    }

    pub(super) async fn close(
        &mut self,
        params: BrowserSessionParams,
    ) -> Result<BrowserCloseResult> {
        let Some(mut session) = self.sessions.remove(&params.session_id) else {
            return Ok(BrowserCloseResult { closed: false });
        };
        session.process.terminate().await?;
        Ok(BrowserCloseResult { closed: true })
    }

    pub(super) async fn shutdown_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            if let Err(error) = session.process.terminate().await {
                tracing::warn!(%error, "failed to terminate Chromium process tree");
            }
        }
    }
}

fn validate_browser_url(value: &str) -> Result<String> {
    if value.len() > 4096 {
        anyhow::bail!("browser URL is too long")
    }
    let parsed = reqwest::Url::parse(value).context("browser URL is invalid")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host_str().is_none()
    {
        anyhow::bail!("browser URL must be an http(s) URL without credentials")
    }
    Ok(parsed.to_string())
}

fn remember_chromium_startup_error(lines: &mut VecDeque<String>, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let bounded = line
        .chars()
        .take(MAX_CHROMIUM_STARTUP_ERROR_LINE_CHARS)
        .collect::<String>();
    if lines.len() == MAX_CHROMIUM_STARTUP_ERROR_LINES {
        lines.pop_front();
    }
    lines.push_back(bounded);
}

async fn browser_cdp_command(
    session: &mut BrowserSession,
    method: &str,
    params: Value,
) -> Result<Value> {
    browser_cdp_command_raw(
        &mut session.socket,
        &mut session.next_command_id,
        Some(&session.cdp_session_id),
        method,
        params,
    )
    .await
}

async fn browser_cdp_command_raw(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    cdp_session_id: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        *next_command_id = next_command_id.saturating_add(1);
        let id = *next_command_id;
        let mut request = json!({"id": id, "method": method, "params": params});
        if let Some(cdp_session_id) = cdp_session_id {
            request["sessionId"] = Value::String(cdp_session_id.to_owned());
        }
        socket
            .send(Message::Text(serde_json::to_string(&request)?.into()))
            .await
            .context("failed to send Chromium CDP command")?;
        socket
            .flush()
            .await
            .context("failed to flush Chromium CDP command")?;
        while let Some(message) = socket.next().await {
            let message = message.context("Chromium CDP socket failed")?;
            let value: Value = match message {
                Message::Text(text) => serde_json::from_str(&text)?,
                Message::Binary(bytes) => serde_json::from_slice(&bytes)?,
                _ => continue,
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    if method == "Runtime.evaluate"
                        && error.get("code").and_then(Value::as_i64) == Some(-32000)
                        && matches!(
                            error.get("message").and_then(Value::as_str),
                            Some(
                                "Cannot find context with specified id"
                                    | "Execution context was destroyed."
                                    | "Cannot find default execution context"
                            )
                        )
                    {
                        return Err(BrowserExecutionContextUnavailable.into());
                    }
                    anyhow::bail!("Chromium CDP {method} failed: {error}")
                }
                return Ok(value.get("result").cloned().unwrap_or_else(|| json!({})));
            }
            if value.get("method").and_then(Value::as_str) == Some("Target.detachedFromTarget")
                && value.pointer("/params/sessionId").and_then(Value::as_str) == cdp_session_id
            {
                anyhow::bail!("Chromium detached the active page target")
            }
        }
        anyhow::bail!("Chromium CDP socket closed")
    })
    .await
    .with_context(|| format!("Chromium CDP {method} command timed out"))?
}

async fn browser_page_state(session: &mut BrowserSession) -> Result<BrowserPageState> {
    browser_page_state_raw(
        &mut session.socket,
        &mut session.next_command_id,
        &session.cdp_session_id,
        session.history.len(),
        session.history_index,
    )
    .await
}

async fn browser_page_state_raw(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    cdp_session_id: &str,
    history_len: usize,
    history_index: usize,
) -> Result<BrowserPageState> {
    let result = browser_cdp_command_raw(
        socket,
        next_command_id,
        Some(cdp_session_id),
        "Runtime.evaluate",
        json!({
            "expression": "(()=>{let faviconUrl=null;try{faviconUrl=document.querySelector('link[rel~=icon]')?.href||new URL('/favicon.ico',location.href).href}catch{}return {url:location.href,title:document.title||null,faviconUrl}})()",
            "returnByValue": true,
        }),
    )
    .await?;
    if result.get("exceptionDetails").is_some() {
        anyhow::bail!("Chromium page state evaluation failed with a JavaScript exception");
    }
    let value = result
        .get("result")
        .and_then(|value| value.get("value"))
        .cloned()
        .context("Chromium page state evaluation did not return a value")?;
    let state: BrowserPageState =
        serde_json::from_value(value).context("Chromium returned an invalid page state")?;
    validate_page_state_fields(browser_page_state_with_history(
        state,
        history_len,
        history_index,
    ))
}

fn browser_page_state_with_history(
    mut state: BrowserPageState,
    history_len: usize,
    history_index: usize,
) -> BrowserPageState {
    state.can_go_back = Some(history_len > 0 && history_index > 0 && history_index < history_len);
    state.can_go_forward = Some(history_index < history_len.saturating_sub(1));
    state
}

fn validate_page_state_fields(state: BrowserPageState) -> Result<BrowserPageState> {
    for (name, value) in [
        ("url", Some(state.url.as_str())),
        ("title", state.title.as_deref()),
        ("faviconUrl", state.favicon_url.as_deref()),
    ] {
        if value.is_some_and(|value| value.len() > MAX_BROWSER_PAGE_FIELD_BYTES) {
            anyhow::bail!("Chromium page state {name} exceeds the field limit")
        }
    }
    Ok(state)
}

async fn browser_wait_until_ready_raw(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    cdp_session_id: &str,
    history_len: usize,
    history_index: usize,
) -> Result<BrowserPageState> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout_at(
            deadline,
            browser_page_state_raw(
                socket,
                next_command_id,
                cdp_session_id,
                history_len,
                history_index,
            ),
        )
        .await
        {
            Ok(Ok(state)) if !state.url.is_empty() && state.url != "about:blank" => {
                validate_browser_url(&state.url)
                    .context("Chromium navigation reached an error document or a disallowed URL")?;
                return Ok(state);
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) if error.is::<BrowserExecutionContextUnavailable>() => {}
            Ok(Err(error)) => return Err(error).context("Chromium page readiness failed"),
            Err(error) => return Err(error).context("Chromium page readiness deadline exceeded"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    anyhow::bail!("timed out waiting for the Chromium page to become ready")
}

async fn browser_page_targets(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
) -> Result<Vec<BrowserTargetInfo>> {
    let result = browser_cdp_command_raw(
        socket,
        next_command_id,
        None,
        "Target.getTargets",
        json!({}),
    )
    .await?;
    Ok(result
        .get("targetInfos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|target| target.get("type").and_then(Value::as_str) == Some("page"))
        .filter_map(|target| {
            Some(BrowserTargetInfo {
                target_id: target.get("targetId")?.as_str()?.to_owned(),
                url: target.get("url")?.as_str()?.to_owned(),
                opener_id: target
                    .get("openerId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect())
}

fn validate_close_target_result(result: &Value) -> Result<()> {
    anyhow::ensure!(
        result.get("success").and_then(Value::as_bool) == Some(true),
        "Chromium did not close the page target"
    );
    Ok(())
}

async fn browser_close_target(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    target_id: &str,
) -> Result<()> {
    let result = browser_cdp_command_raw(
        socket,
        next_command_id,
        None,
        "Target.closeTarget",
        json!({"targetId": target_id}),
    )
    .await?;
    validate_close_target_result(&result)
}

async fn browser_create_stable_target(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    url: &str,
) -> Result<String> {
    validate_browser_url(url)?;
    // Attach before navigation so Page.navigate can report DNS/TLS/network failures.
    let created = browser_cdp_command_raw(
        socket,
        next_command_id,
        None,
        "Target.createTarget",
        json!({"url": "about:blank"}),
    )
    .await?;
    let created_target_id = created
        .get("targetId")
        .and_then(Value::as_str)
        .context("Chromium did not identify the created page target")?
        .to_owned();

    Ok(created_target_id)
}

async fn browser_prepare_target(
    socket: &mut BrowserSocket,
    next_command_id: &mut u64,
    url: &str,
    width: u32,
    height: u32,
) -> Result<(String, String, BrowserPageState)> {
    let target_id = browser_create_stable_target(socket, next_command_id, url).await?;
    let prepared = async {
        let attached = browser_cdp_command_raw(
            socket,
            next_command_id,
            None,
            "Target.attachToTarget",
            json!({"targetId":target_id,"flatten":true}),
        )
        .await?;
        let cdp_session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .context("Chromium did not return an attached page session")?
            .to_owned();
        for (method, params) in [
            ("Page.enable", json!({})),
            ("Runtime.enable", json!({})),
            (
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}),
            ),
        ] {
            browser_cdp_command_raw(
                socket,
                next_command_id,
                Some(&cdp_session_id),
                method,
                params,
            )
            .await?;
        }
        let navigation = browser_cdp_command_raw(
            socket,
            next_command_id,
            Some(&cdp_session_id),
            "Page.navigate",
            json!({"url":url}),
        )
        .await?;
        if let Some(error) = navigation
            .get("errorText")
            .and_then(Value::as_str)
            .filter(|error| !error.is_empty())
        {
            // CDP network error codes are safe to expose; do not echo arbitrary page text or URLs.
            let code = error.strip_prefix("net::ERR_").filter(|code| {
                !code.is_empty()
                    && code.len() <= 100
                    && code
                        .chars()
                        .all(|ch| ch.is_ascii_uppercase() || ch == '_' || ch.is_ascii_digit())
            });
            anyhow::bail!(
                "Chromium navigation failed: {}",
                code.map(|code| format!("net::ERR_{code}"))
                    .unwrap_or_else(|| "navigation rejected".into())
            );
        }
        if navigation.get("isDownload").and_then(Value::as_bool) == Some(true) {
            anyhow::bail!("Chromium navigation returned a download instead of a page");
        }
        let state =
            browser_wait_until_ready_raw(socket, next_command_id, &cdp_session_id, 1, 0).await?;
        Result::<_>::Ok((cdp_session_id, state))
    }
    .await;
    match prepared {
        Ok((session_id, state)) => Ok((target_id, session_id, state)),
        Err(error) => {
            let cleanup = browser_close_target(socket, next_command_id, &target_id).await;
            if cleanup.is_err() {
                return Err(error).context("Chromium candidate cleanup failed");
            }
            Err(error)
        }
    }
}

fn target_belongs_to_created_lineage(
    target: &BrowserTargetInfo,
    targets: &[BrowserTargetInfo],
    created_target_id: &str,
) -> bool {
    let mut current = target;
    for _ in 0..=targets.len() {
        if current.target_id == created_target_id {
            return true;
        }
        let Some(opener_id) = current.opener_id.as_deref() else {
            return false;
        };
        if opener_id == created_target_id {
            return true;
        }
        let Some(parent) = targets
            .iter()
            .find(|candidate| candidate.target_id == opener_id)
        else {
            return false;
        };
        current = parent;
    }
    false
}

fn ready_popup_target(
    targets: &[BrowserTargetInfo],
    active_target_id: &str,
) -> Option<BrowserTargetInfo> {
    targets
        .iter()
        .find(|target| {
            target.target_id != active_target_id
                && !target.url.is_empty()
                && target.url != "about:blank"
                && target_belongs_to_created_lineage(target, targets, active_target_id)
        })
        .cloned()
}

async fn browser_adopt_ready_popup(session: &mut BrowserSession) -> Result<bool> {
    let targets = browser_page_targets(&mut session.socket, &mut session.next_command_id).await?;
    let Some(popup) = ready_popup_target(&targets, &session.target_id) else {
        return Ok(false);
    };
    if let Err(error) = validate_browser_url(&popup.url) {
        let _ = browser_close_target(
            &mut session.socket,
            &mut session.next_command_id,
            &popup.target_id,
        )
        .await;
        return Err(error).context("Chromium popup URL is not allowed");
    }

    let attached = browser_cdp_command_raw(
        &mut session.socket,
        &mut session.next_command_id,
        None,
        "Target.attachToTarget",
        json!({"targetId": popup.target_id, "flatten": true}),
    )
    .await?;
    let cdp_session_id = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .context("Chromium did not return an attached popup session")?
        .to_owned();
    let candidate_result = async {
        browser_cdp_command_raw(
            &mut session.socket,
            &mut session.next_command_id,
            None,
            "Target.activateTarget",
            json!({"targetId": popup.target_id}),
        )
        .await?;
        for (method, params) in [
            ("Page.enable", json!({})),
            ("Runtime.enable", json!({})),
            ("Page.bringToFront", json!({})),
            (
                "Emulation.setDeviceMetricsOverride",
                json!({"width": session.width, "height": session.height, "deviceScaleFactor": 1, "mobile": false}),
            ),
        ] {
            browser_cdp_command_raw(
                &mut session.socket,
                &mut session.next_command_id,
                Some(&cdp_session_id),
                method,
                params,
            )
            .await?;
        }
        let state = browser_wait_until_ready_raw(
            &mut session.socket,
            &mut session.next_command_id,
            &cdp_session_id,
            session.history.len(),
            session.history_index,
        )
        .await?;
        let final_url = validate_browser_url(&state.url)
            .context("Chromium popup final URL is not allowed")?;
        Result::<String>::Ok(final_url)
    }
    .await;
    let final_url = match candidate_result {
        Ok(url) => url,
        Err(error) => {
            let _ = browser_close_target(
                &mut session.socket,
                &mut session.next_command_id,
                &popup.target_id,
            )
            .await;
            let _ = browser_cdp_command_raw(
                &mut session.socket,
                &mut session.next_command_id,
                None,
                "Target.activateTarget",
                json!({"targetId": session.target_id}),
            )
            .await;
            return Err(error);
        }
    };

    // Commit the in-memory active session only after validating the candidate page's final URL and closing the old target successfully.
    if let Err(error) = browser_close_target(
        &mut session.socket,
        &mut session.next_command_id,
        &session.target_id,
    )
    .await
    {
        let _ = browser_close_target(
            &mut session.socket,
            &mut session.next_command_id,
            &popup.target_id,
        )
        .await;
        return Err(error);
    }
    session.target_id = popup.target_id;
    session.cdp_session_id = cdp_session_id;
    browser_record_observed_history(session, &final_url);
    Ok(true)
}

async fn browser_replace_target(
    session: &mut BrowserSession,
    url: &str,
) -> Result<BrowserPageState> {
    let candidate = browser_prepare_target(
        &mut session.socket,
        &mut session.next_command_id,
        url,
        session.width,
        session.height,
    )
    .await;
    let (target_id, cdp_session_id, state) = match candidate {
        Ok(candidate) => candidate,
        Err(error) => {
            let _ = browser_cdp_command_raw(
                &mut session.socket,
                &mut session.next_command_id,
                None,
                "Target.activateTarget",
                json!({"targetId":session.target_id}),
            )
            .await;
            return Err(error);
        }
    };
    let commit = async {
        browser_cdp_command_raw(
            &mut session.socket,
            &mut session.next_command_id,
            None,
            "Target.activateTarget",
            json!({"targetId":target_id}),
        )
        .await?;
        browser_close_target(
            &mut session.socket,
            &mut session.next_command_id,
            &session.target_id,
        )
        .await
    }
    .await;
    if let Err(error) = commit {
        let _ = browser_close_target(
            &mut session.socket,
            &mut session.next_command_id,
            &target_id,
        )
        .await;
        let _ = browser_cdp_command_raw(
            &mut session.socket,
            &mut session.next_command_id,
            None,
            "Target.activateTarget",
            json!({"targetId":session.target_id}),
        )
        .await;
        return Err(error);
    }
    session.target_id = target_id;
    session.cdp_session_id = cdp_session_id;
    Ok(browser_page_state_with_history(
        state,
        session.history.len(),
        session.history_index,
    ))
}

#[derive(Debug)]
struct ChromiumLaunch {
    executable: std::path::PathBuf,
    sandbox_disabled: bool,
}

fn bundled_chromium_candidates(
    executable: &std::path::Path,
    windows: bool,
) -> Vec<std::path::PathBuf> {
    if !executable.is_absolute() {
        return Vec::new();
    }
    let Some(directory) = executable.parent() else {
        return Vec::new();
    };
    let relative = if windows {
        "chrome/chrome-win64/chrome.exe"
    } else {
        "chrome/chrome-linux64/chrome"
    };
    let mut candidates = vec![directory.join(relative)];
    if !windows && let Some(prefix) = directory.parent() {
        candidates.push(prefix.join("lib/kcoder").join(relative));
    }
    candidates
}

fn default_chromium_candidates(
    windows: bool,
    mut environment: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Vec<std::path::PathBuf> {
    let mut candidates = vec!["chromium".into()];
    if windows {
        candidates.extend(["chrome".into(), "msedge".into()]);
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            let Some(root) = environment(key).map(std::path::PathBuf::from) else {
                continue;
            };
            // Empty or relative environment values must not search the working directory.
            if !root.is_absolute() {
                continue;
            }
            for relative in [
                "Google/Chrome/Application/chrome.exe",
                "Microsoft/Edge/Application/msedge.exe",
                "Chromium/Application/chrome.exe",
            ] {
                let candidate = root.join(relative);
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
    } else {
        candidates.extend([
            "chromium-browser".into(),
            "google-chrome".into(),
            "google-chrome-stable".into(),
            "microsoft-edge".into(),
            "microsoft-edge-stable".into(),
        ]);
    }
    candidates
}

// This checks environment prerequisites only; process startup can still fail.
fn browser_launch_preflight() -> Result<ChromiumLaunch> {
    let chromium = std::env::var_os("KCODER_CHROMIUM_BIN");
    let sandbox_opt_in = std::env::var_os("KCODER_CHROMIUM_NO_SANDBOX");
    #[cfg(unix)]
    let running_as_root = unsafe { libc::geteuid() } == 0;
    #[cfg(not(unix))]
    let running_as_root = false;
    let mut candidates = std::env::current_exe()
        .ok()
        .map(|executable| bundled_chromium_candidates(&executable, cfg!(windows)))
        .unwrap_or_default();
    candidates.extend(default_chromium_candidates(cfg!(windows), |key| {
        std::env::var_os(key)
    }));
    browser_launch_preflight_from_candidates(
        chromium.as_deref(),
        sandbox_opt_in.as_deref(),
        running_as_root,
        &candidates,
        |candidate| which::which(candidate).ok(),
    )
}

#[cfg(test)]
fn browser_launch_preflight_with(
    chromium: &std::ffi::OsStr,
    sandbox_opt_in: Option<&std::ffi::OsStr>,
    running_as_root: bool,
) -> Result<ChromiumLaunch> {
    browser_launch_preflight_from_candidates(
        Some(chromium),
        sandbox_opt_in,
        running_as_root,
        &[],
        |candidate| which::which(candidate).ok(),
    )
}

fn browser_launch_preflight_from_candidates(
    chromium: Option<&std::ffi::OsStr>,
    sandbox_opt_in: Option<&std::ffi::OsStr>,
    running_as_root: bool,
    candidates: &[std::path::PathBuf],
    mut locate: impl FnMut(&std::ffi::OsStr) -> Option<std::path::PathBuf>,
) -> Result<ChromiumLaunch> {
    let sandbox_disabled = sandbox_opt_in == Some(std::ffi::OsStr::new("1"));
    if running_as_root && !sandbox_disabled {
        anyhow::bail!(
            "headless Chromium cannot run as root with its sandbox; run app-server as an unprivileged user or explicitly set KCODER_CHROMIUM_NO_SANDBOX=1 in an isolated test environment"
        )
    }
    let executable = if let Some(chromium) = chromium {
        // An explicit override is authoritative, including an invalid or empty value.
        (!chromium.is_empty()).then(|| locate(chromium)).flatten().with_context(|| {
            format!(
                "failed to locate executable Chromium {:?}; set KCODER_CHROMIUM_BIN to a valid Chromium, Chrome, or Edge executable path",
                chromium
            )
        })?
    } else {
        candidates.iter().find_map(|candidate| locate(candidate.as_os_str())).context(
            "failed to locate executable Chromium; install Chromium, Chrome, or Edge on PATH (standard Windows installation directories are also checked), or set KCODER_CHROMIUM_BIN to its executable path",
        )?
    };
    Ok(ChromiumLaunch {
        executable,
        sandbox_disabled,
    })
}

pub(super) fn browser_sessions_available() -> bool {
    browser_preflight_result().available
}

pub(super) fn browser_preflight_result() -> kcoder_app_protocol::BrowserPreflightResult {
    match browser_launch_preflight() {
        Ok(_) => kcoder_app_protocol::BrowserPreflightResult {
            available: true,
            reason: None,
        },
        Err(error) => {
            tracing::debug!(%error, "browser sessions are unavailable");
            kcoder_app_protocol::BrowserPreflightResult {
                available: false,
                reason: Some(error.to_string()),
            }
        }
    }
}

async fn browser_start(
    engine_session_id: &str,
    sequence: u64,
    params: BrowserStartParams,
    sessions: &mut HashMap<String, BrowserSession>,
) -> Result<BrowserStartResult> {
    if sessions.len() >= MAX_BROWSER_SESSIONS {
        anyhow::bail!("browser session limit reached")
    }
    let url = validate_browser_url(&params.url)?;
    let width = params.width.clamp(320, 1920);
    let height = params.height.clamp(240, 1080);
    let ChromiumLaunch {
        executable: chromium,
        sandbox_disabled,
    } = browser_launch_preflight()?;
    let profile = tempfile::Builder::new()
        .prefix("kcoder-studio-chromium-")
        .tempdir()
        .context("failed to create private Chromium profile")?;
    if sandbox_disabled {
        tracing::warn!(
            "headless Chromium sandbox is explicitly disabled; only use this in an isolated test environment"
        );
    }
    let mut chromium_args = vec![
        "--headless=new".to_owned(),
        "--disable-dev-shm-usage".to_owned(),
        "--disable-gpu".to_owned(),
        "--hide-scrollbars".to_owned(),
        // Model processes may inherit HTTP(S)_PROXY, but the managed development browser must connect directly and deterministically to loopback/Tailscale targets.
        "--no-proxy-server".to_owned(),
        "--remote-debugging-port=0".to_owned(),
        format!("--user-data-dir={}", profile.path().display()),
        format!("--window-size={width},{height}"),
        "about:blank".to_owned(),
    ];
    if sandbox_disabled {
        chromium_args.push("--no-sandbox".to_owned());
    }
    #[cfg(not(windows))]
    let child = {
        let mut command = Command::new(&chromium);
        command
            .args(&chromium_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .spawn()
            .context("failed to start headless Chromium")?
    };
    #[cfg(windows)]
    let child = {
        let spec = SpawnSpec {
            executable: chromium,
            cwd: std::env::current_dir()?,
            args: chromium_args.into_iter().map(Into::into).collect(),
            env: std::env::vars_os().collect(),
        };
        SupervisedChild::spawn(
            spec,
            &locate_supervisor_or_sibling("KCODER_PROCESS_SUPERVISOR_BIN")?,
        )
        .context("failed to start headless Chromium through the Windows supervisor")?
    };
    let mut process = OwnedChromiumProcess::new(child);
    let stderr = process
        .take_stderr()
        .context("Chromium stderr is unavailable")?;
    let mut lines = BufReader::new(stderr).lines();
    let browser_ws = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut startup_errors = VecDeque::new();
        while let Some(line) = lines.next_line().await? {
            if let Some(value) = line.split("DevTools listening on ").nth(1) {
                return Ok::<_, anyhow::Error>(value.trim().to_owned());
            }
            remember_chromium_startup_error(&mut startup_errors, &line);
        }
        if startup_errors.is_empty() {
            anyhow::bail!("Chromium exited before publishing its DevTools endpoint")
        }
        anyhow::bail!(
            "Chromium exited before publishing its DevTools endpoint: {}",
            startup_errors.into_iter().collect::<Vec<_>>().join(" | ")
        )
    })
    .await
    .context("timed out starting headless Chromium")??;
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    reqwest::Url::parse(&browser_ws).context("invalid Chromium DevTools endpoint")?;
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BROWSER_CDP_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_BROWSER_CDP_MESSAGE_BYTES));
    let (socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        connect_async_with_config(&browser_ws, Some(websocket_config), false),
    )
    .await
    .context("timed out connecting to Chromium browser target")?
    .context("failed to connect to Chromium browser target")?;
    let session_id = format!(
        "browser-{}-{sequence}",
        &engine_session_id[..engine_session_id.len().min(16)]
    );
    let mut socket = socket;
    let mut next_command_id = 0;
    browser_cdp_command_raw(
        &mut socket,
        &mut next_command_id,
        None,
        "Browser.setDownloadBehavior",
        json!({"behavior": "deny", "eventsEnabled": false}),
    )
    .await
    .context("failed to disable remote browser downloads")?;
    let initial_target_ids = browser_page_targets(&mut socket, &mut next_command_id)
        .await?
        .into_iter()
        .map(|target| target.target_id)
        .collect::<Vec<_>>();
    let (target_id, cdp_session_id, _) =
        browser_prepare_target(&mut socket, &mut next_command_id, &url, width, height).await?;
    browser_cdp_command_raw(
        &mut socket,
        &mut next_command_id,
        None,
        "Target.activateTarget",
        json!({"targetId": target_id}),
    )
    .await?;
    let mut session = BrowserSession {
        socket,
        cdp_session_id,
        target_id,
        process,
        _profile: profile,
        next_command_id,
        width,
        height,
        history: vec![url.clone()],
        history_index: 0,
    };
    browser_cdp_command(&mut session, "Page.bringToFront", json!({})).await?;
    for initial_target_id in initial_target_ids {
        let _ = browser_close_target(
            &mut session.socket,
            &mut session.next_command_id,
            &initial_target_id,
        )
        .await;
    }
    sessions.insert(session_id.clone(), session);
    Ok(BrowserStartResult {
        session_id,
        url,
        width,
        height,
        sandbox_disabled,
    })
}

async fn browser_screenshot(
    sessions: &mut HashMap<String, BrowserSession>,
    session_id: &str,
) -> Result<BrowserScreenshotResult> {
    let session = sessions
        .get_mut(session_id)
        .context("browser session not found")?;
    // target=_blank creates a new page target. Adopt it before capture so commands are not sent to the suspended opener.
    browser_adopt_ready_popup(session).await?;
    let state_before = browser_page_state(session).await?;
    let url_before = validate_browser_url(&state_before.url)
        .context("Chromium active page URL is not allowed")?;
    let result = browser_cdp_command(
        session,
        "Page.captureScreenshot",
        json!({"format": "jpeg", "quality": 70, "fromSurface": true, "captureBeyondViewport": false}),
    )
    .await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .context("Chromium screenshot did not contain image data")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .context("Chromium screenshot returned invalid base64")?;
    if decoded.len() > MAX_BROWSER_FRAME_BYTES {
        anyhow::bail!("browser frame exceeds transport limit")
    }
    let state = browser_page_state(session).await?;
    let url = validate_browser_url(&state.url)
        .context("Chromium active page URL changed to a disallowed value")?;
    browser_record_observed_history(session, &url_before);
    browser_record_observed_history(session, &url);
    // In-page clicks may create new history entries; the current capture must immediately reflect the observed navigation boundary.
    let state =
        browser_page_state_with_history(state, session.history.len(), session.history_index);
    let result = BrowserScreenshotResult {
        session_id: session_id.to_owned(),
        data_base64: data.to_owned(),
        mime_type: "image/jpeg".to_owned(),
        width: session.width,
        height: session.height,
        page: state,
    };
    if serde_json::to_vec(&result)?.len() > MAX_DEVICE_RESULT_BYTES {
        anyhow::bail!("browser frame exceeds JSON transport limit")
    }
    Ok(result)
}

fn browser_point(session: &BrowserSession, x: f64, y: f64) -> Result<(f64, f64)> {
    clamp_browser_point(session.width, session.height, x, y)
}

fn clamp_browser_point(width: u32, height: u32, x: f64, y: f64) -> Result<(f64, f64)> {
    if !x.is_finite() || !y.is_finite() {
        anyhow::bail!("browser pointer coordinates must be finite")
    }
    Ok((
        x.clamp(0.0, width.saturating_sub(1) as f64),
        y.clamp(0.0, height.saturating_sub(1) as f64),
    ))
}

fn browser_record_observed_history(session: &mut BrowserSession, url: &str) {
    record_observed_history(&mut session.history, &mut session.history_index, url);
}

fn record_observed_history(history: &mut Vec<String>, history_index: &mut usize, url: &str) {
    if url.is_empty()
        || url == "about:blank"
        || history.get(*history_index).map(String::as_str) == Some(url)
    {
        return;
    }
    history.truncate(*history_index + 1);
    history.push(url.to_owned());
    *history_index = history.len() - 1;
    while history.len() > MAX_BROWSER_HISTORY_ENTRIES
        || history.iter().map(String::len).sum::<usize>() > MAX_BROWSER_HISTORY_BYTES
    {
        history.remove(0);
        *history_index = (*history_index).saturating_sub(1);
    }
}

async fn browser_action(
    sessions: &mut HashMap<String, BrowserSession>,
    params: BrowserActionParams,
) -> Result<BrowserActionResult> {
    let session = sessions
        .get_mut(&params.session_id)
        .context("browser session not found")?;
    let page_changed = match params.action {
        BrowserAction::Navigate { url } => {
            let url = validate_browser_url(&url)?;
            let state = browser_replace_target(session, &url).await?;
            let final_url = validate_browser_url(&state.url)?;
            browser_record_observed_history(session, &final_url);
            true
        }
        BrowserAction::Reload => {
            let url = session.history[session.history_index].clone();
            browser_replace_target(session, &url).await?;
            true
        }
        BrowserAction::Back => {
            if session.history_index > 0 {
                let next_index = session.history_index - 1;
                let url = session.history[next_index].clone();
                browser_replace_target(session, &url).await?;
                session.history_index = next_index;
            }
            true
        }
        BrowserAction::Forward => {
            if session.history_index + 1 < session.history.len() {
                let next_index = session.history_index + 1;
                let url = session.history[next_index].clone();
                browser_replace_target(session, &url).await?;
                session.history_index = next_index;
            }
            true
        }
        BrowserAction::Resize { width, height } => {
            let width = width.clamp(320, 1920);
            let height = height.clamp(240, 1080);
            browser_cdp_command(
                session,
                "Emulation.setDeviceMetricsOverride",
                json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}),
            )
            .await?;
            session.width = width;
            session.height = height;
            false
        }
        BrowserAction::Click { x, y } => {
            let (x, y) = browser_point(session, x, y)?;
            for kind in ["mousePressed", "mouseReleased"] {
                browser_cdp_command(
                    session,
                    "Input.dispatchMouseEvent",
                    json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
                )
                .await?;
            }
            false
        }
        BrowserAction::Wheel {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            let (x, y) = browser_point(session, x, y)?;
            if !delta_x.is_finite() || !delta_y.is_finite() {
                anyhow::bail!("browser wheel deltas must be finite")
            }
            browser_cdp_command(
                session,
                "Input.dispatchMouseEvent",
                json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x.clamp(-10000.0, 10000.0), "deltaY": delta_y.clamp(-10000.0, 10000.0)}),
            )
            .await?;
            false
        }
        BrowserAction::PointerMove { x, y } => {
            let (x, y) = browser_point(session, x, y)?;
            browser_cdp_command(
                session,
                "Input.dispatchMouseEvent",
                json!({"type": "mouseMoved", "x": x, "y": y}),
            )
            .await?;
            false
        }
        BrowserAction::PointerDown { x, y } | BrowserAction::PointerUp { x, y } => {
            let (x, y) = browser_point(session, x, y)?;
            let kind = if matches!(params.action, BrowserAction::PointerDown { .. }) {
                "mousePressed"
            } else {
                "mouseReleased"
            };
            browser_cdp_command(
                session,
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
            )
            .await?;
            false
        }
        BrowserAction::Text { text } => {
            if text.len() > 16 * 1024 {
                anyhow::bail!("browser text input is too large")
            }
            browser_cdp_command(session, "Input.insertText", json!({"text": text})).await?;
            false
        }
        BrowserAction::Key { key } => {
            if key.len() > 64 {
                anyhow::bail!("browser key is too large")
            }
            let (code, virtual_key) = browser_key_descriptor(&key);
            for kind in ["rawKeyDown", "keyUp"] {
                browser_cdp_command(
                    session,
                    "Input.dispatchKeyEvent",
                    browser_key_event_payload(kind, &key, &code, virtual_key),
                )
                .await?;
            }
            false
        }
        BrowserAction::Shortcut { key, modifiers } => {
            if key.len() > 64 || modifiers.len() > 4 {
                anyhow::bail!("browser shortcut is too large")
            }
            let mut modifier_bits = 0_u8;
            let mut modifier_events = Vec::with_capacity(modifiers.len());
            for modifier in modifiers {
                let event = match modifier.as_str() {
                    "Alt" => ("Alt", "AltLeft", 18_u32, 1_u8),
                    "Control" => ("Control", "ControlLeft", 17_u32, 2_u8),
                    "Meta" => ("Meta", "MetaLeft", 91_u32, 4_u8),
                    "Shift" => ("Shift", "ShiftLeft", 16_u32, 8_u8),
                    _ => anyhow::bail!("unsupported browser shortcut modifier"),
                };
                if modifier_bits & event.3 != 0 {
                    anyhow::bail!("browser shortcut contains a duplicate modifier")
                }
                modifier_bits |= event.3;
                modifier_events.push(event);
                browser_cdp_command(
                    session,
                    "Input.dispatchKeyEvent",
                    json!({"type": "rawKeyDown", "key": event.0, "code": event.1, "windowsVirtualKeyCode": event.2, "nativeVirtualKeyCode": event.2, "modifiers": modifier_bits}),
                )
                .await?;
            }
            let (code, virtual_key) = browser_key_descriptor(&key);
            for kind in ["rawKeyDown", "keyUp"] {
                browser_cdp_command(
                    session,
                    "Input.dispatchKeyEvent",
                    json!({"type": kind, "key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "nativeVirtualKeyCode": virtual_key, "modifiers": modifier_bits}),
                )
                .await?;
            }
            for event in modifier_events.into_iter().rev() {
                modifier_bits &= !event.3;
                browser_cdp_command(
                    session,
                    "Input.dispatchKeyEvent",
                    json!({"type": "keyUp", "key": event.0, "code": event.1, "windowsVirtualKeyCode": event.2, "nativeVirtualKeyCode": event.2, "modifiers": modifier_bits}),
                )
                .await?;
            }
            false
        }
    };
    let page = if page_changed {
        Some(browser_page_state(session).await?)
    } else {
        None
    };
    Ok(BrowserActionResult {
        accepted: true,
        page,
    })
}

fn browser_key_descriptor(key: &str) -> (String, u32) {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_alphabetic() {
        let upper = key.to_ascii_uppercase();
        return (format!("Key{upper}"), upper.as_bytes()[0] as u32);
    }
    if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() {
        return (format!("Digit{key}"), key.as_bytes()[0] as u32);
    }
    match key {
        "Enter" => ("Enter".to_string(), 13),
        "Tab" => ("Tab".to_string(), 9),
        "Escape" => ("Escape".to_string(), 27),
        "Backspace" => ("Backspace".to_string(), 8),
        "Delete" => ("Delete".to_string(), 46),
        "ArrowLeft" => ("ArrowLeft".to_string(), 37),
        "ArrowUp" => ("ArrowUp".to_string(), 38),
        "ArrowRight" => ("ArrowRight".to_string(), 39),
        "ArrowDown" => ("ArrowDown".to_string(), 40),
        _ => (key.to_string(), 0),
    }
}

fn browser_key_event_payload(kind: &str, key: &str, code: &str, virtual_key: u32) -> Value {
    let is_enter_down = kind == "rawKeyDown" && key == "Enter";
    let mut payload = json!({
        "type": if is_enter_down { "keyDown" } else { kind },
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": virtual_key,
        "nativeVirtualKeyCode": virtual_key,
    });
    if is_enter_down {
        payload["text"] = Value::String("\r".into());
        payload["unmodifiedText"] = Value::String("\r".into());
    }
    payload
}

async fn browser_evaluate(
    sessions: &mut HashMap<String, BrowserSession>,
    params: BrowserEvaluateParams,
) -> Result<BrowserEvaluateResult> {
    if params.expression.len() > MAX_BROWSER_EVALUATE_BYTES {
        anyhow::bail!("browser expression is too large")
    }
    let session = sessions
        .get_mut(&params.session_id)
        .context("browser session not found")?;
    let result = browser_cdp_command(
        session,
        "Runtime.evaluate",
        json!({"expression": params.expression, "returnByValue": true, "awaitPromise": true}),
    )
    .await?;
    if let Some(description) = result
        .get("exceptionDetails")
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str)
    {
        anyhow::bail!("browser evaluation failed: {description}")
    }
    let value = result
        .get("result")
        .and_then(|value| value.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    if serde_json::to_vec(&value)?.len() > MAX_BROWSER_EVALUATE_BYTES {
        anyhow::bail!("browser evaluation result is too large")
    }
    Ok(BrowserEvaluateResult { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn cdp_fixture(
        reply: impl Fn(&Value) -> Value + Send + 'static,
    ) -> (BrowserSocket, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut commands = Vec::new();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let command: Value = serde_json::from_str(&text).unwrap();
                let mut response = reply(&command);
                response["id"] = command["id"].clone();
                commands.push(command);
                if socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            commands
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        (socket, task)
    }

    fn navigation_fixture_reply(command: &Value, fail_navigation: bool) -> Value {
        let result = match command["method"].as_str().unwrap() {
            "Target.createTarget" => {
                assert_eq!(command["params"]["url"], "about:blank");
                json!({"targetId":"candidate"})
            }
            "Target.attachToTarget" => json!({"sessionId":"candidate-session"}),
            "Page.navigate" if fail_navigation => json!({"errorText":"net::ERR_NAME_NOT_RESOLVED"}),
            "Runtime.evaluate" => {
                json!({"result":{"value":{"url":"https://fixture.invalid/ready","title":"Ready"}}})
            }
            "Target.closeTarget" => json!({"success":true}),
            _ => json!({}),
        };
        json!({"result":result})
    }

    #[tokio::test]
    async fn browser_navigation_attaches_before_navigating_and_cleans_failed_candidates() {
        for failure in [false, true] {
            let (mut socket, task) =
                cdp_fixture(move |command| navigation_fixture_reply(command, failure)).await;
            let result =
                browser_prepare_target(&mut socket, &mut 0, "https://fixture.invalid/", 800, 600)
                    .await;
            drop(socket);
            let commands = task.await.unwrap();
            let methods = commands
                .iter()
                .map(|command| command["method"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(
                methods
                    .iter()
                    .position(|method| *method == "Target.attachToTarget")
                    .unwrap()
                    < methods
                        .iter()
                        .position(|method| *method == "Page.navigate")
                        .unwrap()
            );
            if failure {
                assert!(
                    format!("{:#}", result.unwrap_err()).contains("net::ERR_NAME_NOT_RESOLVED")
                );
                assert_eq!(commands.last().unwrap()["method"], "Target.closeTarget");
                assert_eq!(commands.last().unwrap()["params"]["targetId"], "candidate");
                assert!(!methods.contains(&"Runtime.evaluate"));
            } else {
                assert_eq!(result.unwrap().2.url, "https://fixture.invalid/ready");
            }
        }
    }

    #[tokio::test]
    async fn browser_navigation_cleans_candidates_for_ready_or_final_url_failures() {
        for result in [
            json!({"exceptionDetails":{"text":"Uncaught"}}),
            json!({"result":{"value":{"url":"file:///private/document"}}}),
        ] {
            let (mut socket, task) = cdp_fixture(move |command| {
                if command["method"] == "Runtime.evaluate" {
                    json!({"result":result})
                } else {
                    navigation_fixture_reply(command, false)
                }
            })
            .await;
            let prepared =
                browser_prepare_target(&mut socket, &mut 0, "https://fixture.invalid/", 800, 600)
                    .await;
            drop(socket);
            let commands = task.await.unwrap();
            assert!(prepared.is_err());
            assert_eq!(commands.last().unwrap()["method"], "Target.closeTarget");
            assert_eq!(commands.last().unwrap()["params"]["targetId"], "candidate");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_navigation_commits_only_after_ready_and_successful_old_target_close() {
        for close_failure in [false, true] {
            let (socket, task) = cdp_fixture(move |command| {
                if close_failure
                    && command["method"] == "Target.closeTarget"
                    && command["params"]["targetId"] == "original"
                {
                    json!({"result":{"success":false}})
                } else {
                    navigation_fixture_reply(command, false)
                }
            })
            .await;
            let child = Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap();
            let mut session = BrowserSession {
                socket,
                cdp_session_id: "original-session".into(),
                target_id: "original".into(),
                process: OwnedChromiumProcess::new(child),
                _profile: tempfile::tempdir().unwrap(),
                next_command_id: 0,
                width: 800,
                height: 600,
                history: vec!["https://original.invalid/".into()],
                history_index: 0,
            };
            let result = browser_replace_target(&mut session, "https://fixture.invalid/").await;
            assert_eq!(result.is_err(), close_failure);
            assert_eq!(
                session.target_id,
                if close_failure {
                    "original"
                } else {
                    "candidate"
                }
            );
            assert_eq!(
                session.cdp_session_id,
                if close_failure {
                    "original-session"
                } else {
                    "candidate-session"
                }
            );
            session.process.terminate().await.unwrap();
            drop(session);
            let commands = task.await.unwrap();
            let ready = commands
                .iter()
                .position(|command| command["method"] == "Runtime.evaluate")
                .unwrap();
            let close_old = commands
                .iter()
                .position(|command| {
                    command["method"] == "Target.closeTarget"
                        && command["params"]["targetId"] == "original"
                })
                .unwrap();
            assert!(ready < close_old);
            if close_failure {
                assert!(
                    commands
                        .iter()
                        .any(|command| command["method"] == "Target.closeTarget"
                            && command["params"]["targetId"] == "candidate")
                );
                assert_eq!(commands.last().unwrap()["params"]["targetId"], "original");
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_navigation_failure_preserves_old_target_and_session() {
        let (socket, task) = cdp_fixture(|command| navigation_fixture_reply(command, true)).await;
        let child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut session = BrowserSession {
            socket,
            cdp_session_id: "original-session".into(),
            target_id: "original".into(),
            process: OwnedChromiumProcess::new(child),
            _profile: tempfile::tempdir().unwrap(),
            next_command_id: 0,
            width: 800,
            height: 600,
            history: vec!["https://original.invalid/".into()],
            history_index: 0,
        };
        let result = browser_replace_target(&mut session, "https://fixture.invalid/").await;
        assert!(result.is_err());
        assert_eq!(session.target_id, "original");
        assert_eq!(session.cdp_session_id, "original-session");
        assert_eq!(session.history, ["https://original.invalid/"]);
        session.process.terminate().await.unwrap();
        drop(session);
        let commands = task.await.unwrap();
        assert!(
            !commands
                .iter()
                .any(|command| command["method"] == "Target.closeTarget"
                    && command["params"]["targetId"] == "original")
        );
        assert_eq!(commands.last().unwrap()["method"], "Target.activateTarget");
        assert_eq!(commands.last().unwrap()["params"]["targetId"], "original");
    }

    #[tokio::test]
    async fn ready_check_retries_only_known_context_replacement() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = attempts.clone();
        let (mut socket, task) = cdp_fixture(move |_| {
            if observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                json!({"error":{"code":-32000,"message":"Execution context was destroyed."}})
            } else {
                json!({"result":{"result":{"value":{"url":"https://fixture.invalid/"}}}})
            }
        })
        .await;
        assert!(
            browser_wait_until_ready_raw(&mut socket, &mut 0, "page", 1, 0)
                .await
                .is_ok()
        );
        drop(socket);
        task.await.unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn ready_check_accepts_a_single_slow_cdp_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                panic!("expected command")
            };
            let command: Value = serde_json::from_str(&text).unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
            socket.send(Message::Text(json!({"id":command["id"],"result":{"result":{"value":{"url":"https://fixture.invalid/"}}}}).to_string().into())).await.unwrap();
            let next = socket.next().await;
            assert!(
                !matches!(next, Some(Ok(Message::Text(_)))),
                "readiness must not discard and resend the command after two seconds"
            );
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let mut id = 0;
        let result = browser_wait_until_ready_raw(&mut socket, &mut id, "page", 1, 0).await;
        drop(socket);
        task.await.unwrap();
        assert!(result.is_ok());
        assert_eq!(id, 1);
    }

    #[tokio::test]
    async fn ready_check_reports_evaluation_exceptions_without_waiting_thirty_seconds() {
        let (mut socket, task) = cdp_fixture(|_| json!({"result":{
            "exceptionDetails":{"text":"Uncaught","exception":{"description":"TypeError: Invalid URL"}},
            "result":{"type":"object","subtype":"error"}
        }})).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            browser_wait_until_ready_raw(&mut socket, &mut 0, "page", 1, 0),
        )
        .await;
        drop(socket);
        task.await.unwrap();
        let error = result
            .expect("terminal evaluation errors must not be retried")
            .unwrap_err();
        assert!(format!("{error:#}").contains("evaluation"));
    }

    #[tokio::test]
    async fn ready_check_rejects_chromium_network_error_documents() {
        let (mut socket, task) = cdp_fixture(|_| {
            json!({"result":{"result":{"value":{
                "url":"chrome-error://chromewebdata/","title":"Unavailable"
            }}}})
        })
        .await;
        let result = browser_wait_until_ready_raw(&mut socket, &mut 0, "page", 1, 0).await;
        drop(socket);
        task.await.unwrap();
        assert!(
            result.is_err(),
            "Chromium error documents must not count as ready"
        );
    }

    #[tokio::test]
    async fn ready_check_preserves_terminal_cdp_failures() {
        let (mut socket, task) =
            cdp_fixture(|_| json!({"error":{"code":-32000,"message":"Session closed"}})).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            browser_wait_until_ready_raw(&mut socket, &mut 0, "page", 1, 0),
        )
        .await;
        drop(socket);
        task.await.unwrap();
        assert!(
            format!(
                "{:#}",
                result
                    .expect("closed sessions must fail immediately")
                    .unwrap_err()
            )
            .contains("Session closed")
        );
    }

    #[test]
    fn bundled_chromium_candidates_cover_desktop_and_system_installation_layouts() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("bin");
        let binary = directory.join("kcoder");
        assert_eq!(
            bundled_chromium_candidates(&binary, false),
            vec![
                directory.join("chrome/chrome-linux64/chrome"),
                root.path().join("lib/kcoder/chrome/chrome-linux64/chrome"),
            ]
        );
        assert_eq!(
            bundled_chromium_candidates(&binary, true),
            vec![directory.join("chrome/chrome-win64/chrome.exe")]
        );
        assert!(bundled_chromium_candidates(std::path::Path::new("kcoder"), false).is_empty());
    }

    #[test]
    fn non_windows_chromium_candidates_find_installed_google_chrome() {
        let candidates = default_chromium_candidates(false, |_| None);
        let installed = std::path::PathBuf::from("/usr/bin/google-chrome");
        let result =
            browser_launch_preflight_from_candidates(None, None, false, &candidates, |name| {
                (name == std::ffi::OsStr::new("google-chrome")).then(|| installed.clone())
            })
            .unwrap();
        assert_eq!(result.executable, installed);
        assert!(!result.sandbox_disabled);
    }

    #[test]
    fn windows_chromium_candidates_include_path_and_standard_installations() {
        let base = std::env::current_dir().unwrap();
        let roots = [
            ("ProgramFiles", base.join("Program Files")),
            ("ProgramFiles(x86)", base.join("Program Files (x86)")),
            ("LOCALAPPDATA", base.join("Users/Test User/AppData/Local")),
        ];
        let candidates = default_chromium_candidates(true, |key| {
            roots
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, path)| path.clone().into_os_string())
        });
        let mut expected = vec![
            std::path::PathBuf::from("chromium"),
            "chrome".into(),
            "msedge".into(),
        ];
        for (_, root) in roots {
            for relative in [
                "Google/Chrome/Application/chrome.exe",
                "Microsoft/Edge/Application/msedge.exe",
                "Chromium/Application/chrome.exe",
            ] {
                expected.push(root.join(relative));
            }
        }
        assert_eq!(candidates, expected);
    }

    #[test]
    fn windows_chromium_candidates_skip_missing_empty_and_relative_environment_roots() {
        for root in [None, Some(""), Some("relative-folder")] {
            assert_eq!(
                default_chromium_candidates(true, |_| root.map(Into::into)),
                vec![
                    std::path::PathBuf::from("chromium"),
                    "chrome".into(),
                    "msedge".into()
                ]
            );
        }
    }

    #[test]
    fn non_windows_chromium_candidates_keep_chromium_first_and_include_chrome() {
        assert_eq!(
            default_chromium_candidates(false, |_| panic!("must not inspect Windows environment")),
            [
                "chromium",
                "chromium-browser",
                "google-chrome",
                "google-chrome-stable",
                "microsoft-edge",
                "microsoft-edge-stable"
            ]
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn windows_chromium_discovery_uses_first_available_candidate_and_keeps_sandbox() {
        let root = std::env::current_dir().unwrap().join("Program Files (x86)");
        let candidates = default_chromium_candidates(true, |_| Some(root.clone().into_os_string()));
        for expected in &candidates {
            let mut visited = Vec::new();
            let launch = browser_launch_preflight_from_candidates(
                None,
                None,
                false,
                &candidates,
                |candidate| {
                    visited.push(std::path::PathBuf::from(candidate));
                    (candidate == expected.as_os_str()).then(|| expected.clone())
                },
            )
            .unwrap();
            assert_eq!(launch.executable, *expected);
            assert!(!launch.sandbox_disabled);
            let index = candidates.iter().position(|path| path == expected).unwrap();
            assert_eq!(visited, candidates[..=index]);
        }
    }

    #[test]
    fn windows_chromium_discovery_never_falls_back_from_explicit_override() {
        let candidates = default_chromium_candidates(true, |_| None);
        for override_value in ["custom browser.exe", "missing browser.exe", ""] {
            let mut visited = Vec::new();
            let result = browser_launch_preflight_from_candidates(
                Some(std::ffi::OsStr::new(override_value)),
                None,
                false,
                &candidates,
                |candidate| {
                    visited.push(candidate.to_owned());
                    (candidate != "missing browser.exe").then(|| candidate.into())
                },
            );
            assert_eq!(result.is_ok(), override_value == "custom browser.exe");
            assert!(visited.iter().all(|candidate| candidate == override_value));
            if let Err(error) = result {
                assert!(error.to_string().contains("KCODER_CHROMIUM_BIN"));
            }
        }
    }

    #[test]
    fn windows_chromium_discovery_reports_no_browser_installed() {
        let candidates = default_chromium_candidates(true, |_| None);
        let error =
            browser_launch_preflight_from_candidates(None, None, false, &candidates, |_| None)
                .unwrap_err();
        assert!(error.to_string().contains("Chrome, or Edge"));
        assert!(error.to_string().contains("KCODER_CHROMIUM_BIN"));
    }

    #[test]
    fn browser_launch_preflight_requires_explicit_root_sandbox_opt_in() {
        let executable = std::env::current_exe().unwrap();
        for value in [None, Some("0"), Some("true"), Some("")] {
            let error = browser_launch_preflight_with(
                executable.as_os_str(),
                value.map(std::ffi::OsStr::new),
                true,
            )
            .unwrap_err();
            assert!(error.to_string().contains("cannot run as root"));
        }
        let launch = browser_launch_preflight_with(
            executable.as_os_str(),
            Some(std::ffi::OsStr::new("1")),
            true,
        )
        .unwrap();
        assert!(launch.sandbox_disabled);
        assert_eq!(launch.executable, executable);
    }

    #[test]
    fn browser_launch_preflight_keeps_sandbox_for_unprivileged_users() {
        let executable = std::env::current_exe().unwrap();
        let launch = browser_launch_preflight_with(executable.as_os_str(), None, false).unwrap();
        assert!(!launch.sandbox_disabled);
        assert_eq!(launch.executable, executable);
    }

    #[test]
    fn browser_launch_preflight_rejects_missing_or_non_executable_files() {
        let directory = tempfile::tempdir().unwrap();
        for path in [
            directory.path().join("missing-chromium"),
            directory.path().to_owned(),
        ] {
            let error = browser_launch_preflight_with(path.as_os_str(), None, false).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("failed to locate executable Chromium")
            );
            assert!(error.to_string().contains("KCODER_CHROMIUM_BIN"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn browser_launch_preflight_rejects_file_without_execute_permission() {
        use std::os::unix::fs::PermissionsExt;

        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(browser_launch_preflight_with(file.path().as_os_str(), None, false).is_err());
    }

    #[test]
    fn browser_launch_preflight_root_opt_in_still_requires_executable() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing-chromium");
        let error = browser_launch_preflight_with(
            missing.as_os_str(),
            Some(std::ffi::OsStr::new("1")),
            true,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("failed to locate executable Chromium")
        );
    }

    #[test]
    fn browser_launch_preflight_matches_server_capability() {
        assert_eq!(
            super::super::server_capabilities(false).experimental["browserSessions"],
            browser_launch_preflight().is_ok(),
        );
    }

    #[test]
    fn chromium_startup_errors_are_bounded_to_recent_sanitized_lines() {
        let mut lines = VecDeque::new();
        remember_chromium_startup_error(&mut lines, "   ");
        for index in 0..(MAX_CHROMIUM_STARTUP_ERROR_LINES + 3) {
            remember_chromium_startup_error(&mut lines, &format!(" error-{index} "));
        }
        remember_chromium_startup_error(
            &mut lines,
            &"x".repeat(MAX_CHROMIUM_STARTUP_ERROR_LINE_CHARS + 20),
        );

        assert_eq!(lines.len(), MAX_CHROMIUM_STARTUP_ERROR_LINES);
        assert!(!lines.iter().any(|line| line == "error-0"));
        assert_eq!(
            lines.back().unwrap().chars().count(),
            MAX_CHROMIUM_STARTUP_ERROR_LINE_CHARS
        );
    }

    #[test]
    fn browser_url_rejects_credentials_and_non_http_schemes() {
        for invalid in [
            "https://user@example.com/",
            "https://user:secret@example.com/",
            "file:///tmp/index.html",
            "data:text/plain,hello",
            "https://",
        ] {
            assert!(validate_browser_url(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            validate_browser_url("https://example.com/path").unwrap(),
            "https://example.com/path"
        );
    }

    #[test]
    fn close_target_requires_chromium_success_acknowledgement() {
        assert!(validate_close_target_result(&json!({"success": true})).is_ok());
        for rejected in [
            json!({"success": false}),
            json!({}),
            json!({"success": "true"}),
        ] {
            assert!(validate_close_target_result(&rejected).is_err());
        }
    }

    #[test]
    fn browser_point_rejects_non_finite_values_and_clamps_viewport() {
        for (x, y) in [
            (f64::NAN, 0.0),
            (0.0, f64::INFINITY),
            (f64::NEG_INFINITY, 0.0),
        ] {
            assert!(clamp_browser_point(800, 600, x, y).is_err());
        }
        assert_eq!(
            clamp_browser_point(800, 600, -10.0, 900.0).unwrap(),
            (0.0, 599.0)
        );
    }

    #[test]
    fn browser_key_descriptors_include_chromium_virtual_key_metadata() {
        assert_eq!(browser_key_descriptor("Backspace"), ("Backspace".into(), 8));
        assert_eq!(browser_key_descriptor("Enter"), ("Enter".into(), 13));
        assert_eq!(browser_key_descriptor("a"), ("KeyA".into(), 65));
        assert_eq!(browser_key_descriptor("7"), ("Digit7".into(), 55));
    }

    #[test]
    fn browser_enter_keydown_carries_text_for_default_form_submission() {
        assert_eq!(
            browser_key_event_payload("rawKeyDown", "Enter", "Enter", 13),
            json!({
                "type": "keyDown",
                "key": "Enter",
                "code": "Enter",
                "windowsVirtualKeyCode": 13,
                "nativeVirtualKeyCode": 13,
                "text": "\r",
                "unmodifiedText": "\r",
            })
        );
        assert_eq!(
            browser_key_event_payload("rawKeyDown", "Backspace", "Backspace", 8)["type"],
            "rawKeyDown"
        );
    }

    #[test]
    fn observed_history_deduplicates_and_truncates_forward_entries() {
        let mut history = vec!["https://one.example/".into(), "https://two.example/".into()];
        let mut index = 0;
        record_observed_history(&mut history, &mut index, "https://one.example/");
        assert_eq!(history.len(), 2);
        record_observed_history(&mut history, &mut index, "about:blank");
        assert_eq!(history.len(), 2);
        record_observed_history(&mut history, &mut index, "https://three.example/");
        assert_eq!(
            history,
            vec!["https://one.example/", "https://three.example/"]
        );
        assert_eq!(index, 1);
    }

    #[test]
    fn page_state_exposes_observed_history_navigation_bounds() {
        let state = || BrowserPageState {
            url: "https://example.com/".into(),
            title: None,
            favicon_url: None,
            can_go_back: None,
            can_go_forward: None,
        };

        let first = browser_page_state_with_history(state(), 2, 0);
        assert_eq!(first.can_go_back, Some(false));
        assert_eq!(first.can_go_forward, Some(true));

        let last = browser_page_state_with_history(state(), 2, 1);
        assert_eq!(last.can_go_back, Some(true));
        assert_eq!(last.can_go_forward, Some(false));

        let invalid = browser_page_state_with_history(state(), 0, usize::MAX);
        assert_eq!(invalid.can_go_back, Some(false));
        assert_eq!(invalid.can_go_forward, Some(false));
    }

    #[test]
    fn observed_history_is_bounded_by_entries_and_bytes() {
        let mut history = vec!["https://initial.example/".into()];
        let mut index = 0;
        for item in 0..(MAX_BROWSER_HISTORY_ENTRIES * 2) {
            let url = format!("https://example.com/{item}/{}", "x".repeat(600));
            record_observed_history(&mut history, &mut index, &url);
        }
        assert!(history.len() <= MAX_BROWSER_HISTORY_ENTRIES);
        assert!(history.iter().map(String::len).sum::<usize>() <= MAX_BROWSER_HISTORY_BYTES);
        assert_eq!(index, history.len() - 1);
        assert!(history.last().unwrap().contains("/255/"));
    }

    #[test]
    fn page_state_fields_and_target_lineage_are_strictly_bounded() {
        let state = BrowserPageState {
            url: "https://example.com/".into(),
            title: Some("x".repeat(MAX_BROWSER_PAGE_FIELD_BYTES + 1)),
            favicon_url: None,
            can_go_back: None,
            can_go_forward: None,
        };
        assert!(validate_page_state_fields(state).is_err());

        let targets = vec![
            BrowserTargetInfo {
                target_id: "created".into(),
                url: "about:blank".into(),
                opener_id: None,
            },
            BrowserTargetInfo {
                target_id: "child".into(),
                url: "https://example.com/".into(),
                opener_id: Some("created".into()),
            },
            BrowserTargetInfo {
                target_id: "unrelated".into(),
                url: "https://example.com/".into(),
                opener_id: None,
            },
        ];
        assert!(target_belongs_to_created_lineage(
            &targets[1],
            &targets,
            "created"
        ));
        assert!(!target_belongs_to_created_lineage(
            &targets[2],
            &targets,
            "created"
        ));
    }

    #[test]
    fn browser_popup_selection_only_adopts_a_ready_child_of_the_active_page() {
        let targets = vec![
            BrowserTargetInfo {
                target_id: "active".into(),
                url: "https://parent.example/".into(),
                opener_id: None,
            },
            BrowserTargetInfo {
                target_id: "blank-child".into(),
                url: "about:blank".into(),
                opener_id: Some("active".into()),
            },
            BrowserTargetInfo {
                target_id: "unrelated-child".into(),
                url: "https://unrelated.example/".into(),
                opener_id: Some("other".into()),
            },
            BrowserTargetInfo {
                target_id: "ready-child".into(),
                url: "https://popup.example/".into(),
                opener_id: Some("active".into()),
            },
        ];

        assert_eq!(
            ready_popup_target(&targets, "active"),
            Some(targets[3].clone())
        );
        assert_eq!(ready_popup_target(&targets, "missing"), None);
    }

    #[tokio::test]
    async fn missing_browser_close_is_idempotent() {
        let mut registry = BrowserRegistry::new();
        let params = BrowserSessionParams {
            session_id: "missing".into(),
        };
        assert!(!registry.close(params.clone()).await.unwrap().closed);
        assert!(!registry.close(params).await.unwrap().closed);
    }

    #[tokio::test]
    async fn failed_browser_start_does_not_advance_session_id() {
        let mut registry = BrowserRegistry::new();
        let params = BrowserStartParams {
            url: "file:///tmp/index.html".into(),
            width: 1024,
            height: 720,
        };
        assert!(registry.start("engine-session", params).await.is_err());
        assert_eq!(registry.next_browser_id, 1);
        assert!(registry.sessions.is_empty());
    }

    #[cfg(unix)]
    fn test_process_tree() -> (OwnedChromiumProcess, i32) {
        let mut command = Command::new("sh");
        command.arg("-c").arg("trap '' TERM; sleep 30 & wait");
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let process = OwnedChromiumProcess::new(command.spawn().unwrap());
        let pgid = process.pgid;
        assert!(process_group_exists(pgid));
        (process, pgid)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_tree_cleanup_is_bounded_and_idempotent() {
        let (mut process, pgid) = test_process_tree();
        process.terminate().await.unwrap();
        process.terminate().await.unwrap();
        assert!(!process_group_exists(pgid));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn initialization_failure_or_disconnect_drops_the_entire_process_tree() {
        let (process, pgid) = test_process_tree();
        let simulated_initialization: Result<()> = (|| {
            let _owner = process;
            anyhow::bail!("simulated initialization failure")
        })();
        assert!(simulated_initialization.is_err());
        assert!(!process_group_exists(pgid));

        let (process, pgid) = test_process_tree();
        drop(process);
        assert!(!process_group_exists(pgid));
    }
}
