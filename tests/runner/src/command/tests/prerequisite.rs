#[test]
fn any_environment_group_requires_exactly_one_explicit_one() {
    let alternatives = vec!["SANDBOX".to_string(), "NO_SANDBOX".to_string()];
    assert!(!exactly_one_env_is_enabled(&alternatives, |_| None));
    assert!(exactly_one_env_is_enabled(&alternatives, |name| {
        (name == "SANDBOX").then(|| "1".into())
    }));
    assert!(!exactly_one_env_is_enabled(&alternatives, |_| Some(
        "1".into()
    )));
    assert!(!exactly_one_env_is_enabled(&alternatives, |name| {
        (name == "SANDBOX").then(|| "true".into())
    }));
}

#[cfg(unix)]
#[test]
fn required_file_must_be_a_regular_executable() {
    use std::os::unix::fs::PermissionsExt;

    let temporary = tempfile::tempdir().unwrap();
    let binary = temporary.path().join("runtime-bin");
    fs::write(&binary, b"#!/bin/sh\nexit 0\n").unwrap();
    let mut suite = test_suite(vec!["true".to_string()]);
    suite.requires_files = vec![PathBuf::from("runtime-bin")];

    let reasons = prerequisites(temporary.path(), &suite);
    assert!(reasons
        .iter()
        .any(|reason| reason.contains("不是文件或不可执行")));

    let mut permissions = fs::metadata(&binary).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&binary, permissions).unwrap();
    assert!(prerequisites(temporary.path(), &suite).is_empty());
}

#[cfg(unix)]
#[test]
fn executable_environment_enforces_scope_file_type_and_mode() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let workspace_binary = workspace.path().join("workspace-bin");
    let external_binary = external.path().join("external-bin");
    for path in [&workspace_binary, &external_binary] {
        fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
    }
    let mut requirement = RequiredExecutable {
        env: "RUNTIME_BIN".to_string(),
        allow_external: false,
    };

    assert!(
        resolve_required_executable(workspace.path(), &requirement, |_| None)
            .unwrap_err()
            .contains("缺少 executable 环境变量")
    );
    assert_eq!(
        resolve_required_executable(workspace.path(), &requirement, |_| {
            Some("workspace-bin".into())
        })
        .unwrap(),
        workspace_binary.canonicalize().unwrap()
    );
    assert!(
        resolve_required_executable(workspace.path(), &requirement, |_| {
            Some(external_binary.as_os_str().to_owned())
        })
        .unwrap_err()
        .contains("不允许指向工作区外")
    );
    requirement.allow_external = true;
    assert_eq!(
        resolve_required_executable(workspace.path(), &requirement, |_| {
            Some(external_binary.as_os_str().to_owned())
        })
        .unwrap(),
        external_binary.canonicalize().unwrap()
    );

    let non_executable = workspace.path().join("non-executable");
    fs::write(&non_executable, b"not executable").unwrap();
    assert!(
        resolve_required_executable(workspace.path(), &requirement, |_| {
            Some(non_executable.as_os_str().to_owned())
        })
        .unwrap_err()
        .contains("regular executable")
    );
    assert!(
        resolve_required_executable(workspace.path(), &requirement, |_| {
            Some(workspace.path().as_os_str().to_owned())
        })
        .unwrap_err()
        .contains("regular executable")
    );
}

#[test]
fn missing_executable_environment_is_unmet_without_execution() {
    let temporary = tempfile::tempdir().unwrap();
    let context = RunContext::create(
        temporary.path().join("runs"),
        RunMetadata::new("missing-runtime", TestTier::Unit, ModelPolicy::Forbidden),
    )
    .unwrap();
    let mut suite = test_suite(vec!["true".to_string()]);
    suite.requires_executables = vec![RequiredExecutable {
        env: "KCODER_TEST_MISSING_EXECUTABLE_PATH_9D9E".to_string(),
        allow_external: true,
    }];

    let outcome = run_suite(temporary.path(), &context, &suite, &Consent::default()).unwrap();
    assert!(matches!(outcome, SuiteOutcome::UnmetPrerequisite { .. }));
    assert!(!outcome.executed());
    assert!(!context.case_path(&suite.id, "logs").unwrap().exists());
}
