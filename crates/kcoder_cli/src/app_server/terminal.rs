use super::{protocol_io::notification, workspace_fs};
use anyhow::{Context, Result};
use kcoder_app_protocol::{
    TerminalAttachParams, TerminalAttachResult, TerminalCloseParams, TerminalCloseResult,
    TerminalExitParams, TerminalListResult, TerminalOutputParams, TerminalResizeParams,
    TerminalSessionInfo, TerminalStartParams, TerminalStartResult, TerminalWriteParams, method,
};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_SESSIONS: usize = 16;
const TERMINAL_INPUT_QUEUE_DEPTH: usize = 64;
const MAX_TERMINAL_TRANSCRIPT_BYTES: usize = 1024 * 1024;

fn interactive_shell() -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        // Do not inherit Unix SHELL/-l semantics from Git Bash or an SSH login.
        for (name, args) in [
            ("pwsh.exe", &["-NoLogo", "-NoProfile"][..]),
            ("powershell.exe", &["-NoLogo", "-NoProfile"][..]),
            ("cmd.exe", &["/D"][..]),
        ] {
            if let Ok(path) = which::which(name) {
                let mut command = CommandBuilder::new(path);
                command.args(args);
                return Ok(command);
            }
        }
        anyhow::bail!(
            "No Windows terminal shell found; install PowerShell or restore the system PATH"
        )
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/bin/bash".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        Ok(command)
    }
}

struct TerminalState {
    cwd: String,
    rows: u16,
    cols: u16,
    transcript: VecDeque<String>,
    transcript_bytes: usize,
    sequence: u64,
    truncated: bool,
}

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input_tx: Mutex<Option<std::sync::mpsc::SyncSender<Vec<u8>>>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    state: Mutex<TerminalState>,
    #[cfg(unix)]
    process_id: Option<u32>,
    closed: AtomicBool,
}

#[derive(Clone, Default)]
pub(super) struct TerminalRegistry(Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>);

impl TerminalRegistry {
    pub(super) fn resource_count(&self) -> Option<usize> {
        // Observation must not wait for a terminal worker or treat contention as zero.
        self.0.try_lock().ok().map(|sessions| sessions.len())
    }
    pub(super) fn shutdown_all(&self) {
        let sessions = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            mark_closed(&session);
            session
                .input_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let _ = terminate(&session);
        }
    }
}

pub(super) struct TerminalRegistryGuard(pub(super) TerminalRegistry);

impl Drop for TerminalRegistryGuard {
    fn drop(&mut self) {
        self.0.shutdown_all();
    }
}

