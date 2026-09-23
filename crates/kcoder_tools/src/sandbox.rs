//! Filesystem and command sandbox for tool execution.
//!
//! When enabled, the sandbox restricts file reads/writes to the working
//! directory plus an explicit allow-list, and can block shell execution or
//! enforce a read-only mode.

use kcoder_types::SandboxConfig;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Runtime sandbox enforcing path and command restrictions.
#[derive(Debug, Clone, Default)]
pub struct Sandbox {
    cwd: PathBuf,
    config: SandboxConfig,
    readonly_paths: Vec<PathBuf>,
    runtime_write_paths: Vec<PathBuf>,
}

impl Sandbox {
    /// Create a new sandbox for the given working directory and config.
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>, config: SandboxConfig) -> Self {
        Self {
            cwd: cwd.into(),
            config,
            readonly_paths: Vec::new(),
            runtime_write_paths: Vec::new(),
        }
    }

    /// Goal Pro verifiers reuse shared development caches read-only; writes must stay in their isolated directories.
    #[must_use]
    pub fn without_shared_dev_cache_writes(mut self) -> Self {
        self.config.allow_shared_dev_cache_writes = false;
        self.config.allow_system_temp_writes = false;
        self
    }

    #[must_use]
    pub fn with_readonly_paths(mut self, paths: Vec<PathBuf>) -> Self {
        self.readonly_paths = paths;
        self
    }

    /// Add write access for an engine-created private runtime directory without changing public SandboxConfig.
    #[must_use]
    pub fn with_runtime_write_path(mut self, path: PathBuf) -> Self {
        let rendered = path.display().to_string();
        if !self.config.allowed_paths.contains(&rendered) {
            self.config.allowed_paths.push(rendered);
        }
        if !self.runtime_write_paths.contains(&path) {
            self.runtime_write_paths.push(path);
        }
        self
    }

    /// Returns true when the sandbox is enabled.
    #[must_use]
    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    /// Return the sandbox policy's workspace root, used by Goal Pro to pin candidate-source search paths.
    pub fn workspace_root(&self) -> &Path {
        &self.cwd
    }

    /// Clone a configuration snapshot that can be safely reattached to another working directory.
    ///
    /// Relative allow/deny paths are interpreted against the `cwd` used to create
    /// this Sandbox. Cloning strings and then changing the root would reinterpret a
    /// deny rule under the new worktree. Anchor both path classes to the current root
    /// first so callers can replace only their owned write allowlist without losing parent deny boundaries.
    #[must_use]
    pub fn reanchored_config(&self) -> SandboxConfig {
        let mut config = self.config.clone();
        config.allowed_paths = config
            .allowed_paths
            .iter()
            .map(|path| self.resolve(Path::new(path)).display().to_string())
            .collect();
        config.denied_paths = config
            .denied_paths
            .iter()
            .map(|path| self.resolve(Path::new(path)).display().to_string())
            .collect();
        config
    }

    /// Return OS write permissions under the current policy for tests and diagnostics.
    pub fn writable_roots(&self) -> Vec<PathBuf> {
        self.os_spec().map_or_else(Vec::new, |spec| spec.rw_paths)
    }

    /// Check whether a file operation is allowed.
    ///
    /// `write` should be true for create/edit/write operations and false for
    /// reads. Returns `Ok(())` when allowed or when the sandbox is disabled.
    pub fn check_path(&self, path: &Path, write: bool) -> Result<(), String> {
        if !self.config.enabled {
            return Ok(());
        }

        if write && self.config.readonly {
            return Err(format!(
                "sandbox is read-only; writing to {} is not allowed",
                path.display()
            ));
        }

        let resolved = self.resolve(path);
        let normalized = policy_path(&resolved)?;

        // Denied paths take precedence.
        for denied in &self.config.denied_paths {
            let denied_abs = policy_path(&self.resolve(Path::new(denied)))?;
            if path_starts_with(&normalized, &denied_abs) {
                return Err(format!(
                    "sandbox denied: {} is under denied path {}",
                    path.display(),
                    denied
                ));
            }
        }

        // If an explicit allow-list is provided, the path must be under one of
        // them. Otherwise it must be under the working directory.
        if self.config.allowed_paths.is_empty() {
            let cwd_abs = policy_path(&self.cwd)?;
            if path_starts_with(&normalized, &cwd_abs) {
                return Ok(());
            }
            return Err(format!(
                "sandbox: {} is outside the working directory {}. \
                 Add it to sandbox.allowed_paths to allow access.",
                path.display(),
                self.cwd.display()
            ));
        }

        for allowed in &self.config.allowed_paths {
            let allowed_abs = policy_path(&self.resolve(Path::new(allowed)))?;
            if path_starts_with(&normalized, &allowed_abs) {
                return Ok(());
            }
        }

        Err(format!(
            "sandbox: {} is not under any allowed path",
            path.display()
        ))
    }

    /// Check whether shell command execution is allowed.
    pub fn check_shell(&self) -> Result<(), String> {
        if self.config.enabled && self.config.readonly {
            return Err("sandbox is read-only; shell command execution is disabled".to_string());
        }
        Ok(())
    }

    /// Check whether bash execution is allowed.
    pub fn check_bash(&self) -> Result<(), String> {
        self.check_shell()
    }

    /// Compute the platform-native OS confinement plan for spawned children.
    pub fn os_spec(&self) -> Option<crate::os_sandbox::OsSandboxSpec> {
        if !self.config.enabled {
            return None;
        }
        #[cfg(windows)]
        {
            let mut rw_paths = if self.config.readonly {
                Vec::new()
            } else {
                std::iter::once(self.cwd.clone())
                    .chain(
                        self.config
                            .allowed_paths
                            .iter()
                            .map(|allowed| self.resolve(Path::new(allowed))),
                    )
                    .collect::<Vec<_>>()
            };
            if !self.config.readonly {
                if self.config.allow_system_temp_writes {
                    rw_paths.push(std::env::temp_dir());
                }
                if self.config.allow_shared_dev_cache_writes
                    && let Some(home) = dirs::home_dir()
                {
                    for cache in [".cache", ".cargo", ".npm", "go"] {
                        let path = home.join(cache);
                        if path.exists() {
                            rw_paths.push(path);
                        }
                    }
                }
                if self.config.allow_shared_dev_cache_writes
                    && let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
                {
                    for cache in ["npm-cache", "uv\\cache", "bun\\install\\cache"] {
                        let path = local.join(cache);
                        if path.exists() {
                            rw_paths.push(path);
                        }
                    }
                }
            }
            rw_paths.sort();
            rw_paths.dedup();
            Some(crate::os_sandbox::OsSandboxSpec {
                backend: crate::os_sandbox::OsSandboxBackend::WindowsRestrictedToken,
                rw_paths,
                readonly_paths: self.readonly_paths.clone(),
                deny_read: self
                    .config
                    .denied_paths
                    .iter()
                    .map(|denied| self.resolve(Path::new(denied)))
                    .collect(),
            })
        }
        #[cfg(not(windows))]
        {
            let supported = crate::os_sandbox::landlock_supported();
            match self.config.landlock {
                Some(false) => return None,
                None if !supported => return None,
                _ => {}
            }
            let mut rw_paths = Vec::new();
            if !self.config.readonly {
                rw_paths.push(self.cwd.clone());
                for allowed in &self.config.allowed_paths {
                    rw_paths.push(self.resolve(Path::new(allowed)));
                }
                if self.config.allow_system_temp_writes {
                    rw_paths.push(std::env::temp_dir());
                }
                if self.config.allow_shared_dev_cache_writes
                    && let Some(home) = dirs::home_dir()
                {
                    for cache in [".cache", ".cargo", ".local", ".npm", "go"] {
                        let dir = home.join(cache);
                        if dir.exists() {
                            rw_paths.push(dir);
                        }
                    }
                }
            }
            // Pseudo-devices commonly redirected to in shell pipelines.
            for dev in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/full"] {
                let path = PathBuf::from(dev);
                if path.exists() {
                    rw_paths.push(path);
                }
            }
            // Denied paths are carved out of the read tree too: a policy-level
            // deny must not be bypassable by reading the path inside a shell.
            let deny_read = self
                .config
                .denied_paths
                .iter()
                .map(|denied| self.resolve(Path::new(denied)))
                .collect();
            Some(crate::os_sandbox::OsSandboxSpec {
                backend: crate::os_sandbox::OsSandboxBackend::Landlock,
                rw_paths,
                readonly_paths: self.readonly_paths.clone(),
                deny_read,
            })
        }
    }

    /// Generate provenance-restricted OS write permissions for one verifier command.
    ///
    /// Candidate commands may write only the candidate and their runtime namespace;
    /// regular baseline commands may write only their runtime namespace. Only a
    /// strictly parsed native build temporarily opens the pristine baseline as
    /// `writable_workspace`. This call does not mutate Sandbox and fails closed when
    /// the host lacks a native OS sandbox.
    pub fn os_spec_for_verifier_invocation(
        &self,
        writable_workspace: Option<&Path>,
        runtime_write_path: &Path,
    ) -> Result<Option<crate::os_sandbox::OsSandboxSpec>, String> {
        if !self.config.enabled {
            return Err(
                "temporary verifier baseline writes require an enabled native OS sandbox"
                    .to_string(),
            );
        }
        let candidate = policy_path(&self.cwd)?;
        let readonly = self
            .readonly_paths
            .iter()
            .map(|path| policy_path(&self.resolve(path)))
            .collect::<Result<Vec<_>, _>>()?;
        let writable_workspace = writable_workspace
            .map(|path| policy_path(&self.resolve(path)))
            .transpose()?;
        if let Some(writable) = writable_workspace.as_ref()
            && writable != &candidate
            && !readonly.iter().any(|root| writable == root)
        {
            return Err(format!(
                "verifier workspace write path {} is neither the candidate root nor a configured pristine baseline root",
                writable.display()
            ));
        }

        let runtime = policy_path(&self.resolve(runtime_write_path))?;
        let registered_runtime_roots = self
            .runtime_write_paths
            .iter()
            .map(|path| policy_path(&self.resolve(path)))
            .collect::<Result<Vec<_>, _>>()?;
        if !registered_runtime_roots
            .iter()
            .any(|root| path_starts_with(&runtime, root))
        {
            return Err(format!(
                "verifier runtime write path {} is outside the engine-owned runtime root",
                runtime.display()
            ));
        }

        let mut spec = self.os_spec().ok_or_else(|| {
            "temporary verifier baseline writes require an available native OS sandbox".to_string()
        })?;
        if let Some(writable) = writable_workspace.as_ref() {
            spec.readonly_paths.retain(|root| {
                policy_path(root)
                    .map(|root| !path_starts_with(writable, &root))
                    .unwrap_or(false)
            });
        }
        // Each command retains only its runtime, optional workspace write root, and
        // pseudo-devices. All other allowlists, especially the opposite provenance's
        // worktree/runtime, become read-only.
        spec.rw_paths.retain(|root| {
            let Ok(root) = policy_path(root) else {
                return false;
            };
            matches!(
                root.to_str(),
                Some("/dev/null" | "/dev/zero" | "/dev/urandom" | "/dev/full")
            )
        });
        spec.rw_paths.push(runtime);
        if let Some(writable) = writable_workspace {
            spec.rw_paths.push(writable);
        }
        spec.rw_paths.sort();
        spec.rw_paths.dedup();
        Ok(Some(spec))
    }

    fn resolve(&self, path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.cwd.join(path)
        }
    }
}

