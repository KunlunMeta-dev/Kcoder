//! OS-level filesystem confinement plans for spawned shell processes.
//!
//! The policy sandbox in `sandbox.rs` checks paths at the tool layer; this
//! module hardens spawned child processes with a kernel-enforced ruleset:
//! reads stay unrestricted, writes are confined to the working directory,
//! explicitly allowed paths, /tmp, /dev pseudo-files, and common developer
//! caches. Sandbox `denied_paths` are carved out of both the read tree and
//! the rw grants (Landlock is a pure allowlist, so excluding a subtree means
//! replacing each ancestor grant with the sibling entries around it; device
//! nodes/sockets are never granted because the kernel must open every rule
//! path). When the kernel lacks Landlock support the caller degrades to the
//! policy-only sandbox instead of failing the spawn.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsSandboxBackend {
    Landlock,
    WindowsRestrictedToken,
}

impl Default for OsSandboxBackend {
    fn default() -> Self {
        if cfg!(windows) {
            Self::WindowsRestrictedToken
        } else {
            Self::Landlock
        }
    }
}

/// Filesystem confinement plan for one spawned child.
#[derive(Debug, Clone, Default)]
pub struct OsSandboxSpec {
    pub backend: OsSandboxBackend,
    /// Paths the child may read AND write (workspace, allowed paths, /tmp,
    /// caches). Everything else is read+execute only.
    pub rw_paths: Vec<PathBuf>,
    /// Paths available for read/execute but never write, even when nested
    /// below a broader writable grant such as `/tmp`.
    pub readonly_paths: Vec<PathBuf>,
    /// Paths the child may not access at all (the sandbox `denied_paths`).
    /// They are carved out of both the read tree and the rw grants.
    pub deny_read: Vec<PathBuf>,
}