pub(super) async fn start(
    workspace_root: &Path,
    engine_session_id: &str,
    terminal_number: u64,
    params: TerminalStartParams,
    terminals: TerminalRegistry,
    outbound_tx: mpsc::Sender<Value>,
) -> Result<TerminalStartResult> {
    if terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
        >= MAX_TERMINAL_SESSIONS
    {
        anyhow::bail!("terminal session limit reached")
    }
    let root = workspace_fs::canonicalize_for_client(workspace_root).with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let requested_cwd = params.cwd.as_deref().map(Path::new).unwrap_or(&root);
    let cwd = workspace_fs::path(&root, requested_cwd).await?;
    if !tokio::fs::metadata(&cwd).await?.is_dir() {
        anyhow::bail!("terminal cwd is not a directory")
    }
    let rows = params.rows.clamp(2, 500);
    let cols = params.cols.clamp(2, 500);
    let pair = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = interactive_shell()?;
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(command)
        .context("failed to start interactive terminal shell")?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (input_tx, input_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(TERMINAL_INPUT_QUEUE_DEPTH);
    if let Err(error) = std::thread::Builder::new()
        .name(format!("kcoder-terminal-input-{terminal_number}"))
        .spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        })
    {
        let _ = child.kill();
        return Err(error).context("failed to start terminal input writer");
    }
    let session_id = format!(
        "terminal-{}-{engine_session_id}-{terminal_number}",
        std::process::id()
    );
    #[cfg(unix)]
    let process_id = child.process_id();
    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        input_tx: Mutex::new(Some(input_tx)),
        child: Mutex::new(child),
        state: Mutex::new(TerminalState {
            cwd: cwd.to_string_lossy().into_owned(),
            rows,
            cols,
            transcript: VecDeque::new(),
            transcript_bytes: 0,
            sequence: 0,
            truncated: false,
        }),
        #[cfg(unix)]
        process_id,
        closed: AtomicBool::new(false),
    });
    terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.clone(), Arc::clone(&session));

    let reader_session_id = session_id.clone();
    let reader_terminals = terminals.clone();
    let reader_session = Arc::clone(&session);
    if let Err(error) = std::thread::Builder::new()
        .name(format!("kcoder-terminal-{terminal_number}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            let mut pending_utf8 = Vec::with_capacity(4);
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let data = decode_bytes(&mut pending_utf8, &buffer[..length], false);
                        if data.is_empty() {
                            continue;
                        }
                        let sequence = record_output(&reader_session, &data);
                        let params = TerminalOutputParams {
                            session_id: reader_session_id.clone(),
                            data,
                            sequence,
                        };
                        if outbound_tx
                            .blocking_send(notification(
                                method::TERMINAL_OUTPUT,
                                serde_json::to_value(params).expect("terminal output serializes"),
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let final_data = decode_bytes(&mut pending_utf8, &[], true);
            if !final_data.is_empty() {
                let sequence = record_output(&reader_session, &final_data);
                let params = TerminalOutputParams {
                    session_id: reader_session_id.clone(),
                    data: final_data,
                    sequence,
                };
                let _ = outbound_tx.blocking_send(notification(
                    method::TERMINAL_OUTPUT,
                    serde_json::to_value(params).expect("terminal output serializes"),
                ));
            }
            mark_closed(&reader_session);
            reader_session
                .input_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let mut registry = reader_terminals
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if registry
                .get(&reader_session_id)
                .is_some_and(|registered| Arc::ptr_eq(registered, &reader_session))
            {
                registry.remove(&reader_session_id);
            }
            drop(registry);
            let exit_code = reader_session
                .child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .wait()
                .ok()
                .map(|status| status.exit_code());
            let sequence = next_sequence(&reader_session);
            let params = TerminalExitParams {
                session_id: reader_session_id,
                sequence,
                exit_code,
            };
            let _ = outbound_tx.blocking_send(notification(
                method::TERMINAL_EXIT,
                serde_json::to_value(params).expect("terminal exit serializes"),
            ));
        })
    {
        if let Some(session) = terminals
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id)
        {
            mark_closed(&session);
            session
                .input_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let _ = terminate(&session);
        }
        return Err(error).context("failed to start terminal output reader");
    }

    Ok(TerminalStartResult {
        session_id,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

pub(super) fn list(terminals: &TerminalRegistry) -> TerminalListResult {
    let registry = terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut sessions = registry
        .iter()
        .filter(|(_, session)| !session.closed.load(Ordering::Acquire))
        .map(|(session_id, session)| {
            let state = session
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            TerminalSessionInfo {
                session_id: session_id.clone(),
                cwd: state.cwd.clone(),
                rows: state.rows,
                cols: state.cols,
                through_sequence: state.sequence,
                truncated: state.truncated,
            }
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    TerminalListResult { sessions }
}

pub(super) fn attach(
    terminals: &TerminalRegistry,
    params: TerminalAttachParams,
) -> Result<TerminalAttachResult> {
    let session = terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&params.session_id)
        .cloned()
        .context("terminal session not found")?;
    if session.closed.load(Ordering::Acquire) {
        anyhow::bail!("terminal session is closed")
    }
    let rows = params.rows.clamp(2, 500);
    let cols = params.cols.clamp(2, 500);
    let mut state = session
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if session.closed.load(Ordering::Acquire) {
        anyhow::bail!("terminal session is closed")
    }
    session
        .master
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
    state.rows = rows;
    state.cols = cols;
    Ok(TerminalAttachResult {
        session_id: params.session_id,
        cwd: state.cwd.clone(),
        rows,
        cols,
        transcript: transcript_text(&state),
        through_sequence: state.sequence,
        truncated: state.truncated,
    })
}

pub(super) fn write(terminals: &TerminalRegistry, params: TerminalWriteParams) -> Result<Value> {
    if params.data.len() > MAX_TERMINAL_INPUT_BYTES {
        anyhow::bail!("terminal input exceeds the 64 KiB request limit")
    }
    let session = terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&params.session_id)
        .cloned();
    let session = session.context("terminal session not found")?;
    if session.closed.load(Ordering::Acquire) {
        anyhow::bail!("terminal session is closed")
    }
    let input = params.data.into_bytes();
    let guard = session
        .input_tx
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let sender = guard.as_ref().context("terminal session is closed")?;
    match sender.try_send(input) {
        Ok(()) => {}
        Err(std::sync::mpsc::TrySendError::Full(_)) => {
            anyhow::bail!("terminal input queue is full")
        }
        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
            anyhow::bail!("terminal session is closed")
        }
    }
    Ok(json!({"written": true}))
}

pub(super) fn resize(terminals: &TerminalRegistry, params: TerminalResizeParams) -> Result<Value> {
    let rows = params.rows.clamp(2, 500);
    let cols = params.cols.clamp(2, 500);
    let session = terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&params.session_id)
        .cloned();
    let Some(session) = session else {
        // A final resize may remain between PTY EOF and terminal/exit reaching the renderer.
        return Ok(json!({"resized": false}));
    };
    let mut state = session
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    session
        .master
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
    state.rows = rows;
    state.cols = cols;
    Ok(json!({"resized": true}))
}

pub(super) fn close(
    terminals: &TerminalRegistry,
    params: TerminalCloseParams,
) -> Result<TerminalCloseResult> {
    let session = terminals
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&params.session_id)
        .cloned();
    if let Some(session) = session {
        mark_closed(&session);
        session
            .input_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        terminate(&session)?;
        let mut registry = terminals
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry
            .get(&params.session_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &session))
        {
            registry.remove(&params.session_id);
        }
        Ok(TerminalCloseResult { closed: true })
    } else {
        Ok(TerminalCloseResult { closed: false })
    }
}

