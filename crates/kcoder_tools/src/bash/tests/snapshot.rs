use super::*;

#[test]
fn shell_invocation_uses_pipefail_for_bash() {
    let invocation = shell_invocation("/bin/bash", "false | true", false, false);

    assert_eq!(invocation.program, "/bin/bash");
    assert_eq!(
        invocation.args,
        vec!["-o", "pipefail", "-c", "false | true"]
    );
}

#[test]
fn shell_invocation_loads_ready_snapshot_in_same_shell() {
    if !Path::new("/bin/bash").exists() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let snapshot = temp.path().join("snapshot.sh");
    std::fs::write(
        &snapshot,
        "export SNAPSHOT_VALUE=ready\nsnapshot_function() { printf function-ok; }\n",
    )
    .unwrap();
    let invocation = shell_invocation(
        "/bin/bash",
        "printf '%s ' \"$SNAPSHOT_VALUE\"; snapshot_function",
        true,
        false,
    );
    let output = std::process::Command::new(invocation.program)
        .args(invocation.args)
        .env("KCODER_SHELL_SNAPSHOT", snapshot)
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "ready function-ok");
}

#[test]
fn isolated_shell_snapshot_is_copied_into_private_runtime() {
    let source_root = tempfile::tempdir().unwrap();
    let runtime_root = tempfile::tempdir().unwrap();
    let source = source_root.path().join("snapshot.sh");
    std::fs::write(&source, "export PATH=/task/python/bin:/usr/bin\n").unwrap();

    let visible = shell_snapshot_for_spawn(Some(&source), Some(runtime_root.path()))
        .unwrap()
        .unwrap();

    assert!(visible.path.starts_with(runtime_root.path()));
    assert_ne!(visible.path, source);
    assert_eq!(
        std::fs::read(&visible.path).unwrap(),
        std::fs::read(&source).unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&visible.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn isolated_shell_snapshot_never_follows_a_precreated_target_symlink() {
    use std::os::unix::fs::symlink;

    let source_root = tempfile::tempdir().unwrap();
    let runtime_root = tempfile::tempdir().unwrap();
    let outside_root = tempfile::tempdir().unwrap();
    let source = source_root.path().join("snapshot.sh");
    std::fs::write(&source, "export PATH=/task/python/bin:/usr/bin\n").unwrap();
    let outside = outside_root.path().join("outside.txt");
    std::fs::write(&outside, "do-not-overwrite").unwrap();
    let trap = runtime_root
        .path()
        .join(format!("shell-snapshot-{}-1.sh", std::process::id()));
    symlink(&outside, &trap).unwrap();

    let visible = shell_snapshot_for_spawn(Some(&source), Some(runtime_root.path()))
        .unwrap()
        .unwrap();

    assert_ne!(visible.path, trap);
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "do-not-overwrite"
    );
    assert!(
        std::fs::symlink_metadata(&trap)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        !std::fs::symlink_metadata(&visible.path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(not(windows))]
#[tokio::test]
async fn isolated_shell_loads_path_from_the_private_snapshot_copy() {
    use std::os::unix::fs::PermissionsExt;

    let source_root = tempfile::tempdir().unwrap();
    let runtime_root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let task_bin = source_root.path().join("task-bin");
    std::fs::create_dir(&task_bin).unwrap();
    let task_python = task_bin.join("task-python");
    std::fs::write(&task_python, "#!/bin/sh\nprintf task-python-ready\n").unwrap();
    std::fs::set_permissions(&task_python, std::fs::Permissions::from_mode(0o755)).unwrap();
    let snapshot = source_root.path().join("snapshot.sh");
    std::fs::write(
        &snapshot,
        format!("export PATH='{}':/usr/bin:/bin\n", task_bin.display()),
    )
    .unwrap();

    let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace.path())));
    let running = RunningShell::spawn(
        "/bin/bash".to_string(),
        "task-python",
        workspace.path().to_path_buf(),
        1_000,
        limits.clone(),
        ShellSpawnPolicy {
            snapshot_path: Some(&snapshot),
            snapshot_copy_root: None,
            isolation_root: Some(runtime_root.path()),
            isolation_workspace_root: Some(workspace.path()),
            os_sandbox: None,
        },
    )
    .unwrap();
    // Spawn already copied the snapshot into the private runtime root. Removing
    // the original proves that the child no longer depends on a configuration
    // directory path that the verifier cannot read.
    std::fs::remove_file(&snapshot).unwrap();

    let output = running
        .wait_for_output("task-python", limits)
        .await
        .unwrap();

    assert!(!output.is_error, "{}", output_text(&output));
    assert!(output_text(&output).contains("task-python-ready"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ordinary_sandbox_shell_restores_a_snapshot_below_deny_read() {
    use std::os::unix::fs::PermissionsExt as _;

    if !crate::os_sandbox::landlock_supported() {
        eprintln!("landlock unavailable; skipping confinement test");
        return;
    }
    let root = tempfile::tempdir_in("/dev/shm").unwrap();
    let config_root = root.path().join("private-config");
    let workspace = root.path().join("workspace");
    let private_temp = root.path().join("private-tmp");
    let task_bin = root.path().join("task-bin");
    for directory in [&config_root, &workspace, &private_temp, &task_bin] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::set_permissions(&private_temp, std::fs::Permissions::from_mode(0o700)).unwrap();
    let task_python = task_bin.join("python");
    std::fs::write(
        &task_python,
        "#!/bin/sh\nprintf '%s\\n' task-python-ready\n",
    )
    .unwrap();
    std::fs::set_permissions(&task_python, std::fs::Permissions::from_mode(0o755)).unwrap();
    let snapshot = config_root.join("task.sh");
    std::fs::write(
        &snapshot,
        "export DEEPSEEK_API_KEY='provider-secret-sentinel'\n\
             snapshot_secret_function() { printf leaked-function; }\n\
             alias snapshot_secret_alias='printf leaked-alias'\n",
    )
    .unwrap();
    let sandbox_snapshot = config_root.join("task.sandbox.sh");
    let sandbox_source = crate::shell_snapshot::sandbox_snapshot_source([
        (
            OsString::from("PATH"),
            OsString::from(format!("{}:/usr/bin:/bin", task_bin.display())),
        ),
        (
            OsString::from("VIRTUAL_ENV"),
            OsString::from("/task/python"),
        ),
        (
            OsString::from("PYTHONPATH"),
            OsString::from("/task/workspace:/harness/bootstrap"),
        ),
        (OsString::from("PYTHONNOUSERSITE"), OsString::from("1")),
        (
            OsString::from("PIP_REQUIRE_VIRTUALENV"),
            OsString::from("1"),
        ),
        (OsString::from("HOME"), OsString::from("/task/home")),
        (
            OsString::from("XDG_CACHE_HOME"),
            OsString::from("/task/cache"),
        ),
        (
            OsString::from("PIP_CACHE_DIR"),
            OsString::from("/task/cache/pip"),
        ),
        (
            OsString::from("SWE_BENCH_BASE_SITE_PACKAGES"),
            OsString::from("/shared/site-packages"),
        ),
        (
            OsString::from("SWE_BENCH_PRIVATE_SITE_PACKAGES"),
            OsString::from("/task/private-site-packages"),
        ),
        (
            OsString::from("DEEPSEEK_API_KEY"),
            OsString::from("provider-secret-sentinel"),
        ),
    ]);
    std::fs::write(&sandbox_snapshot, sandbox_source).unwrap();
    let snapshots = crate::ShellEnvironmentSnapshot::from_paths_for_test(
        Some(snapshot.clone()),
        None,
        Some(sandbox_snapshot.clone()),
    );
    let mut rw_paths = vec![workspace.clone(), private_temp.clone()];
    if Path::new("/dev/null").exists() {
        rw_paths.push(PathBuf::from("/dev/null"));
    }
    let sandbox = crate::os_sandbox::OsSandboxSpec {
        backend: crate::os_sandbox::OsSandboxBackend::Landlock,
        rw_paths,
        readonly_paths: Vec::new(),
        deny_read: vec![config_root.clone()],
    };
    let selection = select_shell_snapshot(Some(&snapshots), false, Some(&sandbox)).unwrap();
    assert_eq!(selection.path.as_deref(), Some(sandbox_snapshot.as_path()));
    assert!(selection.requires_private_copy);
    let copy_root = ordinary_shell_snapshot_copy_root(
        selection.requires_private_copy,
        &workspace,
        Some(&sandbox),
        Some(private_temp.as_os_str()),
    )
    .unwrap()
    .expect("a denied snapshot must use the explicit private temp root");
    let command = format!(
        "python; printf 'PYTHONPATH=%s\\nHOME=%s\\nCACHE=%s\\nBASE=%s\\nPRIVATE=%s\\nSECRET=%s\\n' \
             \"$PYTHONPATH\" \"$HOME\" \"$XDG_CACHE_HOME\" \
             \"$SWE_BENCH_BASE_SITE_PACKAGES\" \"$SWE_BENCH_PRIVATE_SITE_PACKAGES\" \
             \"${{DEEPSEEK_API_KEY-unset}}\"; \
             if grep -Fq provider-secret-sentinel \"$KCODER_SHELL_SNAPSHOT\"; \
             then echo COPIED_SECRET; exit 7; else echo COPIED_CLEAN; fi; \
             if type snapshot_secret_function >/dev/null 2>&1; \
             then echo FUNCTION_VISIBLE; exit 8; else echo FUNCTION_ABSENT; fi; \
             if alias snapshot_secret_alias >/dev/null 2>&1; \
             then echo ALIAS_VISIBLE; exit 9; else echo ALIAS_ABSENT; fi; \
             if cat '{}' >/dev/null 2>&1; then echo ORIGINAL_VISIBLE; exit 9; \
             else echo ORIGINAL_DENIED; fi",
        snapshot.display()
    );
    let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(&workspace)));
    let running = RunningShell::spawn(
        "/bin/bash".to_string(),
        &command,
        workspace.clone(),
        2_000,
        limits.clone(),
        ShellSpawnPolicy {
            snapshot_path: selection.path.as_deref(),
            snapshot_copy_root: Some(&copy_root),
            isolation_root: None,
            isolation_workspace_root: None,
            os_sandbox: Some(sandbox),
        },
    )
    .unwrap();
    let copied_snapshot = running
        ._shell_snapshot
        .as_ref()
        .expect("ordinary sandbox shell must own a temporary snapshot")
        .path()
        .to_path_buf();
    let copied_mode = std::fs::metadata(&copied_snapshot)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert!(copied_snapshot.starts_with(&private_temp));
    assert_eq!(copied_mode, 0o600);
    let copied_source = std::fs::read_to_string(&copied_snapshot).unwrap();
    assert!(!copied_source.contains("provider-secret-sentinel"));
    assert!(!copied_source.contains("DEEPSEEK_API_KEY"));
    assert!(!copied_source.contains("snapshot_secret_function"));
    assert!(!copied_source.contains("snapshot_secret_alias"));

    let output = running.wait_for_output(&command, limits).await.unwrap();
    let text = output_text(&output);
    assert!(!output.is_error, "{text}");
    assert!(text.contains("task-python-ready"), "{text}");
    assert!(
        text.contains("PYTHONPATH=/task/workspace:/harness/bootstrap"),
        "{text}"
    );
    assert!(text.contains("HOME=/task/home"), "{text}");
    assert!(text.contains("CACHE=/task/cache"), "{text}");
    assert!(text.contains("BASE=/shared/site-packages"), "{text}");
    assert!(
        text.contains("PRIVATE=/task/private-site-packages"),
        "{text}"
    );
    assert!(text.contains("SECRET=unset"), "{text}");
    assert!(text.contains("COPIED_CLEAN"), "{text}");
    assert!(text.contains("FUNCTION_ABSENT"), "{text}");
    assert!(text.contains("ALIAS_ABSENT"), "{text}");
    assert!(text.contains("ORIGINAL_DENIED"), "{text}");
    assert!(
        snapshot.is_file(),
        "the trusted source snapshot must remain intact"
    );
    assert!(
        !copied_snapshot.exists(),
        "the per-invocation snapshot must be removed after the shell exits"
    );
}

#[cfg(not(windows))]
#[test]
fn isolated_shell_keeps_swe_bench_dependency_roots_for_python_bootstrap() {
    let python = Path::new("/usr/bin/python3");
    if !python.exists() {
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let bootstrap = root.path().join("bootstrap");
    let base_site = root.path().join("base-site-packages");
    let private_site = root.path().join("private-site-packages");
    let runs_root = root.path().join("runs");
    for directory in [
        &workspace,
        &bootstrap,
        &base_site,
        &private_site,
        &runs_root,
    ] {
        std::fs::create_dir_all(directory).unwrap();
    }
    std::fs::write(
        bootstrap.join("sitecustomize.py"),
        r#"import os, sys
for name in ('SWE_BENCH_BASE_SITE_PACKAGES', 'SWE_BENCH_PRIVATE_SITE_PACKAGES'):
    for value in os.environ.get(name, '').split(os.pathsep):
        if value:
            sys.path.append(value)
"#,
    )
    .unwrap();
    std::fs::write(base_site.join("base_dependency.py"), "ORIGIN = 'base'\n").unwrap();
    std::fs::write(
        private_site.join("private_dependency.py"),
        "ORIGIN = 'private'\n",
    )
    .unwrap();

    let snapshot = root.path().join("verifier-snapshot.sh");
    std::fs::write(
        &snapshot,
        format!(
            "export PATH='/usr/bin:/bin'\n\
                 export SWE_BENCH_BASE_SITE_PACKAGES='{}'\n\
                 export SWE_BENCH_PRIVATE_SITE_PACKAGES='{}'\n\
                 export SWE_BENCH_RUNS_ROOT='{}'\n",
            base_site.display(),
            private_site.display(),
            runs_root.display(),
        ),
    )
    .unwrap();

    let isolated_python_path =
        std::env::join_paths([workspace.as_path(), bootstrap.as_path()]).unwrap();
    let invocation = shell_invocation(
        "/bin/bash",
        "/usr/bin/python3 -c 'import base_dependency, private_dependency, os; print(base_dependency.ORIGIN, private_dependency.ORIGIN, os.environ[\"SWE_BENCH_RUNS_ROOT\"])'",
        true,
        true,
    );
    let output = std::process::Command::new(invocation.program)
        .args(invocation.args)
        .env_clear()
        .env("KCODER_SHELL_SNAPSHOT", &snapshot)
        .env("KCODER_ISOLATED_HOME", root.path().join("home"))
        .env("KCODER_ISOLATED_CACHE", root.path().join("cache"))
        .env("KCODER_ISOLATED_TMP", root.path().join("tmp"))
        .env("KCODER_ISOLATED_PIP_CACHE", root.path().join("pip-cache"))
        .env("KCODER_ISOLATED_NPM_CACHE", root.path().join("npm-cache"))
        .env(
            "KCODER_ISOLATED_PYTHON_CACHE",
            root.path().join("python-cache"),
        )
        .env("KCODER_ISOLATED_PYTHONPATH", isolated_python_path)
        .env("KCODER_ISOLATED_PYTEST_ADDOPTS", "")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        format!("base private {}", runs_root.display())
    );
}

#[test]
fn ordinary_shell_uses_the_original_ready_snapshot() {
    let source_root = tempfile::tempdir().unwrap();
    let source = source_root.path().join("snapshot.sh");
    std::fs::write(&source, "export SNAPSHOT_VALUE=ready\n").unwrap();

    let prepared = shell_snapshot_for_spawn(Some(&source), None)
        .unwrap()
        .unwrap();
    assert_eq!(prepared.path, source);
    assert!(prepared.temporary.is_none());
}
