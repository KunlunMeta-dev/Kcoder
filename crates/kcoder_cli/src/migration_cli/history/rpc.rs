//! A single owned stdio connection reuses the authoritative native continuation host.
use super::Context;
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{Receiver, sync_channel},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
struct RpcRejected(String);
impl std::fmt::Display for RpcRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "migration_rpc_rejected: {}", self.0)
    }
}
impl std::error::Error for RpcRejected {}

fn status_observation(method: &str) -> bool {
    matches!(
        method,
        "migration/history/read" | "migration/branch/read" | "migration/continuation/read"
    )
}
fn retryable_observation(method: &str, error: &anyhow::Error) -> bool {
    status_observation(method)
        && error
            .downcast_ref::<RpcRejected>()
            .is_some_and(|rejected| rejected.0 == "history_catalog_busy")
}
pub(in crate::migration_cli) struct Client {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Result<Value>>,
    reader: Option<JoinHandle<()>>,
    sequence: u64,
    experimental: Value,
}
impl Client {
    pub fn start(context: &Context, overlays: &[PathBuf]) -> Result<Self> {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("app-server")
            .arg("--cwd")
            .arg(&context.cwd)
            .env("KCODER_CONFIG_DIR", &context.profile)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for overlay in overlays {
            command
                .arg("--settings-file")
                .arg(super::absolute(overlay, Some(&context.cwd))?);
        }
        let mut child = command
            .spawn()
            .context("migration_continuation_host_unavailable")?;
        let input = child
            .stdin
            .take()
            .context("migration_continuation_host_unavailable")?;
        let output = child
            .stdout
            .take()
            .context("migration_continuation_host_unavailable")?;
        let (tx, rx) = sync_channel(1);
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                let result = (&mut reader)
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut bytes);
                let result = match result {
                    Ok(0) => break,
                    Ok(_) if bytes.len() as u64 > MAX_FRAME => {
                        Err(anyhow::anyhow!("migration_rpc_frame_too_large"))
                    }
                    Ok(_) => serde_json::from_slice(&bytes)
                        .map_err(|_| anyhow::anyhow!("migration_rpc_invalid_frame")),
                    Err(_) => Err(anyhow::anyhow!("migration_rpc_read_failed")),
                };
                let failed = result.is_err();
                if tx.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let mut client = Self {
            child,
            input: Some(input),
            output: rx,
            reader: Some(reader),
            sequence: 0,
            experimental: Value::Null,
        };
        let initialized = client.call("initialize", json!({"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"clientInfo":{"name":"kcoder-terminal-migration","version":env!("CARGO_PKG_VERSION")}}))?;
        client.experimental = initialized["capabilities"]["experimental"].clone();
        Ok(client)
    }
    pub fn require_capability(&self, capability: &str) -> Result<()> {
        ensure!(
            self.experimental[capability] == true,
            "migration_host_upgrade_required: {capability}"
        );
        Ok(())
    }
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        if !status_observation(method) {
            return self.call_once(method, params);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match self.call_once(method, params.clone()) {
                Err(error)
                    if retryable_observation(method, &error) && Instant::now() < deadline =>
                {
                    // Only an explicit busy rejection of a status read is safe to repeat.
                    thread::sleep(Duration::from_millis(20));
                }
                result => return result,
            }
        }
    }
    fn call_once(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        let input = self.input.as_mut().context("migration_rpc_closed")?;
        serde_json::to_writer(
            &mut *input,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )?;
        input.write_all(b"\n")?;
        input.flush()?;
        let deadline = Instant::now() + Duration::from_secs(60);
        for _ in 0..1024 {
            let timeout = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .output
                .recv_timeout(timeout)
                .map_err(|_| anyhow::anyhow!("migration_rpc_response_unknown_use_read"))??;
            if frame.get("id").is_none() {
                continue;
            }
            ensure!(frame["id"] == id, "migration_rpc_response_mismatch");
            if let Some(error) = frame.get("error") {
                // Native diagnostic text is sanitized by the host; no server-owned data is executed.
                return Err(RpcRejected(
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown_error")
                        .into(),
                )
                .into());
            }
            return frame
                .get("result")
                .cloned()
                .context("migration_rpc_invalid_response");
        }
        anyhow::bail!("migration_rpc_notification_budget_exceeded")
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // EOF revokes this connection's workers. Reap only this exact subprocess.
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(10);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        // Disconnect the bounded receiver before joining a reader blocked on send.
        let (_, empty) = sync_channel(1);
        let receiver = std::mem::replace(&mut self.output, empty);
        drop(receiver);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_busy_status_reads_are_retryable() {
        let busy = anyhow::Error::new(RpcRejected("history_catalog_busy".into()));
        for method in [
            "migration/history/read",
            "migration/branch/read",
            "migration/continuation/read",
        ] {
            assert!(retryable_observation(method, &busy));
        }
        for method in [
            "migration/history/run",
            "migration/history/resume",
            "migration/history/cancel",
            "migration/continuation/create",
            "migration/continuation/start",
            "migration/history/undo",
            "migration/history/search",
        ] {
            assert!(!retryable_observation(method, &busy));
        }
        for message in [
            "history_projection_recovery_required",
            "migration_operation_failed",
            "history_catalog_busy_with_unknown_receipt",
        ] {
            assert!(!retryable_observation(
                "migration/history/read",
                &RpcRejected(message.into()).into()
            ));
        }
        assert!(!retryable_observation(
            "migration/history/read",
            &anyhow::anyhow!("history_catalog_busy")
        ));
    }
}
