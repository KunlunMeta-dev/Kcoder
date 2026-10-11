//! Verifier-only process environment and trusted Python/bootstrap path construction.

use super::*;

pub(crate) fn verifier_isolation_environment(
    root: &Path,
    workspace_root: Option<&Path>,
) -> Result<Vec<(OsString, OsString)>, ToolError> {
    let workspace_runtime = verifier_isolation_workspace_directory(root, workspace_root);
    let home = workspace_runtime.join("home");
    let cache = workspace_runtime.join("cache");
    let temp = workspace_runtime.join("tmp");
    let pip_cache = cache.join("pip");
    let npm_cache = cache.join("npm");
    let python_cache = cache.join("python");
    // Partition the entire home, cache, and temp environment by Candidate/Baseline
    // provenance, not only the Cargo target. Python, pip, npm, and tool configuration
    // caches can also change results on the other side.
    let cargo_target = cache.join("cargo-target");
    for directory in [
        &home,
        &cache,
        &temp,
        &pip_cache,
        &npm_cache,
        &python_cache,
        &cargo_target,
    ] {
        std::fs::create_dir_all(directory).map_err(|error| {
            ToolError::Execution(format!(
                "failed to prepare isolated verifier directory `{}`: {error}",
                directory.display()
            ))
        })?;
    }
    #[cfg(windows)]
    let null_config = OsString::from("NUL");
    #[cfg(not(windows))]
    let null_config = OsString::from("/dev/null");
    let mut environment = vec![
        ("HOME".into(), home.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_HOME".into(),
            home.as_os_str().to_os_string(),
        ),
        ("XDG_CACHE_HOME".into(), cache.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_CACHE".into(),
            cache.as_os_str().to_os_string(),
        ),
        ("TMPDIR".into(), temp.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_TMP".into(),
            temp.as_os_str().to_os_string(),
        ),
        ("PIP_CACHE_DIR".into(), pip_cache.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_PIP_CACHE".into(),
            pip_cache.as_os_str().to_os_string(),
        ),
        (
            "NPM_CONFIG_CACHE".into(),
            npm_cache.as_os_str().to_os_string(),
        ),
        (
            "KCODER_ISOLATED_NPM_CACHE".into(),
            npm_cache.as_os_str().to_os_string(),
        ),
        (
            "PYTHONPYCACHEPREFIX".into(),
            python_cache.as_os_str().to_os_string(),
        ),
        (
            "KCODER_ISOLATED_PYTHON_CACHE".into(),
            python_cache.as_os_str().to_os_string(),
        ),
        ("PYTHONNOUSERSITE".into(), "1".into()),
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ("PYTEST_ADDOPTS".into(), "-p no:cacheprovider".into()),
        (
            "KCODER_ISOLATED_PYTEST_ADDOPTS".into(),
            "-p no:cacheprovider".into(),
        ),
        ("PIP_REQUIRE_VIRTUALENV".into(), "1".into()),
        ("PIP_CONFIG_FILE".into(), null_config),
        (
            "CARGO_TARGET_DIR".into(),
            cargo_target.as_os_str().to_os_string(),
        ),
        ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
    ];
    if let Some(workspace_root) = workspace_root {
        let trusted_python_path = std::env::var_os("KCODER_VERIFIER_PYTHONPATH_PREFIX");
        let verifier_python_path =
            verifier_python_path(workspace_root, trusted_python_path.as_deref())?;
        environment.push(("PYTHONPATH".into(), verifier_python_path.clone()));
        environment.push(("KCODER_ISOLATED_PYTHONPATH".into(), verifier_python_path));
        environment.push((
            "KCODER_VERIFIER_WORKSPACE".into(),
            workspace_root.as_os_str().to_os_string(),
        ));
    }
    Ok(environment)
}

pub(super) fn verifier_isolation_workspace_directory(
    root: &Path,
    workspace_root: Option<&Path>,
) -> PathBuf {
    let namespace = workspace_root
        .map(|workspace| {
            let digest = format!(
                "{:x}",
                Sha256::digest(workspace.as_os_str().to_string_lossy().as_bytes())
            );
            digest[..16].to_string()
        })
        .unwrap_or_else(|| "default".to_string());
    root.join("workspaces").join(namespace)
}

pub(super) fn verifier_python_path(
    workspace_root: &Path,
    trusted_prefix: Option<&OsStr>,
) -> Result<OsString, ToolError> {
    let mut python_paths = vec![workspace_root.to_path_buf()];
    if let Some(trusted_prefix) = trusted_prefix {
        python_paths.extend(std::env::split_paths(trusted_prefix));
    }
    std::env::join_paths(python_paths).map_err(|error| {
        ToolError::Execution(format!(
            "failed to construct isolated verifier PYTHONPATH: {error}"
        ))
    })
}
