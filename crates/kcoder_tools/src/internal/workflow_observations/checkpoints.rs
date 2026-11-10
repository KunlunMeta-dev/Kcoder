//! Durable node checkpoints bound to the original node and dependency fingerprint.
use crate::run_files::{atomic_write_file, secure_create_dir, secure_read_file};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const MAX_CHECKPOINT_BYTES: usize = 4 * 1024 * 1024 + 4096;
const MAX_CHECKPOINT_STORAGE_BYTES: u64 = 64 * 1024 * 1024;

pub fn ensure_effects_known(run_dir: &Path) -> Result<()> {
    let directory = kcoder_config::PrivateDirectory::open_existing(run_dir)?;
    for (_, file) in directory.open_regular_files(|name| {
        name.to_string_lossy().starts_with("tool-") && name.to_string_lossy().ends_with(".json")
    })? {
        ensure!(
            file.metadata()?.len() <= 256 * 1024,
            "workflow_tool: invalid prior receipt"
        );
        let receipt: Value = serde_json::from_reader(file.take(256 * 1024 + 1))?;
        ensure!(
            matches!(receipt["status"].as_str(), Some("completed" | "blocked")),
            "workflow_tool: prior effect outcome is unknown; inspect it before continuing"
        );
    }
    Ok(())
}

fn path(run_dir: &Path, node_id: &str, fingerprint: &str) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(format!("{node_id}:{fingerprint}")));
    run_dir.join("checkpoints").join(format!("{key}.json"))
}

pub fn load(run_dir: &Path, node_id: &str, fingerprint: &str) -> Result<Option<Value>> {
    let bytes = match secure_read_file(&path(run_dir, node_id, fingerprint), MAX_CHECKPOINT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("workflow_checkpoint: cannot read checkpoint"),
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        record["format"] == 1
            && record["status"] == "completed"
            && record["nodeId"] == node_id
            && record["fingerprint"] == fingerprint,
        "workflow_checkpoint: invalid checkpoint identity"
    );
    let output = record
        .get("output")
        .context("workflow_checkpoint: missing output")?;
    ensure!(
        record["outputSha256"] == format!("{:x}", Sha256::digest(serde_json::to_vec(output)?)),
        "workflow_checkpoint: output checksum changed"
    );
    Ok(Some(output.clone()))
}

pub fn save(run_dir: &Path, node_id: &str, fingerprint: &str, output: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(&json!({"format":1,"status":"completed","nodeId":node_id,
        "fingerprint":fingerprint,"output":output,
        "outputSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(output)?))}))?;
    ensure!(
        bytes.len() <= MAX_CHECKPOINT_BYTES,
        "workflow_checkpoint: output exceeds checkpoint budget"
    );
    secure_create_dir(&run_dir.join("checkpoints"))?;
    let directory = kcoder_config::PrivateDirectory::open_existing(&run_dir.join("checkpoints"))?;
    let target = path(run_dir, node_id, fingerprint);
    let target_name = target
        .file_name()
        .context("workflow_checkpoint: invalid target")?;
    let total = directory
        .open_regular_files(|name| name != target_name)?
        .into_iter()
        .try_fold(bytes.len() as u64, |total, (_, file)| -> Result<u64> {
            Ok(total.saturating_add(file.metadata()?.len()))
        })?;
    ensure!(
        total <= MAX_CHECKPOINT_STORAGE_BYTES,
        "workflow_checkpoint: retained node checkpoints exceed 64 MiB; start a new run with an explicit source run"
    );
    atomic_write_file(&target, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoints_require_exact_identity_and_preserve_json_types() {
        let temp = tempfile::tempdir().unwrap();
        save(
            temp.path(),
            "../node",
            "fingerprint-1",
            &json!({"items":[1,"1",null]}),
        )
        .unwrap();
        assert_eq!(
            load(temp.path(), "../node", "fingerprint-1").unwrap(),
            Some(json!({"items":[1,"1",null]}))
        );
        assert!(
            load(temp.path(), "../node", "fingerprint-2")
                .unwrap()
                .is_none()
        );
        assert!(
            load(temp.path(), "other", "fingerprint-1")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn unknown_effect_blocks_cross_version_replay() {
        let temp = tempfile::tempdir().unwrap();
        atomic_write_file(
            &temp.path().join("tool-call.json"),
            br#"{"status":"pending"}"#,
        )
        .unwrap();
        assert!(
            ensure_effects_known(temp.path())
                .unwrap_err()
                .to_string()
                .contains("unknown")
        );
        atomic_write_file(
            &temp.path().join("tool-call.json"),
            br#"{"status":"completed"}"#,
        )
        .unwrap();
        ensure_effects_known(temp.path()).unwrap();
    }
}
