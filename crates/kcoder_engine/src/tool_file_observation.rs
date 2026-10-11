use super::*;

const MAX_SHELL_SNAPSHOT_FILES: usize = 20_000;
const MAX_SHELL_REPORTED_CHANGED_FILES: usize = 200;

pub(super) fn normalize_tool_path(path: &str, cwd: &Path) -> String {
    let raw = Path::new(path);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    if let Ok(rel) = candidate.strip_prefix(cwd) {
        let rel = rel.to_string_lossy().to_string();
        if !rel.is_empty() {
            return rel;
        }
    }
    candidate.to_string_lossy().to_string()
}

pub(super) fn normalize_existing_path(path: PathBuf, cwd: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(cwd) {
        let rel = rel.to_string_lossy().to_string();
        if !rel.is_empty() {
            return rel;
        }
    }
    path.to_string_lossy().to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FileSnapshotEntry {
    pub(super) len: u64,
    pub(super) modified_ns: u128,
}

pub(super) type FileSnapshot = HashMap<String, FileSnapshotEntry>;

pub(super) fn should_track_shell_file_changes(tool_name: &str, input: &Value) -> bool {
    is_shell_tool_name(tool_name)
        && !input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !(tool_name == "bash"
            && input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(classify_bash_read_only))
}

pub(super) fn is_shell_tool_name(tool_name: &str) -> bool {
    matches!(tool_name, "bash" | "PowerShell")
}

pub(super) fn is_direct_file_mutation_tool_name(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "write" | "edit" | "apply_patch" | "FileWriteTool" | "FileEditTool" | "ApplyPatchTool"
    )
}

fn snapshot_files(cwd: &Path) -> Option<FileSnapshot> {
    let mut snapshot = HashMap::new();
    let mut count = 0usize;
    collect_snapshot_files(cwd, cwd, &mut snapshot, &mut count)?;
    Some(snapshot)
}

pub(super) async fn snapshot_files_async(cwd: PathBuf) -> Option<FileSnapshot> {
    tokio::task::spawn_blocking(move || snapshot_files(&cwd))
        .await
        .unwrap_or_else(|error| {
            warn!("shell file snapshot worker failed: {error}");
            None
        })
}

fn collect_snapshot_files(
    root: &Path,
    dir: &Path,
    snapshot: &mut FileSnapshot,
    count: &mut usize,
) -> Option<()> {
    if *count > MAX_SHELL_SNAPSHOT_FILES {
        return None;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Some(());
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if should_skip_shell_snapshot_dir(&name) {
                continue;
            }
            collect_snapshot_files(root, &path, snapshot, count)?;
        } else if file_type.is_file() {
            *count += 1;
            if *count > MAX_SHELL_SNAPSHOT_FILES {
                return None;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified_ns = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let key = normalize_existing_path(path, root);
            snapshot.insert(
                key,
                FileSnapshotEntry {
                    len: metadata.len(),
                    modified_ns,
                },
            );
        }
    }

    Some(())
}

fn should_skip_shell_snapshot_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "target" | "node_modules" | "dist" | "build" | ".next"
    )
}

pub(super) fn changed_snapshot_paths(
    before: &FileSnapshot,
    after: &FileSnapshot,
) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    for (path, before_entry) in before {
        if after.get(path) != Some(before_entry) {
            paths.push(path.clone());
        }
    }
    for path in after.keys() {
        if !before.contains_key(path) {
            paths.push(path.clone());
        }
    }
    paths.sort();
    paths.dedup();
    let truncated = paths.len() > MAX_SHELL_REPORTED_CHANGED_FILES;
    if truncated {
        paths.truncate(MAX_SHELL_REPORTED_CHANGED_FILES);
    }
    (paths, truncated)
}

/// Recursively collect string values from a tool input that correspond to
/// existing file or directory paths relative to `cwd`.
pub(super) fn collect_touched_paths(input: &Value, cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    collect_touched_paths_inner(input, cwd, &mut paths);
    paths
}

fn collect_touched_paths_inner(value: &Value, cwd: &Path, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if s.is_empty() {
                return;
            }
            let path = Path::new(s);
            let candidate = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            if candidate.exists() {
                let stored = if let Ok(rel) = candidate.strip_prefix(cwd) {
                    rel.to_string_lossy().to_string()
                } else {
                    candidate.to_string_lossy().to_string()
                };
                if !stored.is_empty() && !out.contains(&stored) {
                    out.push(stored);
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_touched_paths_inner(v, cwd, out);
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                collect_touched_paths_inner(v, cwd, out);
            }
        }
        _ => {}
    }
}

impl QueryEngine {
    pub(super) fn record_file_change_observation(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        paths: &[String],
        truncated: bool,
    ) {
        if !self.auto_tool_memory_enabled_for_tool(tool_name) {
            return;
        }
        if paths.is_empty() {
            return;
        }
        let mut bundle = self.memory_observer_event_bundle();
        bundle.add_file_change_event(tool_call_id, tool_name, paths, truncated);
        self.record_memory_observer_bundle(bundle);
    }
}
