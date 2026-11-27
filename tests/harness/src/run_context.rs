use crate::{
    Prerequisite, PrerequisiteResult, RunManifest, RunMetadata, RunStatus, SecretRedactor,
};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

type Cleanup = Box<dyn FnOnce() -> Result<()> + Send + 'static>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CleanupReport {
    pub attempted: usize,
    pub failures: Vec<String>,
}

pub struct RunContext {
    root: PathBuf,
    state_dir: PathBuf,
    logs_dir: PathBuf,
    artifacts_dir: PathBuf,
    cases_dir: PathBuf,
    manifest: RunManifest,
    redactor: SecretRedactor,
    cleanups: Vec<Cleanup>,
    finished: bool,
}

impl std::fmt::Debug for RunContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RunContext")
            .field("root", &self.root)
            .field("manifest", &self.manifest)
            .field("cleanup_count", &self.cleanups.len())
            .field("finished", &self.finished)
            .finish()
    }
}

impl RunContext {
    pub fn create(base: impl AsRef<Path>, metadata: RunMetadata) -> Result<Self> {
        let base = base.as_ref();
        fs::create_dir_all(base)
            .with_context(|| format!("创建测试运行根失败: {}", base.display()))?;
        let started_at_ms = now_millis();
        let suite_slug = slug(&metadata.suite);
        let (run_id, root) = create_unique_run_dir(base, &suite_slug, started_at_ms)?;
        let state_dir = root.join("state");
        let logs_dir = root.join("logs");
        let artifacts_dir = root.join("artifacts");
        let cases_dir = root.join("cases");
        for directory in [&state_dir, &logs_dir, &artifacts_dir, &cases_dir] {
            fs::create_dir(directory)
                .with_context(|| format!("创建测试运行子目录失败: {}", directory.display()))?;
        }
        let context = Self {
            root,
            state_dir,
            logs_dir,
            artifacts_dir,
            cases_dir,
            manifest: RunManifest::running(run_id, metadata, started_at_ms),
            redactor: SecretRedactor::new(),
            cleanups: Vec::new(),
            finished: false,
        };
        context.write_manifest()?;
        Ok(context)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn artifacts_dir(&self) -> &Path {
        &self.artifacts_dir
    }

    pub fn cases_dir(&self) -> &Path {
        &self.cases_dir
    }

    pub fn manifest(&self) -> &RunManifest {
        &self.manifest
    }

    pub fn state_path(&self, relative: impl AsRef<Path>) -> Result<PathBuf> {
        safe_child(&self.state_dir, relative.as_ref())
    }

    pub fn artifact_path(&self, relative: impl AsRef<Path>) -> Result<PathBuf> {
        safe_child(&self.artifacts_dir, relative.as_ref())
    }

    pub fn case_path(&self, case: impl AsRef<Path>, relative: impl AsRef<Path>) -> Result<PathBuf> {
        let case_root = safe_child(&self.cases_dir, case.as_ref())?;
        safe_child(&case_root, relative.as_ref())
    }

    pub fn register_secret(&mut self, secret: impl Into<String>) -> Result<()> {
        self.redactor.register(secret)
    }

    pub fn redact_text(&self, text: &str) -> String {
        self.redactor.redact_text(text)
    }

    pub fn streaming_redactor(&self) -> crate::StreamingRedactor {
        self.redactor.streaming()
    }

    pub fn redact_value(&self, value: &Value) -> Value {
        self.redactor.redact_value(value)
    }

    pub fn evaluate_prerequisite(&mut self, prerequisite: &Prerequisite) -> PrerequisiteResult {
        let result = prerequisite.evaluate();
        if !result.met {
            self.manifest.unmet_prerequisites.push(result.clone());
        }
        result
    }

    pub fn register_cleanup<F>(&mut self, cleanup: F)
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        self.cleanups.push(Box::new(cleanup));
    }

    pub fn write_artifact_json<T: Serialize>(
        &mut self,
        relative: impl AsRef<Path>,
        value: &T,
    ) -> Result<PathBuf> {
        let relative = validate_relative(relative.as_ref())?;
        let path = self.artifact_path(relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建 artifact 目录失败: {}", parent.display()))?;
        }
        let value = serde_json::to_value(value).context("序列化 artifact 失败")?;
        let redacted = self.redactor.redact_value(&value);
        write_json_new(&path, &redacted)?;
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        if !self.manifest.artifacts.contains(&relative_text) {
            self.manifest.artifacts.push(relative_text);
        }
        self.write_manifest()?;
        Ok(path)
    }

    pub fn write_case_json<T: Serialize>(
        &self,
        case: impl AsRef<Path>,
        relative: impl AsRef<Path>,
        value: &T,
    ) -> Result<PathBuf> {
        let path = self.case_path(case, relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建 case evidence 目录失败: {}", parent.display()))?;
        }
        let value = serde_json::to_value(value).context("序列化 case evidence 失败")?;
        write_json(&path, &self.redactor.redact_value(&value))?;
        Ok(path)
    }