fn policy_path(path: &Path) -> Result<PathBuf, String> {
    // Resolve through the OS (including symlinks) *before* any lexical `..`
    // reasoning. Collapsing `..` lexically first would erase symlink
    // components and validate a different path than the one the OS would
    // actually open (e.g. `link/../etc/passwd` with `link` symlinked out of
    // the workspace).
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()));
    }

    let mut existing = path;
    let mut missing: Vec<OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(format!(
                "sandbox: could not find an existing parent for {}",
                path.display()
            ));
        };
        missing.push(name.to_os_string());
        existing = existing.parent().ok_or_else(|| {
            format!(
                "sandbox: could not find an existing parent for {}",
                path.display()
            )
        })?;
    }

    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|error| format!("failed to canonicalize {}: {error}", existing.display()))?;
    for name in missing.iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

/// Returns whether `path` is contained by `base` using the host filesystem's
/// path comparison semantics. Windows path components are case-insensitive;
/// other supported hosts retain `Path::starts_with` semantics.
pub fn path_starts_with(path: &Path, base: &Path) -> bool {
    #[cfg(not(windows))]
    {
        path.starts_with(base)
    }
    #[cfg(windows)]
    {
        let mut path_components = path.components();
        base.components().all(|expected| {
            path_components.next().is_some_and(|actual| {
                windows_path_component_eq(actual.as_os_str(), expected.as_os_str())
            })
        })
    }
}

