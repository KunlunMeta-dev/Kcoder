//! Private offline-owner transport. The live coordinator, not child JSON,
//! owns stop authority and domain authorization throughout this invocation.
use anyhow::{Context, Result, ensure};
use kcoder_config::storage::{
    STORAGE_OFFLINE_CHILD_FRAME_LIMIT as FRAME_LIMIT, StorageCoordinator, StorageOfflineChildFences,
};
use kcoder_process_supervisor::owned_process::OwnedProcess;
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    time::{Instant, timeout_at},
};

async fn read_frame(reader: &mut (impl AsyncBufReadExt + Unpin)) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            ensure!(bytes.is_empty(), "STORAGE_OFFLINE_CHILD_FRAME_INVALID");
            return Ok(None);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(available.len(), |index| index + 1);
        ensure!(
            length <= FRAME_LIMIT.saturating_sub(bytes.len()),
            "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"
        );
        bytes.extend_from_slice(&available[..length]);
        reader.consume(length);
        if newline.is_some() {
            let frame: Value =
                serde_json::from_slice(&bytes).context("STORAGE_OFFLINE_CHILD_FRAME_INVALID")?;
            ensure!(frame.is_object(), "STORAGE_OFFLINE_CHILD_FRAME_INVALID");
            return Ok(Some(frame));
        }
    }
}

async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), frame: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(frame)?;
    ensure!(
        bytes.len() < FRAME_LIMIT,
        "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"
    );
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

struct Conversation<'a> {
    id: &'a str,
    fences: &'a StorageOfflineChildFences,
    sequence: u64,
    ready: bool,
    completed: Option<Value>,
}

impl Conversation<'_> {
    fn accept(
        &mut self,
        coordinator: &mut StorageCoordinator,
        frame: Value,
        validate_domain: &mut impl FnMut(&Value) -> Result<()>,
    ) -> Result<Option<Value>> {
        ensure!(
            frame.get("version").and_then(Value::as_u64) == Some(1)
                && frame.get("operationId").and_then(Value::as_str) == Some(self.id)
                && self.completed.is_none(),
            "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
        );
        coordinator.validate_offline_child_fences(self.id, self.fences)?;
        let kind = frame.get("type").and_then(Value::as_str);
        let fields: &[&str] = match kind {
            Some("validateFences" | "validateOffline") => {
                &["type", "version", "operationId", "sequence", "facts"]
            }
            Some("ready") => &["type", "version", "operationId"],
            Some("completed") => &["type", "version", "operationId", "value"],
            _ => anyhow::bail!("STORAGE_OFFLINE_CHILD_FRAME_INVALID"),
        };
        ensure!(
            frame
                .as_object()
                .is_some_and(|object| object.len() == fields.len()
                    && object.keys().all(|key| fields.contains(&key.as_str()))),
            "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
        );
        match kind {
            Some("validateFences" | "validateOffline") => {
                self.sequence = self
                    .sequence
                    .checked_add(1)
                    .context("STORAGE_OFFLINE_CHILD_FRAME_INVALID")?;
                ensure!(
                    frame.get("sequence").and_then(Value::as_u64) == Some(self.sequence),
                    "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
                );
                let facts = frame
                    .get("facts")
                    .context("STORAGE_OFFLINE_CHILD_FRAME_INVALID")?;
                if frame["type"] == "validateFences" {
                    ensure!(
                        *facts == serde_json::to_value(&self.fences.roots)?,
                        "STORAGE_OFFLINE_CHILD_FENCE_CHANGED"
                    );
                } else {
                    ensure!(
                        self.ready
                            && self.sequence >= 4
                            && facts.is_object()
                            && facts.get("operationId").and_then(Value::as_str) == Some(self.id),
                        "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
                    );
                    // This callback must compare the parent's original domain
                    // scope and recheck any Native lease needed by that owner.
                    validate_domain(facts)?;
                    coordinator.validate_offline_child_fences(self.id, self.fences)?;
                }
                Ok(Some(json!({"type":"validated", "version":1,
                    "sequence":self.sequence, "operationId":self.id})))
            }
            Some("ready") => {
                ensure!(
                    !self.ready && self.sequence == 2,
                    "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
                );
                self.ready = true;
                Ok(None)
            }
            Some("completed") => {
                ensure!(
                    self.ready && self.sequence >= 4,
                    "STORAGE_OFFLINE_CHILD_FRAME_INVALID"
                );
                self.completed = Some(
                    frame
                        .get("value")
                        .cloned()
                        .context("STORAGE_OFFLINE_CHILD_FRAME_INVALID")?,
                );
                Ok(None)
            }
            _ => anyhow::bail!("STORAGE_OFFLINE_CHILD_FRAME_INVALID"),
        }
    }
}

/// Only a trusted installed/source owner entry is supplied by the composition
/// root. No HTTP, model tool, payload field or child frame selects executable code.
pub(super) async fn run_offline_owner_child(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: &mut Command,
    payload: Value,
    timeout: Duration,
    mut validate_domain: impl FnMut(&Value) -> Result<()>,
) -> Result<Value> {
    ensure!(
        Path::new(command.as_std().get_program()).is_absolute()
            && !timeout.is_zero()
            && timeout <= Duration::from_secs(300),
        "STORAGE_OFFLINE_CHILD_LAUNCH_INVALID"
    );
    let fences = coordinator.prepare_offline_child_fences(id)?;
    let initialize = json!({"type":"initialize", "version":1,
        "operationId":id, "roots":fences.roots, "payload":payload});
    ensure!(
        serde_json::to_vec(&initialize)?.len() < FRAME_LIMIT,
        "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let mut owned = OwnedProcess::spawn(command).context("STORAGE_OFFLINE_CHILD_START_FAILED")?;
    let deadline = Instant::now() + timeout;
    let result = timeout_at(deadline, async {
        let mut input = owned
            .child
            .stdin
            .take()
            .context("STORAGE_OFFLINE_CHILD_PIPE_MISSING")?;
        let mut output = BufReader::new(
            owned
                .child
                .stdout
                .take()
                .context("STORAGE_OFFLINE_CHILD_PIPE_MISSING")?,
        );
        write_frame(&mut input, &initialize).await?;
        let mut conversation = Conversation {
            id,
            fences: &fences,
            sequence: 0,
            ready: false,
            completed: None,
        };
        while let Some(frame) = read_frame(&mut output).await? {
            if let Some(response) = conversation.accept(coordinator, frame, &mut validate_domain)? {
                write_frame(&mut input, &response).await?;
            }
        }
        let value = conversation
            .completed
            .context("STORAGE_OFFLINE_CHILD_RESULT_MISSING")?;
        drop(input);
        let status = owned
            .child
            .wait()
            .await
            .context("STORAGE_OFFLINE_CHILD_WAIT_FAILED")?;
        ensure!(status.success(), "STORAGE_OFFLINE_CHILD_FAILED");
        coordinator.validate_offline_child_fences(id, &fences)?;
        Ok::<_, anyhow::Error>(value)
    })
    .await
    .unwrap_or_else(|_| Err(anyhow::anyhow!("STORAGE_OFFLINE_CHILD_TIMEOUT")));
    // Kill/reap this invocation group even after its leader exited: inherited
    // pipes or remaining descendants must not outlive the operation's phase.
    owned
        .finish()
        .await
        .context("STORAGE_OFFLINE_CHILD_STOP_UNCONFIRMED")?;
    result
}

#[cfg(test)]
#[path = "storage_owner_child_tests.rs"]
mod tests;