fn terminate(session: &TerminalSession) -> Result<()> {
    let mut child = session
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    #[cfg(unix)]
    if let Some(process_id) = session.process_id {
        signal_process_group(process_id, libc::SIGHUP)?;
        for _ in 0..25 {
            if child.try_wait()?.is_some() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        signal_process_group(process_id, libc::SIGKILL)?;
        return Ok(());
    }
    child.kill().context("failed to terminate terminal process")
}

fn mark_closed(session: &TerminalSession) {
    let _state = session
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    session.closed.store(true, Ordering::Release);
}

#[cfg(unix)]
fn signal_process_group(process_id: u32, signal: libc::c_int) -> Result<()> {
    let result = unsafe { libc::kill(-(process_id as libc::pid_t), signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error).context("failed to signal terminal process group")
}

fn decode_bytes(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                output.push_str(valid);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                let error_len = error.error_len();
                if valid_up_to > 0 {
                    output.push_str(
                        std::str::from_utf8(&pending[..valid_up_to])
                            .expect("valid_up_to is valid UTF-8"),
                    );
                    pending.drain(..valid_up_to);
                }
                if let Some(error_len) = error_len {
                    output.push('\u{fffd}');
                    pending.drain(..error_len);
                    continue;
                }
                if eof {
                    output.push_str(&String::from_utf8_lossy(pending));
                    pending.clear();
                }
                break;
            }
        }
    }
    output
}

fn record_output(session: &TerminalSession, data: &str) -> u64 {
    let mut state = session
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    append_output(&mut state, data)
}

