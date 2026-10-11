//! Bounded metadata discovery and handle-relative binary reads. No whole-file JSON.
use super::selected_file_contract::*;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_READS: usize = 4;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const LEASE_TIMEOUT: Duration = Duration::from_secs(60);
struct SelectedFile {
    file: File,
    metadata: SelectedFileMetadata,
}
struct Selection {
    cancelled: AtomicBool,
    files: Mutex<Vec<SelectedFile>>,
    last_used: Mutex<Instant>,
}
impl Default for Selection {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            files: Mutex::new(Vec::new()),
            last_used: Mutex::new(Instant::now()),
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct SelectedFileReads(Arc<Mutex<HashMap<String, Arc<Selection>>>>);

impl SelectedFileReads {
    fn reserve(&self, read_id: &str) -> Result<Arc<Selection>, String> {
        if read_id.is_empty()
            || read_id.len() > 128
            || !read_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid selected-file read ID".into());
        }
        let mut reads = self
            .0
            .lock()
            .map_err(|_| "Selected-file registry is unavailable")?;
        reads.retain(|_, entry| {
            let alive = entry
                .last_used
                .lock()
                .map(|time| time.elapsed() < LEASE_TIMEOUT)
                .unwrap_or(false);
            if !alive {
                entry.cancelled.store(true, Ordering::Relaxed);
            }
            alive
        });
        if reads.contains_key(read_id) || reads.len() >= MAX_READS {
            return Err("Selected-file read capacity reached".into());
        }
        let selection = Arc::new(Selection::default());
        reads.insert(read_id.into(), selection.clone());
        Ok(selection)
    }
    fn get(&self, read_id: &str) -> Result<Arc<Selection>, String> {
        let reads = self
            .0
            .lock()
            .map_err(|_| "Selected-file registry is unavailable")?;
        let entry = reads
            .get(read_id)
            .cloned()
            .ok_or("Selected-file read is closed")?;
        let mut last = entry
            .last_used
            .lock()
            .map_err(|_| "Selected-file lease is unavailable")?;
        if last.elapsed() >= LEASE_TIMEOUT {
            entry.cancelled.store(true, Ordering::Relaxed);
            return Err("Selected-file read expired".into());
        }
        *last = Instant::now();
        drop(last);
        Ok(entry)
    }
    pub(crate) fn cancel(&self, read_id: &str) -> Result<(), String> {
        if let Some(entry) = self
            .0
            .lock()
            .map_err(|_| "Selected-file registry is unavailable")?
            .remove(read_id)
        {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry
                .files
                .lock()
                .map_err(|_| "Selected-file handles are unavailable")?
                .clear();
        }
        Ok(())
    }
    fn discover(
        &self,
        read_id: String,
        paths: Vec<String>,
        entry: Arc<Selection>,
    ) -> Result<SelectedFileRead, String> {
        let mut budget = Discovery {
            started: Instant::now(),
            entries: 0,
            bytes: 0,
            candidates: Vec::new(),
            entry: &entry,
        };
        let result = (|| {
            if paths.len() > MAX_FILES {
                return Err("Too many selected paths".into());
            }
            for raw in paths {
                let path = PathBuf::from(raw);
                if !path.is_absolute() {
                    return Err("Selected path must be absolute".into());
                }
                let root = path.file_name().ok_or("Invalid selected path")?;
                budget.visit(&path, Path::new(root), 0)?;
            }
            // All metadata budgets are checked before opening/reading any content.
            let mut files = Vec::new();
            for (path, metadata) in budget.candidates {
                check(&entry, budget.started)?;
                let mut options = OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                let file = options
                    .open(path)
                    .map_err(|error| format!("Failed to open selected file: {error}"))?;
                let actual = file
                    .metadata()
                    .map_err(|error| format!("Failed to inspect selected handle: {error}"))?;
                if !actual.is_file() || actual.len() != metadata.size {
                    return Err("Selected file changed during inspection".into());
                }
                files.push(SelectedFile { file, metadata });
            }
            check(&entry, budget.started)?;
            let metadata = files.iter().map(|file| file.metadata.clone()).collect();
            let mut handles = entry
                .files
                .lock()
                .map_err(|_| "Selected-file handles are unavailable")?;
            if entry.cancelled.load(Ordering::Relaxed) {
                return Err("Selected-file read cancelled".into());
            }
            *handles = files;
            Ok(SelectedFileRead {
                read_id: read_id.clone(),
                chunk_bytes: CHUNK_BYTES,
                files: metadata,
            })
        })();
        if result.is_err() {
            self.cancel(&read_id)?;
        }
        result
    }
    pub(crate) fn chunk(
        &self,
        read_id: &str,
        file_index: usize,
        offset: u64,
    ) -> Result<Vec<u8>, String> {
        let entry = self.get(read_id)?;
        if entry.cancelled.load(Ordering::Relaxed) {
            return Err("Selected-file read cancelled".into());
        }
        let mut files = entry
            .files
            .lock()
            .map_err(|_| "Selected-file handles are unavailable")?;
        let selected = files
            .get_mut(file_index)
            .ok_or("Selected file index is invalid")?;
        if offset > selected.metadata.size {
            return Err("Selected file offset is invalid".into());
        }
        if selected
            .file
            .metadata()
            .map_err(|error| error.to_string())?
            .len()
            != selected.metadata.size
        {
            return Err("Selected file changed during reading".into());
        }
        let length = (selected.metadata.size - offset).min(CHUNK_BYTES as u64) as usize;
        let mut bytes = vec![0; length];
        selected
            .file
            .seek(SeekFrom::Start(offset))
            .and_then(|_| selected.file.read_exact(&mut bytes))
            .map_err(|error| format!("Failed to read selected chunk: {error}"))?;
        if entry.cancelled.load(Ordering::Relaxed) {
            return Err("Selected-file read cancelled".into());
        }
        Ok(bytes)
    }
}
fn check(entry: &Selection, started: Instant) -> Result<(), String> {
    if entry.cancelled.load(Ordering::Relaxed) {
        return Err("Selected-file read cancelled".into());
    }
    if started.elapsed() > DISCOVERY_TIMEOUT {
        return Err("Selected-file discovery timed out".into());
    }
    Ok(())
}
struct Discovery<'a> {
    started: Instant,
    entries: usize,
    bytes: u64,
    candidates: Vec<(PathBuf, SelectedFileMetadata)>,
    entry: &'a Selection,
}
impl Discovery<'_> {
    fn visit(&mut self, path: &Path, relative: &Path, depth: usize) -> Result<(), String> {
        check(self.entry, self.started)?;
        self.entries += 1;
        if self.entries > MAX_ENTRIES || depth > MAX_DEPTH {
            return Err("Selected directory exceeds entry/depth budget".into());
        }
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("Failed to inspect selected path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Ok(());
        }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                self.visit(&entry.path(), &relative.join(entry.file_name()), depth + 1)?;
            }
        } else if metadata.is_file() {
            if metadata.len() > MAX_FILE_BYTES {
                return Err("Selected file exceeds 100 MiB budget".into());
            }
            self.bytes = self
                .bytes
                .checked_add(metadata.len())
                .ok_or("Selected file size overflow")?;
            if self.bytes > MAX_TOTAL_BYTES || self.candidates.len() >= MAX_FILES {
                return Err("Selected directory exceeds total size/file count budget".into());
            }
            self.candidates.push((
                path.into(),
                SelectedFileMetadata {
                    name: path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .ok_or("Invalid selected file name")?
                        .into(),
                    relative_path: relative
                        .to_str()
                        .ok_or("Invalid selected relative path")?
                        .replace('\\', "/"),
                    size: metadata.len(),
                },
            ));
        } else {
            return Err("Selected path is not a regular file or directory".into());
        }
        Ok(())
    }
}
#[tauri::command]
pub(crate) async fn begin_dropped_file_read(
    state: tauri::State<'_, SelectedFileReads>,
    read_id: String,
    paths: Vec<String>,
) -> Result<SelectedFileRead, String> {
    let state = state.inner().clone();
    let entry = state.reserve(&read_id)?;
    tauri::async_runtime::spawn_blocking(move || state.discover(read_id, paths, entry))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn read_dropped_file_chunk(
    state: tauri::State<'_, SelectedFileReads>,
    read_id: String,
    file_index: usize,
    offset: u64,
) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .chunk(&read_id, file_index, offset)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) fn cancel_dropped_file_read(
    state: tauri::State<'_, SelectedFileReads>,
    read_id: String,
) -> Result<(), String> {
    state.cancel(&read_id)
}

#[cfg(test)]
#[path = "selected_files_tests.rs"]
mod tests;