/// Split `initial` grants so none of them covers any `deny` path. Landlock
/// is a pure allowlist: excluding a subtree requires replacing each ancestor
/// grant with the sibling entries around the denied path, recursively.
#[cfg(any(target_os = "linux", test))]
fn carve_grants(initial: Vec<PathBuf>, deny: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    /// Safety valve against expanding truly enormous directories when a
    /// denied path sits next to a huge sibling set. 4096 covers busy
    /// directories like /tmp on shared hosts while bounding the rule count
    /// handed to the kernel.
    const MAX_SPLIT_ENTRIES: usize = 4096;

    let denied_targets: Vec<PathBuf> = deny
        .iter()
        .map(|path| std::fs::canonicalize(path).unwrap_or_else(|_| path.clone()))
        .collect();
    let aliases_denied_target = |path: &std::path::Path| {
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            // A disappearing path cannot be opened as a Landlock rule.
            return true;
        };
        if !metadata.file_type().is_symlink() {
            return false;
        }
        let Ok(target) = std::fs::canonicalize(path) else {
            // Broken or racing symlinks fail closed instead of becoming rules.
            return true;
        };
        denied_targets
            .iter()
            .any(|denied| target.starts_with(denied) || denied.starts_with(&target))
    };

    let mut grants = initial;
    for denied in &denied_targets {
        let denied = denied.as_path();
        let mut next = Vec::new();
        for grant in grants {
            let mut stack = vec![grant];
            while let Some(dir) = stack.pop() {
                // `path_beneath_rules` opens paths without O_NOFOLLOW. A
                // sibling symlink can therefore resolve back to a denied
                // inode and silently re-authorize it unless it is omitted.
                if aliases_denied_target(&dir) {
                    continue;
                }
                if dir == denied {
                    continue;
                }
                if !denied.starts_with(&dir) {
                    next.push(dir);
                    continue;
                }
                let entries = std::fs::read_dir(&dir).map_err(|e| {
                    format!(
                        "failed to list {} while carving denied sandbox path {}: {e}",
                        dir.display(),
                        denied.display()
                    )
                })?;
                let mut count = 0usize;
                for entry in entries {
                    let entry = entry.map_err(|e| {
                        format!("failed to read an entry of {}: {e}", dir.display())
                    })?;
                    count += 1;
                    if count > MAX_SPLIT_ENTRIES {
                        return Err(format!(
                            "refusing to split {} (more than {MAX_SPLIT_ENTRIES} entries) to carve denied sandbox path {}",
                            dir.display(),
                            denied.display()
                        ));
                    }
                    let child = entry.path();
                    if child == denied {
                        continue;
                    }
                    if denied.starts_with(&child) {
                        stack.push(child);
                    } else {
                        // Landlock opens every granted path; device nodes,
                        // sockets and fifos (e.g. under /dev) fail that open,
                        // so only directories and regular files are granted.
                        // Skipped special files lose coverage, which is the
                        // intended trade-off of confinement.
                        let include = entry
                            .file_type()
                            .map(|ft| {
                                if ft.is_symlink() {
                                    !aliases_denied_target(&child)
                                        && std::fs::metadata(&child)
                                            .map(|meta| meta.is_dir() || meta.is_file())
                                            .unwrap_or(false)
                                } else {
                                    ft.is_dir() || ft.is_file()
                                }
                            })
                            .unwrap_or(false);
                        if include {
                            next.push(child);
                        }
                    }
                }
            }
        }
        grants = next;
    }
    Ok(grants)
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{OsSandboxSpec, carve_grants};
    use landlock::{
        ABI, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetCreatedAttr,
        path_beneath_rules,
    };
    use std::sync::OnceLock;

    /// Probe the Landlock ABI once. This is a pure version query
    /// (LANDLOCK_CREATE_RULESET_VERSION) and does not confine the process.
    pub fn landlock_supported() -> bool {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        *SUPPORTED.get_or_init(|| {
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_landlock_create_ruleset,
                    std::ptr::null_mut::<u8>(),
                    0usize,
                    1u32, // LANDLOCK_CREATE_RULESET_VERSION
                )
            };
            rc >= 1
        })
    }

    /// Apply the spec to the current (about-to-exec) process. Called from a
    /// `pre_exec` hook; errors abort the exec with EACCES (fail closed).
    pub fn apply(spec: &OsSandboxSpec) -> Result<(), String> {
        if spec.backend != super::OsSandboxBackend::Landlock {
            return Err("attempted to apply a non-Landlock sandbox in pre_exec".to_string());
        }
        let abi = ABI::V4;
        let read_exec = AccessFs::from_read(abi) | AccessFs::Execute;
        let mut created = Ruleset::default()
            .handle_access(AccessFs::from_all(abi))
            .map_err(|e| format!("landlock handle_access: {e}"))?
            .set_compatibility(CompatLevel::BestEffort)
            .create()
            .map_err(|e| format!("landlock create ruleset: {e}"))?;
        let read_grants = if spec.deny_read.is_empty() {
            vec![std::path::PathBuf::from("/")]
        } else {
            carve_grants(vec![std::path::PathBuf::from("/")], &spec.deny_read)?
        };
        created = created
            .add_rules(path_beneath_rules(&read_grants, read_exec))
            .map_err(|e| format!("landlock read-exec rule: {e}"))?;
        let rw_paths = carve_grants(spec.rw_paths.clone(), &spec.readonly_paths)?;
        let rw_paths = carve_grants(rw_paths, &spec.deny_read)?;
        if !rw_paths.is_empty() {
            created = created
                .add_rules(path_beneath_rules(&rw_paths, AccessFs::from_all(abi)))
                .map_err(|e| format!("landlock rw rules: {e}"))?;
        }
        created
            .restrict_self()
            .map_err(|e| format!("landlock restrict_self: {e}"))?;
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::OsSandboxSpec;

    pub fn landlock_supported() -> bool {
        false
    }

    pub fn apply(_spec: &OsSandboxSpec) -> Result<(), String> {
        Err("landlock is only available on Linux".to_string())
    }
}