fn append_output(state: &mut TerminalState, data: &str) -> u64 {
    state.sequence = state.sequence.saturating_add(1);
    state.transcript.push_back(data.to_owned());
    state.transcript_bytes = state.transcript_bytes.saturating_add(data.len());
    while state.transcript_bytes > MAX_TERMINAL_TRANSCRIPT_BYTES {
        let excess = state.transcript_bytes - MAX_TERMINAL_TRANSCRIPT_BYTES;
        let Some(front) = state.transcript.front_mut() else {
            state.transcript_bytes = 0;
            break;
        };
        if front.len() <= excess {
            let removed = front.len();
            state.transcript.pop_front();
            state.transcript_bytes -= removed;
        } else {
            let mut remove_bytes = excess;
            while !front.is_char_boundary(remove_bytes) {
                remove_bytes += 1;
            }
            front.drain(..remove_bytes);
            state.transcript_bytes -= remove_bytes;
        }
        state.truncated = true;
    }
    state.sequence
}

fn transcript_text(state: &TerminalState) -> String {
    let mut transcript = String::with_capacity(state.transcript_bytes);
    for chunk in &state.transcript {
        transcript.push_str(chunk);
    }
    transcript
}

fn next_sequence(session: &TerminalSession) -> u64 {
    let mut state = session
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.sequence = state.sequence.saturating_add(1);
    state.sequence
}

#[cfg(test)]
mod tests {
    #[test]
    fn resource_count_is_unknown_during_registry_contention() {
        let registry = super::TerminalRegistry::default();
        assert_eq!(registry.resource_count(), Some(0));
        let guard = registry.0.lock().unwrap();
        assert_eq!(registry.resource_count(), None);
        drop(guard);
        assert_eq!(registry.resource_count(), Some(0));
    }
    use super::*;

