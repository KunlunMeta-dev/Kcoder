use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::time::Duration;
use tracing::warn;

const MAX_RECORD_BYTES: usize = 256 * 1024;
const QUEUE_CAPACITY: usize = 64;

struct SizeBudget(usize);
impl Write for SizeBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| std::io::Error::other("permission audit record exceeds 256 KiB"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A single audit record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub timestamp_ms: u64,
    pub tool_name: String,
    pub input: Value,
    pub reason: String,
}

#[derive(Serialize)]
struct AuditRecordView<'a> {
    timestamp_ms: u64,
    tool_name: &'a str,
    input: &'a Value,
    reason: &'a str,
}

/// Append-only permission audit log.
#[derive(Debug, Clone)]
pub struct PermissionAudit {
    tx: Arc<SyncSender<AuditMessage>>,
    queue_gap: Arc<AtomicBool>,
}

impl PermissionAudit {
    pub fn new(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel(QUEUE_CAPACITY);
        let queue_gap = Arc::new(AtomicBool::new(false));
        let writer_gap = queue_gap.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("permission-audit".to_string())
            .spawn(move || run_audit_writer(path, rx, writer_gap))
        {
            warn!("failed to start permission audit writer: {error}");
        }
        Self {
            tx: Arc::new(tx),
            queue_gap,
        }
    }

    pub fn record(&self, tool_name: &str, input: &Value, reason: &str) -> anyhow::Result<()> {
        // Check encoded size without allocating a second full JSON buffer or
        // cloning large input. Admission failures remain visible at flush.
        let timestamp_ms = now_millis();
        let view = AuditRecordView {
            timestamp_ms,
            tool_name,
            input,
            reason,
        };
        // Include the newline in the on-disk record budget.
        if let Err(error) = serde_json::to_writer(SizeBudget(MAX_RECORD_BYTES - 1), &view) {
            self.queue_gap.store(true, Ordering::Release);
            return Err(error.into());
        }
        let record = AuditRecord {
            timestamp_ms,
            tool_name: tool_name.to_string(),
            input: input.clone(),
            reason: reason.to_string(),
        };
        if let Err(error) = self.tx.try_send(AuditMessage::Record(record)) {
            self.queue_gap.store(true, Ordering::Release);
            return Err(anyhow::anyhow!(match error {
                mpsc::TrySendError::Full(_) =>
                    "permission audit queue is full; record was not queued",
                mpsc::TrySendError::Disconnected(_) => "permission audit writer stopped",
            }));
        }
        Ok(())
    }

    /// Wait until all records queued before this call have reached the OS.
    /// Any earlier dropped record remains an error for this writer lifetime.
    pub fn flush(&self) -> anyhow::Result<()> {
        let (tx, rx) = mpsc::channel();
        self.tx.try_send(AuditMessage::Flush(tx)).map_err(|error| {
            anyhow::anyhow!(match error {
                mpsc::TrySendError::Full(_) =>
                    "permission audit queue is full; flush was not queued",
                mpsc::TrySendError::Disconnected(_) => "permission audit writer stopped",
            })
        })?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|error| {
                anyhow::anyhow!(match error {
                    RecvTimeoutError::Timeout => "permission audit flush timed out",
                    RecvTimeoutError::Disconnected => "permission audit writer stopped",
                })
            })?
            .map_err(anyhow::Error::msg)
    }
}

#[derive(Debug)]
enum AuditMessage {
    Record(AuditRecord),
    Flush(Sender<Result<(), String>>),
}