pub use imp::{apply, landlock_supported};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_probe_does_not_confine_the_process() {
        // Just exercise the probe; must not panic or change process state.
        let _ = landlock_supported();
        // Confirm the process is still fully capable afterwards.
        #[cfg(unix)]
        let probe = std::process::Command::new("true").status().unwrap();
        #[cfg(windows)]
        let probe = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .status()
            .unwrap();
        assert!(probe.success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn confined_child_writes_workspace_but_not_system_dirs() {
        if !landlock_supported() {
            eprintln!("landlock unavailable; skipping confinement test");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let spec = OsSandboxSpec {
            backend: OsSandboxBackend::Landlock,
            rw_paths: vec![tmp.path().to_path_buf(), PathBuf::from("/tmp")],
            readonly_paths: Vec::new(),
            deny_read: Vec::new(),
        };
        let run = |cmd: &str| {
            use std::os::unix::process::CommandExt as _;
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg(cmd);
            let spec = spec.clone();
            unsafe {
                command.pre_exec(move || {
                    apply(&spec)
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))
                });
            }
            command.output().unwrap()
        };

        // Read stays open.
        let out = run("cat /etc/hostname");
        assert!(
            out.status.success(),
            "read /etc/hostname failed: {:?}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Write inside workspace works.
        let out = run(&format!("touch {}/ok.txt", tmp.path().display()));
        assert!(
            out.status.success(),
            "workspace write failed: {:?}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Write to a system dir is denied by the kernel.
        let out = run("touch /etc/landlock-deny-test 2>/dev/null || echo DENIED");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("DENIED"),
            "system write was not denied: {stdout}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn confined_child_cannot_write_shared_environment() {
        if !landlock_supported() {
            eprintln!("landlock unavailable; skipping confinement test");
            return;
        }
        let root = tempfile::tempdir_in("/dev/shm").unwrap();
        let workspace = root.path().join("workspace");
        let private_temp = root.path().join("private-tmp");
        let shared_environment = root.path().join("shared-environment");
        for path in [&workspace, &private_temp, &shared_environment] {
            std::fs::create_dir_all(path).unwrap();
        }
        let spec = OsSandboxSpec {
            backend: OsSandboxBackend::Landlock,
            rw_paths: vec![workspace.clone(), private_temp.clone()],
            readonly_paths: Vec::new(),
            deny_read: Vec::new(),
        };
        let run = |cmd: &str| {
            use std::os::unix::process::CommandExt as _;
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg(cmd);
            let spec = spec.clone();
            unsafe {
                command.pre_exec(move || {
                    apply(&spec)
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))
                });
            }
            command.output().unwrap()
        };

        let allowed = run(&format!("touch {}/ok", private_temp.display()));
        assert!(allowed.status.success(), "private temp must be writable");
        let denied = run(&format!(
            "touch {}/python 2>/dev/null || echo DENIED",
            shared_environment.display()
        ));
        assert!(
            String::from_utf8_lossy(&denied.stdout).contains("DENIED"),
            "shared interpreter/dependency paths must remain read-only"
        );
    }

    #[test]
    fn carve_grants_splits_ancestors_and_keeps_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // tree: root/{keep_a, keep_b, bench/{dataset, other}}
        std::fs::create_dir_all(root.join("keep_a")).unwrap();
        std::fs::create_dir_all(root.join("keep_b")).unwrap();
        std::fs::create_dir_all(root.join("bench/dataset")).unwrap();
        std::fs::create_dir_all(root.join("bench/other")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("bench/dataset"), root.join("dataset-alias")).unwrap();

        let grants = carve_grants(vec![root.to_path_buf()], &[root.join("bench/dataset")]).unwrap();
        assert!(
            grants.contains(&root.join("keep_a")) && grants.contains(&root.join("keep_b")),
            "siblings must stay granted: {grants:?}"
        );
        assert!(grants.contains(&root.join("bench/other")), "{grants:?}");
        assert!(
            !grants
                .iter()
                .any(|g| g.starts_with(root.join("bench/dataset"))),
            "the denied subtree must not be reachable through any grant: {grants:?}"
        );
        assert!(
            !grants.contains(&root.join("bench")),
            "an ancestor of the denied path must be split, not granted whole: {grants:?}"
        );
        #[cfg(unix)]
        assert!(
            !grants.contains(&root.join("dataset-alias")),
            "a symlink resolving inside the denied subtree must not become a sibling grant: {grants:?}"
        );

        // A second, nested deny path carves only the nested subtree.
        std::fs::create_dir_all(root.join("keep_a/inner/nested")).unwrap();
        std::fs::write(root.join("keep_a/inner/keep.txt"), "keep").unwrap();
        std::fs::write(root.join("keep_a/inner/nested/secret.txt"), "secret").unwrap();
        let grants = carve_grants(grants, &[root.join("keep_a/inner/nested")]).unwrap();
        assert!(grants.contains(&root.join("bench/other")), "{grants:?}");
        assert!(
            grants.contains(&root.join("keep_a/inner/keep.txt")),
            "sibling content inside keep_a must survive: {grants:?}"
        );
        assert!(
            !grants
                .iter()
                .any(|g| g.starts_with(root.join("keep_a/inner/nested"))),
            "nested deny must be carved out: {grants:?}"
        );

        // A deny path outside every grant is a no-op.
        let grants = carve_grants(
            vec![root.to_path_buf()],
            &[std::path::PathBuf::from("/definitely/not/under/root")],
        )
        .unwrap();
        assert_eq!(grants, vec![root.to_path_buf()]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn confined_child_cannot_read_denied_subtree() {
        if !landlock_supported() {
            eprintln!("landlock unavailable; skipping confinement test");
            return;
        }
        // Keep the split chain small: on busy hosts /tmp itself may exceed
        // the split cap, and any deny under it would fail closed there.
        let tmp = tempfile::tempdir_in("/dev/shm").unwrap();
        let secret = tmp.path().join("dataset/answers.txt");
        std::fs::create_dir_all(secret.parent().unwrap()).unwrap();
        std::fs::write(&secret, "reference answer").unwrap();
        let secret_alias = tmp.path().join("dataset-alias");
        std::os::unix::fs::symlink(secret.parent().unwrap(), &secret_alias).unwrap();
        let open_file = tmp.path().join("open/note.txt");
        std::fs::create_dir_all(open_file.parent().unwrap()).unwrap();
        std::fs::write(&open_file, "public").unwrap();

        let spec = OsSandboxSpec {
            backend: OsSandboxBackend::Landlock,
            rw_paths: vec![tmp.path().to_path_buf()],
            readonly_paths: Vec::new(),
            deny_read: vec![tmp.path().join("dataset")],
        };
        let run = |cmd: &str| {
            use std::os::unix::process::CommandExt as _;
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg(cmd);
            let spec = spec.clone();
            unsafe {
                command.pre_exec(move || {
                    apply(&spec)
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))
                });
            }
            command.output().unwrap()
        };

        let out = run(&format!(
            "cat {} 2>/dev/null || echo DENIED",
            secret.display()
        ));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("DENIED"),
            "denied subtree must be unreadable: {stdout}"
        );

        let out = run(&format!(
            "cat {}/answers.txt 2>/dev/null || echo DENIED",
            secret_alias.display()
        ));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("DENIED"),
            "a symlink alias must not re-authorize the denied subtree: {stdout}"
        );

        let out = run(&format!("cat {}", open_file.display()));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "public",
            "sibling content must stay readable"
        );

        // The denied subtree is carved out of rw grants as well.
        let out = run(&format!(
            "touch {} 2>/dev/null || echo DENIED",
            tmp.path().join("dataset/new.txt").display()
        ));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("DENIED"),
            "denied subtree must not be writable via the rw grant: {stdout}"
        );
    }
}