/// Removes `base` from `path` using the same host-aware comparison as
/// [`path_starts_with`].
pub fn path_strip_prefix(path: &Path, base: &Path) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        path.strip_prefix(base).ok().map(Path::to_path_buf)
    }
    #[cfg(windows)]
    {
        if !path_starts_with(path, base) {
            return None;
        }
        let mut relative = PathBuf::new();
        for component in path.components().skip(base.components().count()) {
            relative.push(component.as_os_str());
        }
        Some(relative)
    }
}

#[cfg(windows)]
fn windows_path_component_eq(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

    let left = left.encode_wide().collect::<Vec<_>>();
    let right = right.encode_wide().collect::<Vec<_>>();
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_sandbox_allows_everything() {
        let sandbox = Sandbox::new("/workspace", SandboxConfig::default());
        assert!(sandbox.check_path(Path::new("/etc/passwd"), false).is_ok());
        assert!(sandbox.check_path(Path::new("/etc/passwd"), true).is_ok());
        assert!(sandbox.check_bash().is_ok());
    }

    #[test]
    fn enabled_sandbox_restricts_to_cwd() {
        let config = SandboxConfig {
            enabled: true,
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new("/workspace", config);
        assert!(sandbox.check_path(Path::new("src/main.rs"), false).is_ok());
        assert!(sandbox.check_path(Path::new("/etc/passwd"), false).is_err());
        assert!(
            sandbox
                .check_path(Path::new("/workspace/../etc/passwd"), false)
                .is_err()
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn strict_runtime_config_does_not_grant_system_temp_or_shared_cache_writes() {
        let workspace = tempfile::tempdir().unwrap();
        let private_temp = workspace.path().join(".kcoder/runtime");
        std::fs::create_dir_all(&private_temp).unwrap();
        let sandbox = Sandbox::new(
            workspace.path(),
            SandboxConfig {
                enabled: true,
                allow_system_temp_writes: false,
                allow_shared_dev_cache_writes: false,
                ..SandboxConfig::default()
            },
        )
        .with_runtime_write_path(private_temp.clone());

        let roots = sandbox.writable_roots();
        assert!(roots.contains(&workspace.path().to_path_buf()));
        assert!(roots.contains(&private_temp));
        assert!(!roots.contains(&std::env::temp_dir()));
        if let Some(home) = dirs::home_dir() {
            assert!(!roots.contains(&home.join(".cache")));
            assert!(!roots.contains(&home.join(".local")));
        }
    }

    #[test]
    fn readonly_blocks_writes() {
        let config = SandboxConfig {
            enabled: true,
            readonly: true,
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new("/workspace", config);
        assert!(sandbox.check_path(Path::new("src/main.rs"), false).is_ok());
        assert!(sandbox.check_path(Path::new("src/main.rs"), true).is_err());
        assert!(sandbox.check_bash().is_err());
    }

    #[test]
    fn verifier_spec_opens_only_the_requested_workspace_and_runtime_namespace() {
        let root = tempfile::tempdir().unwrap();
        let candidate = root.path().join("candidate");
        let baseline = root.path().join("baseline");
        let runtime = root.path().join("runtime");
        for path in [&candidate, &baseline, &runtime] {
            std::fs::create_dir_all(path).unwrap();
        }
        let config = SandboxConfig {
            enabled: true,
            allowed_paths: vec![
                candidate.display().to_string(),
                baseline.display().to_string(),
                runtime.display().to_string(),
            ],
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new(&candidate, config)
            .with_readonly_paths(vec![baseline.clone()])
            .with_runtime_write_path(runtime.clone())
            .without_shared_dev_cache_writes();

        let ordinary = sandbox.os_spec().expect("sandbox backend");
        assert!(ordinary.readonly_paths.contains(&baseline));
        let temporary = sandbox
            .os_spec_for_verifier_invocation(Some(&baseline), &runtime)
            .expect("temporary baseline build sandbox")
            .expect("sandbox backend");
        assert!(!temporary.readonly_paths.contains(&baseline));
        assert!(temporary.rw_paths.contains(&baseline));
        assert!(!temporary.rw_paths.contains(&candidate));
        assert!(temporary.rw_paths.contains(&runtime));

        let baseline_test = sandbox
            .os_spec_for_verifier_invocation(None, &runtime)
            .expect("ordinary baseline sandbox")
            .expect("sandbox backend");
        assert!(!baseline_test.rw_paths.contains(&candidate));
        assert!(!baseline_test.rw_paths.contains(&baseline));
        assert!(baseline_test.rw_paths.contains(&runtime));
    }

    #[cfg(windows)]
    #[test]
    fn enabled_sandbox_selects_native_windows_backend() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = SandboxConfig {
            enabled: true,
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new(tmp.path(), config);

        let spec = sandbox
            .os_spec()
            .expect("Windows sandbox must not silently degrade to policy-only checks");
        assert!(matches!(
            spec.backend,
            crate::os_sandbox::OsSandboxBackend::WindowsRestrictedToken
        ));
    }

    #[test]
    fn denied_paths_take_precedence() {
        let config = SandboxConfig {
            enabled: true,
            allowed_paths: vec!["/".to_string()],
            denied_paths: vec!["/workspace/secrets".to_string()],
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new("/workspace", config);
        assert!(
            sandbox
                .check_path(Path::new("/workspace/secrets/key.txt"), false)
                .is_err()
        );
        assert!(
            sandbox
                .check_path(Path::new("/workspace/src/main.rs"), false)
                .is_ok()
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn symlink_to_outside_workspace_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let workspace = tmp.path().join("workspace");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, workspace.join("link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, workspace.join("link")).unwrap();

        let config = SandboxConfig {
            enabled: true,
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new(&workspace, config);

        assert!(
            sandbox
                .check_path(Path::new("link/secret.txt"), false)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_dotdot_escape_is_rejected() {
        // `link` points outside the workspace; `link/../secret.txt` would
        // resolve to `<outside>/secret.txt` through the symlink. A lexical
        // `..` collapse would erase the symlink and wrongly validate the
        // path as inside the workspace.
        let tmp = tempfile::TempDir::new().unwrap();
        let workspace = tmp.path().join("workspace");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("link")).unwrap();

        let config = SandboxConfig {
            enabled: true,
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new(&workspace, config);

        assert!(
            sandbox
                .check_path(Path::new("link/../secret.txt"), false)
                .is_err(),
            "symlink+.. escape must not validate as inside the workspace"
        );
        // The honest equivalent (no symlink traversal) still works.
        assert!(sandbox.check_path(Path::new("src/main.rs"), false).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn nonexistent_denied_path_is_compared_case_insensitively() {
        let tmp = tempfile::TempDir::new().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let config = SandboxConfig {
            enabled: true,
            denied_paths: vec![workspace.join("Secrets").display().to_string()],
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::new(&workspace, config);

        assert!(
            sandbox
                .check_path(&workspace.join("secrets").join("key.txt"), true)
                .is_err()
        );
        assert!(windows_path_component_eq(
            std::ffi::OsStr::new("ÄGenerated"),
            std::ffi::OsStr::new("ägenerated")
        ));
        assert_eq!(
            path_strip_prefix(
                Path::new(r"C:\ÄGenerated\Nested\file.txt"),
                Path::new(r"c:\ägenerated"),
            ),
            Some(PathBuf::from(r"Nested\file.txt"))
        );
    }
}