fn run_audit_writer(path: PathBuf, rx: Receiver<AuditMessage>, queue_gap: Arc<AtomicBool>) {
    let mut file: Option<BufWriter<File>> = None;
    let mut pending = false;
    // A failed record is removed from the queue and cannot be recreated by a
    // later successful flush. Keep that data gap observable for this writer.
    let mut lost_record_error = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(AuditMessage::Record(record)) => {
                match write_audit_record(&path, &mut file, &record) {
                    Ok(()) => pending = true,
                    Err(error) => {
                        lost_record_error.get_or_insert_with(|| {
                            format!("permission audit record was not persisted: {error}")
                        });
                        warn!("failed to write permission audit: {error}");
                    }
                }
            }
            Ok(AuditMessage::Flush(response)) => {
                let result = flush_audit_writer(&mut file).map_err(|error| error.to_string());
                let result = match &lost_record_error {
                    Some(error) => Err(error.clone()),
                    None if queue_gap.load(Ordering::Acquire) => {
                        Err("permission audit contains an unqueued record".into())
                    }
                    None => result,
                };
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
    fn oversized_permission_record_is_rejected_before_it_enters_the_queue() {
        let (tx, rx) = mpsc::sync_channel(1);
        let audit = PermissionAudit {
            tx: Arc::new(tx),
            queue_gap: Arc::new(AtomicBool::new(false)),
        };
        let input = json!({"payload":"x".repeat(256 * 1024)});
        assert!(audit.record("fixture", &input, "allow").is_err());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn record_budget_includes_metadata_and_matches_persisted_json() {
        let input = json!({"path": "fixture"});
        let record = AuditRecord {
            timestamp_ms: 123,
            tool_name: "read".into(),
            input: input.clone(),
            reason: "allow".into(),
        };
        let view = AuditRecordView {
            timestamp_ms: record.timestamp_ms,
            tool_name: &record.tool_name,
            input: &input,
            reason: &record.reason,
        };
        assert_eq!(
            serde_json::to_vec(&view).unwrap(),
            serde_json::to_vec(&record).unwrap()
        );
        let (tx, rx) = mpsc::sync_channel(1);
        let audit = PermissionAudit {
            tx: Arc::new(tx),
            queue_gap: Arc::new(AtomicBool::new(false)),
        };
        // The input tuple fits, but the actual JSON object with its metadata does not.
        assert!(
            audit
                .record("read", &json!("x".repeat(MAX_RECORD_BYTES - 32)), "allow")
                .is_err()
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn queue_admission_is_bounded_and_a_dropped_record_remains_observable() {
        let (tx, rx) = mpsc::sync_channel(1);
        let audit = PermissionAudit {
            tx: Arc::new(tx),
            queue_gap: Arc::new(AtomicBool::new(false)),
        };
        audit
            .record("read", &json!({"path":"first"}), "allow")
            .unwrap();
        assert!(
            audit
                .record("read", &json!({"path":"second"}), "allow")
                .is_err()
        );
        assert!(audit.queue_gap.load(Ordering::Acquire));
        assert!(matches!(rx.try_recv().unwrap(), AuditMessage::Record(_)));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn oversized_admission_failure_is_not_hidden_by_a_later_flush() {
        let dir = tempfile::tempdir().unwrap();
        let audit = PermissionAudit::new(dir.path().join("audit.jsonl"));
        assert!(
            audit
                .record(
                    "fixture",
                    &json!({"payload":"x".repeat(MAX_RECORD_BYTES)}),
                    "allow"
                )
                .is_err()
        );
        audit
            .record("read", &json!({"path":"small"}), "allow")
            .unwrap();
        assert!(audit.flush().is_err());
    }

    #[test]
    fn permission_audit_flush_reports_records_lost_to_write_failure() {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(format!(
            "kcoder-audit-write-error-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        let blocked_parent = root.join("parent");
        fs::write(&blocked_parent, b"a regular file, not a directory").unwrap();
        let audit = PermissionAudit::new(blocked_parent.join("permissions.log"));
        audit
            .record("read", &json!({"path":"fixture"}), "allow")
            .unwrap();
        assert!(
            audit.flush().is_err(),
            "flush must not acknowledge a dropped audit record"
        );
        // A later successful append cannot retroactively persist the dropped entry.
        fs::remove_file(&blocked_parent).unwrap();
        fs::create_dir(&blocked_parent).unwrap();
        audit
            .record("grep", &json!({"pattern":"fixture"}), "allow")
            .unwrap();
        assert!(
            audit.flush().is_err(),
            "an earlier audit data gap must remain observable"
        );
        assert!(blocked_parent.join("permissions.log").is_file());
    }

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
