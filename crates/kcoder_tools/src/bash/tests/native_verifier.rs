use super::*;

#[cfg(target_os = "linux")]
#[tokio::test]
async fn verifier_native_builds_candidate_and_baseline_separately_then_refreezes_baseline() {
    if !crate::os_sandbox::landlock_supported() {
        eprintln!("landlock unavailable; skipping confinement test");
        return;
    }
    let python = "python3";
    if std::process::Command::new(python)
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let root = tempfile::tempdir_in("/dev/shm").unwrap();
    let candidate = root.path().join("candidate");
    let baseline = root.path().join("baseline");
    let runtime = root.path().join("runtime");
    let candidate_runtime = verifier_isolation_workspace_directory(&runtime, Some(&candidate));
    let baseline_runtime = verifier_isolation_workspace_directory(&runtime, Some(&baseline));
    for workspace in [&candidate, &baseline] {
        std::fs::create_dir_all(workspace.join("package")).unwrap();
        std::fs::write(
                workspace.join("setup.py"),
                "import pathlib\npathlib.Path('package/_native.test.so').write_bytes(pathlib.Path('source.txt').read_bytes())\n",
            )
            .unwrap();
    }
    std::fs::write(
            baseline.join("setup.py"),
            format!(
                "import pathlib\nfor target in [{:?}, {:?}]:\n try:\n  pathlib.Path(target).write_text('escaped')\n except OSError:\n  pass\npathlib.Path('package/_native.test.so').write_bytes(pathlib.Path('source.txt').read_bytes())\n",
                candidate.join("baseline-write-escape"),
                candidate_runtime.join("baseline-write-escape"),
            ),
        )
        .unwrap();
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(candidate.join("source.txt"), "candidate").unwrap();
    std::fs::write(baseline.join("source.txt"), "baseline").unwrap();

    let sandbox = crate::Sandbox::new(
        &candidate,
        kcoder_types::SandboxConfig {
            enabled: true,
            allowed_paths: vec![
                candidate.display().to_string(),
                baseline.display().to_string(),
                runtime.display().to_string(),
            ],
            ..kcoder_types::SandboxConfig::default()
        },
    )
    .with_readonly_paths(vec![baseline.clone()])
    .with_runtime_write_path(runtime.clone())
    .without_shared_dev_cache_writes();
    let command = format!("{python} setup.py build_ext --inplace");
    assert!(verifier_native_build_command_signature(&command).is_some());

    for path in [&candidate_runtime, &baseline_runtime] {
        std::fs::create_dir_all(path).unwrap();
    }
    for (workspace, spec) in [
        (
            &candidate,
            sandbox
                .os_spec_for_verifier_invocation(Some(&candidate), &candidate_runtime)
                .unwrap()
                .expect("candidate sandbox spec"),
        ),
        (
            &baseline,
            sandbox
                .os_spec_for_verifier_invocation(Some(&baseline), &baseline_runtime)
                .unwrap()
                .expect("baseline preparation sandbox spec"),
        ),
    ] {
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace)));
        let running = RunningShell::spawn(
            "/bin/bash".to_string(),
            &command,
            workspace.to_path_buf(),
            5_000,
            limits.clone(),
            ShellSpawnPolicy {
                isolation_root: Some(&runtime),
                isolation_workspace_root: Some(workspace),
                os_sandbox: Some(spec),
                ..ShellSpawnPolicy::default()
            },
        )
        .unwrap();
        let output = running.wait_for_output(&command, limits).await.unwrap();
        assert!(!output.is_error, "{}", output_text(&output));
    }

    assert_eq!(
        std::fs::read(candidate.join("package/_native.test.so")).unwrap(),
        b"candidate"
    );
    assert_eq!(
        std::fs::read(baseline.join("package/_native.test.so")).unwrap(),
        b"baseline"
    );
    assert!(!candidate.join("baseline-write-escape").exists());
    assert!(!candidate_runtime.join("baseline-write-escape").exists());

    let blocked = format!("{python} -c 'open(\"should-stay-blocked\", \"w\").write(\"x\")'");
    for (workspace, runtime_namespace) in [
        (&candidate, &candidate_runtime),
        (&baseline, &baseline_runtime),
    ] {
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace)));
        let running = RunningShell::spawn(
            "/bin/bash".to_string(),
            &blocked,
            workspace.clone(),
            5_000,
            limits.clone(),
            ShellSpawnPolicy {
                isolation_root: Some(&runtime),
                isolation_workspace_root: Some(workspace),
                os_sandbox: sandbox
                    .os_spec_for_verifier_invocation(None, runtime_namespace)
                    .unwrap(),
                ..ShellSpawnPolicy::default()
            },
        )
        .unwrap();
        let output = running.wait_for_output(&blocked, limits).await.unwrap();
        assert!(output.is_error, "{}", output_text(&output));
        assert!(!workspace.join("should-stay-blocked").exists());
    }
}
