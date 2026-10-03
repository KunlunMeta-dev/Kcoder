use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use tracing::warn;

/// A single audit record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub timestamp_ms: u64,
    pub tool_name: String,
    pub input: Value,
    pub reason: String,
}

/// Append-only permission audit log.
#[derive(Debug, Clone)]
pub struct PermissionAudit {
    tx: Arc<Sender<AuditMessage>>,
}

impl PermissionAudit {
    pub fn new(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        if let Err(error) = std::thread::Builder::new()
            .name("permission-audit".to_string())
            .spawn(move || run_audit_writer(path, rx))
        {
            warn!("failed to start permission audit writer: {error}");
        }
        Self { tx: Arc::new(tx) }
    }

    pub fn record(&self, tool_name: &str, input: &Value, reason: &str) -> anyhow::Result<()> {
        let record = AuditRecord {
            timestamp_ms: now_millis(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
            reason: reason.to_string(),
        };
        self.tx
            .send(AuditMessage::Record(record))
            .map_err(|_| anyhow::anyhow!("permission audit writer stopped"))?;
        Ok(())
    }

    /// Wait until all records queued before this call have reached the OS.
    pub fn flush(&self) -> anyhow::Result<()> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(AuditMessage::Flush(tx))
            .map_err(|_| anyhow::anyhow!("permission audit writer stopped"))?;
        rx.recv()
            .map_err(|_| anyhow::anyhow!("permission audit writer stopped"))?
            .map_err(anyhow::Error::msg)
    }
}

#[derive(Debug)]
enum AuditMessage {
    Record(AuditRecord),
    Flush(Sender<Result<(), String>>),
}

fn run_audit_writer(path: PathBuf, rx: Receiver<AuditMessage>) {
    let mut file: Option<BufWriter<File>> = None;
    let mut pending = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(AuditMessage::Record(record)) => {
                match write_audit_record(&path, &mut file, &record) {
                    Ok(()) => pending = true,
                    Err(error) => warn!("failed to write permission audit: {error}"),
                }
            }
            Ok(AuditMessage::Flush(response)) => {
                let result = flush_audit_writer(&mut file).map_err(|error| error.to_string());
                pending = false;
                let _ = response.send(result);
            }
            Err(RecvTimeoutError::Timeout) => {
                if pending {
                    if let Err(error) = flush_audit_writer(&mut file) {
                        warn!("failed to flush permission audit: {error}");
                    }
                    pending = false;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = flush_audit_writer(&mut file);
                break;
            }
        }
    }
}

fn write_audit_record(
    path: &Path,
    file: &mut Option<BufWriter<File>>,
    record: &AuditRecord,
) -> anyhow::Result<()> {
    if file.is_none() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        *file = Some(BufWriter::new(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
        ));
    }
    serde_json::to_writer(
        file.as_mut().expect("permission audit file is open"),
        record,
    )?;
    file.as_mut()
        .expect("permission audit file is open")
        .write_all(b"\n")?;
    Ok(())
}

fn flush_audit_writer(file: &mut Option<BufWriter<File>>) -> std::io::Result<()> {
    match file {
        Some(file) => file.flush(),
        None => Ok(()),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permission_audit_writes_multiple_records_with_one_handle() {
        let tmp = std::env::temp_dir().join(format!(
            "kcoder-permissions-audit-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let path = tmp.join("nested").join("permissions.log");
        let audit = PermissionAudit::new(path.clone());

        audit
            .record("read", &json!({"file_path": "a.rs"}), "allow")
            .unwrap();
        audit
            .record("grep", &json!({"pattern": "foo"}), "allow")
            .unwrap();
        audit.flush().unwrap();

        let text = std::fs::read_to_string(path).unwrap();
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"tool_name\":\"read\""));
        assert!(lines[1].contains("\"tool_name\":\"grep\""));
        let _ = std::fs::remove_dir_all(tmp);
    }
}