    #[tokio::test]
    async fn terminal_session_streams_pty_output_and_exits() {
        let workspace = tempfile::tempdir().unwrap();
        let terminals = TerminalRegistry::default();
        let _guard = TerminalRegistryGuard(terminals.clone());
        let (tx, mut rx) = mpsc::channel(32);
        let started = start(
            workspace.path(),
            "test-session",
            1,
            TerminalStartParams {
                cwd: Some(workspace.path().to_string_lossy().into_owned()),
                rows: 24,
                cols: 80,
            },
            terminals.clone(),
            tx,
        )
        .await
        .unwrap();
        let listed = list(&terminals);
        assert_eq!(listed.sessions.len(), 1);
        assert_eq!(listed.sessions[0].session_id, started.session_id);
        assert_eq!(listed.sessions[0].rows, 24);
        assert_eq!(listed.sessions[0].cols, 80);
        resize(
            &terminals,
            TerminalResizeParams {
                session_id: started.session_id.clone(),
                rows: 40,
                cols: 120,
            },
        )
        .unwrap();
        write(
            &terminals,
            TerminalWriteParams {
                session_id: started.session_id.clone(),
                data: "printf 'KCODER-PTY-READY\\n'; exit\n".into(),
            },
        )
        .unwrap();

        let mut output = String::new();
        let mut last_sequence = 0;
        let exit = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(message) = rx.recv().await {
                if message["method"] == method::TERMINAL_OUTPUT {
                    output.push_str(message["params"]["data"].as_str().unwrap_or_default());
                    let sequence = message["params"]["sequence"].as_u64().unwrap();
                    assert!(sequence > last_sequence);
                    last_sequence = sequence;
                }
                if message["method"] == method::TERMINAL_EXIT {
                    return message;
                }
            }
            panic!("terminal notification channel closed")
        })
        .await
        .unwrap();
        assert!(output.contains("KCODER-PTY-READY"));
        assert_eq!(exit["params"]["session_id"], started.session_id);
        assert_eq!(exit["params"]["exit_code"], 0);
        assert!(exit["params"]["sequence"].as_u64().unwrap() > last_sequence);
        assert!(list(&terminals).sessions.is_empty());
    }

    #[tokio::test]
    async fn terminal_attach_returns_atomic_replay_snapshot_and_resizes() {
        let workspace = tempfile::tempdir().unwrap();
        let terminals = TerminalRegistry::default();
        let _guard = TerminalRegistryGuard(terminals.clone());
        let (tx, mut rx) = mpsc::channel(32);
        let started = start(
            workspace.path(),
            "attach-session",
            2,
            TerminalStartParams {
                cwd: None,
                rows: 24,
                cols: 80,
            },
            terminals.clone(),
            tx,
        )
        .await
        .unwrap();
        write(
            &terminals,
            TerminalWriteParams {
                session_id: started.session_id.clone(),
                data: "printf '终端回放标记\\n'\n".into(),
            },
        )
        .unwrap();
        let output_sequence = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(message) = rx.recv().await {
                if message["method"] == method::TERMINAL_OUTPUT
                    && message["params"]["data"]
                        .as_str()
                        .is_some_and(|data| data.contains("终端回放标记"))
                {
                    return message["params"]["sequence"].as_u64().unwrap();
                }
            }
            panic!("terminal notification channel closed")
        })
        .await
        .unwrap();

        let attached = attach(
            &terminals,
            TerminalAttachParams {
                session_id: started.session_id.clone(),
                rows: 1,
                cols: 600,
            },
        )
        .unwrap();
        assert_eq!(attached.rows, 2);
        assert_eq!(attached.cols, 500);
        assert!(attached.transcript.contains("终端回放标记"));
        assert!(attached.through_sequence >= output_sequence);
        assert!(!attached.truncated);
        let listed = list(&terminals);
        assert_eq!(listed.sessions[0].rows, 2);
        assert_eq!(listed.sessions[0].cols, 500);

        assert!(
            attach(
                &terminals,
                TerminalAttachParams {
                    session_id: "missing".into(),
                    rows: 24,
                    cols: 80,
                },
            )
            .unwrap_err()
            .to_string()
            .contains("not found")
        );
        close(
            &terminals,
            TerminalCloseParams {
                session_id: started.session_id,
            },
        )
        .unwrap();
    }

    #[test]
    fn terminal_input_is_bounded_and_utf8_is_preserved_across_reads() {
        let error = write(
            &TerminalRegistry::default(),
            TerminalWriteParams {
                session_id: "missing".into(),
                data: "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("64 KiB"));
        assert_eq!(
            resize(
                &TerminalRegistry::default(),
                TerminalResizeParams {
                    session_id: "already-exited".into(),
                    rows: 40,
                    cols: 120,
                },
            )
            .unwrap()["resized"],
            false
        );

        let mut pending = Vec::new();
        assert_eq!(decode_bytes(&mut pending, &[0xe4, 0xbd], false), "");
        assert_eq!(decode_bytes(&mut pending, &[0xa0], false), "你");
        assert!(pending.is_empty());
        assert_eq!(decode_bytes(&mut pending, &[0xff], false), "�");

        let mut state = TerminalState {
            cwd: "/tmp".into(),
            rows: 24,
            cols: 80,
            transcript: VecDeque::new(),
            transcript_bytes: 0,
            sequence: 0,
            truncated: false,
        };
        assert_eq!(
            append_output(&mut state, &"x".repeat(MAX_TERMINAL_TRANSCRIPT_BYTES)),
            1
        );
        assert_eq!(state.transcript_bytes, MAX_TERMINAL_TRANSCRIPT_BYTES);
        assert!(!state.truncated);

        state.transcript.clear();
        state.transcript_bytes = 0;
        state.sequence = 0;
        let oversized = "你".repeat(MAX_TERMINAL_TRANSCRIPT_BYTES / 3 + 100);
        assert_eq!(append_output(&mut state, &oversized), 1);
        assert!(state.transcript_bytes <= MAX_TERMINAL_TRANSCRIPT_BYTES);
        assert!(
            transcript_text(&state)
                .chars()
                .all(|character| character == '你')
        );
        assert!(state.truncated);
        assert_eq!(append_output(&mut state, "好"), 2);
        assert!(transcript_text(&state).ends_with("好"));
        assert!(state.transcript_bytes <= MAX_TERMINAL_TRANSCRIPT_BYTES);
    }
}
