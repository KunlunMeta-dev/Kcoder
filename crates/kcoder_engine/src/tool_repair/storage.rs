use super::{ToolRepairExample, ToolRepairIndex, now_millis};
use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use serde::Serialize;
use std::ffi::OsStr;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use tracing::warn;

pub(super) const STORE_VERSION: u32 = 1;
const MAX_LOADED_EXAMPLES: usize = 2_000;
const SESSION_AUDIT_LOG_FILENAME: &str = "session-end.log";

impl ToolRepairIndex {
    pub(crate) fn load(cwd: &Path) -> Self {
        match load_examples(cwd) {
            Ok(examples) => Self { examples },
            Err(error) => {
                warn!(
                    "failed to load tool repair examples from {}: {}",
                    examples_dir(cwd).display(),
                    error
                );
                Self::default()
            }
        }
    }
}
pub(crate) fn examples_dir(cwd: &Path) -> PathBuf {
    cwd.join(".kcoder").join("tool-repair-examples")
}

pub(crate) fn session_audit_log_path(cwd: &Path) -> PathBuf {
    examples_dir(cwd).join(SESSION_AUDIT_LOG_FILENAME)
}
pub(super) fn persist_examples(
    cwd: &Path,
    session_id: &str,
    examples: &[ToolRepairExample],
) -> Result<()> {
    let dir = examples_dir(cwd);
    let final_path = example_file_path(cwd, session_id);
    let final_name = final_path
        .file_name()
        .context("tool repair example file has no basename")?;
    let mut bytes = Vec::new();
    for example in examples {
        serde_json::to_writer(&mut bytes, example)
            .with_context(|| format!("failed to serialize {}", final_path.display()))?;
        bytes.push(b'\n');
    }
    PrivateDirectory::open_or_create(&dir)
        .with_context(|| format!("failed to open tool repair example dir {}", dir.display()))?
        .atomic_replace(final_name, &bytes)
        .with_context(|| format!("failed to replace {}", final_path.display()))?;
    Ok(())
}

pub(super) fn example_file_path(cwd: &Path, session_id: &str) -> PathBuf {
    examples_dir(cwd).join(format!("{}.jsonl", safe_session_filename(session_id)))
}

#[derive(Serialize)]
struct SessionAuditEntry<'a> {
    version: u32,
    timestamp_ms: u64,
    session_id: &'a str,
    status: &'a str,
    example_count: usize,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    examples_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

pub(super) fn append_session_audit_log(
    cwd: &Path,
    session_id: &str,
    status: &str,
    example_count: usize,
    message: &str,
    examples_file: Option<&Path>,
    error: Option<&str>,
) -> Result<()> {
    let dir = examples_dir(cwd);
    let path = session_audit_log_path(cwd);
    let entry = SessionAuditEntry {
        version: STORE_VERSION,
        timestamp_ms: now_millis(),
        session_id,
        status,
        example_count,
        message,
        examples_file: examples_file.map(|path| path.display().to_string()),
        error,
    };
    let mut line = serde_json::to_vec(&entry)
        .with_context(|| format!("failed to serialize {}", path.display()))?;
    line.push(b'\n');
    PrivateDirectory::open_or_create(&dir)
        .with_context(|| format!("failed to open tool repair audit dir {}", dir.display()))?
        .append(OsStr::new(SESSION_AUDIT_LOG_FILENAME), &line)
        .with_context(|| format!("failed to append {}", path.display()))?;
    Ok(())
}

fn load_examples(cwd: &Path) -> Result<Vec<ToolRepairExample>> {
    let dir = examples_dir(cwd);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let private_dir = PrivateDirectory::open_or_create(&dir)
        .with_context(|| format!("failed to open {}", dir.display()))?;
    let mut files = private_dir.open_regular_files(|name| {
        Path::new(name).extension().and_then(|ext| ext.to_str()) == Some("jsonl")
    })?;
    files.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut examples = Vec::new();
    for (name, file) in files {
        let path = dir.join(&name);
        for line in std::io::BufReader::new(file).lines() {
            let Ok(line) = line else {
                continue;
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ToolRepairExample>(&line) {
                Ok(example) if example.version == STORE_VERSION => examples.push(example),
                Ok(_) => {}
                Err(error) => warn!(
                    "failed to parse tool repair example from {}: {}",
                    path.display(),
                    error
                ),
            }
        }
    }
    if examples.len() > MAX_LOADED_EXAMPLES {
        let drop = examples.len() - MAX_LOADED_EXAMPLES;
        examples.drain(0..drop);
    }
    Ok(examples)
}

fn safe_session_filename(session_id: &str) -> String {
    kcoder_state::artifact_id_path_component(session_id)
}