    pub fn finish(&mut self, status: RunStatus, message: Option<&str>) -> Result<CleanupReport> {
        anyhow::ensure!(!self.finished, "测试运行已经结束");
        anyhow::ensure!(status.is_terminal(), "显式 finish 必须使用终态");
        let mut cleanup = self.run_cleanups();
        self.remove_state_dir(&mut cleanup);
        self.manifest.status = if cleanup.failures.is_empty() {
            status
        } else {
            RunStatus::Failed
        };
        self.manifest.finished_at_ms = Some(now_millis());
        self.manifest.message = match (message, cleanup.failures.is_empty()) {
            (Some(message), true) => Some(self.redactor.redact_text(message)),
            (Some(message), false) => Some(format!(
                "{}; cleanup failures: {}",
                self.redactor.redact_text(message),
                cleanup.failures.join(" | ")
            )),
            (None, false) => Some(format!(
                "cleanup failures: {}",
                cleanup.failures.join(" | ")
            )),
            (None, true) => None,
        };
        self.write_manifest()?;
        self.finished = true;
        Ok(cleanup)
    }

    fn run_cleanups(&mut self) -> CleanupReport {
        let mut report = CleanupReport::default();
        while let Some(cleanup) = self.cleanups.pop() {
            report.attempted += 1;
            if let Err(error) = cleanup() {
                report
                    .failures
                    .push(self.redactor.redact_text(&format!("{error:#}")));
            }
        }
        report
    }

    fn remove_state_dir(&self, report: &mut CleanupReport) {
        if !self.state_dir.exists() {
            return;
        }
        if let Err(error) = fs::remove_dir_all(&self.state_dir) {
            report.failures.push(
                self.redactor
                    .redact_text(&format!("删除测试 state 目录失败: {error}")),
            );
        }
    }

    fn write_manifest(&self) -> Result<()> {
        let value = serde_json::to_value(&self.manifest).context("序列化测试 manifest 失败")?;
        let redacted = self.redactor.redact_value(&value);
        write_json(&self.root.join("manifest.json"), &redacted)
    }
}

impl Drop for RunContext {
    fn drop(&mut self) {
        if self.finished || !std::thread::panicking() {
            return;
        }
        let mut cleanup = self.run_cleanups();
        self.remove_state_dir(&mut cleanup);
        self.manifest.status = RunStatus::Failed;
        self.manifest.finished_at_ms = Some(now_millis());
        self.manifest.message = Some(if cleanup.failures.is_empty() {
            "测试 panic；已执行 best-effort cleanup".to_string()
        } else {
            format!(
                "测试 panic；cleanup failures: {}",
                cleanup.failures.join(" | ")
            )
        });
        let _ = self.write_manifest();
    }
}

fn create_unique_run_dir(
    base: &Path,
    suite: &str,
    started_at_ms: u64,
) -> Result<(String, PathBuf)> {
    for _ in 0..1_000 {
        let counter = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
        let run_id = format!("{started_at_ms}-{suite}-{}-{counter}", std::process::id());
        let root = base.join(&run_id);
        match fs::create_dir(&root) {
            Ok(()) => return Ok((run_id, root)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("创建测试运行目录失败: {}", root.display()));
            }
        }
    }
    anyhow::bail!("无法分配唯一测试运行目录")
}

fn safe_child(root: &Path, relative: &Path) -> Result<PathBuf> {
    let relative = validate_relative(relative)?;
    let child = root.join(relative);
    anyhow::ensure!(child.starts_with(root), "测试运行路径逃逸");
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            unreachable!("relative path was validated")
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "测试运行路径包含符号链接: {}",
                current.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("检查测试运行路径失败: {}", current.display()));
            }
        }
    }
    Ok(child)
}

fn validate_relative(path: &Path) -> Result<&Path> {
    anyhow::ensure!(!path.as_os_str().is_empty(), "测试运行相对路径不能为空");
    anyhow::ensure!(!path.is_absolute(), "测试运行路径不能是绝对路径");
    for component in path.components() {
        anyhow::ensure!(
            matches!(component, Component::Normal(_)),
            "测试运行路径包含非法分量: {}",
            path.display()
        );
    }
    Ok(path)
}

fn slug(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    if slug.trim_matches('-').is_empty() {
        "suite".to_string()
    } else {
        slug
    }
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("编码 JSON 失败")?;
    let parent = path.parent().context("JSON 目标路径缺少父目录")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("JSON 目标文件名不是有效 UTF-8")?;
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("创建临时 JSON 失败: {}", temporary.display()))?;
        file.write_all(&bytes)
            .with_context(|| format!("写入临时 JSON 失败: {}", temporary.display()))?;
        file.flush()
            .with_context(|| format!("flush 临时 JSON 失败: {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("同步临时 JSON 失败: {}", temporary.display()))?;
        drop(file);
        atomic_replace(&temporary, path).with_context(|| {
            format!(
                "原子替换 JSON 失败: {} -> {}",
                temporary.display(),
                path.display()
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated and valid for the call; flags request only atomic replacement and durability.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn write_json_new(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("编码 JSON 失败")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("创建 JSON artifact 失败（禁止覆盖）: {}", path.display()))?;
    file.write_all(&bytes)
        .with_context(|| format!("写入 JSON artifact 失败: {}", path.display()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
