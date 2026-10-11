//! Shell selection and invocation arguments, including pipefail and snapshot sourcing.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ShellInvocation {
    pub(super) program: String,
    pub(super) args: Vec<String>,
}

pub(super) fn shell_invocation(
    preferred_shell: &str,
    command: &str,
    load_snapshot: bool,
    isolate_environment: bool,
) -> ShellInvocation {
    let bash = if shell_supports_pipefail(preferred_shell) {
        Some(preferred_shell.to_string())
    } else if Path::new("/bin/bash").exists() {
        Some("/bin/bash".to_string())
    } else {
        None
    };

    if let Some(program) = bash {
        let mut shell_options = vec!["-o".into(), "pipefail".into()];
        if verification_like_command(command) {
            shell_options.extend(["-o".into(), "errexit".into()]);
        }
        if load_snapshot {
            let bootstrap = if isolate_environment {
                ". \"$KCODER_SHELL_SNAPSHOT\" >/dev/null 2>&1 || true\n\
                 export HOME=\"$KCODER_ISOLATED_HOME\"\n\
                 export XDG_CACHE_HOME=\"$KCODER_ISOLATED_CACHE\"\n\
                 export TMPDIR=\"$KCODER_ISOLATED_TMP\"\n\
                 export PIP_CACHE_DIR=\"$KCODER_ISOLATED_PIP_CACHE\"\n\
                 export NPM_CONFIG_CACHE=\"$KCODER_ISOLATED_NPM_CACHE\"\n\
                 export PYTHONPYCACHEPREFIX=\"$KCODER_ISOLATED_PYTHON_CACHE\"\n\
                 export PYTHONPATH=\"$KCODER_ISOLATED_PYTHONPATH\"\n\
                 export PYTEST_ADDOPTS=\"$KCODER_ISOLATED_PYTEST_ADDOPTS\"\n\
                 export PYTHONNOUSERSITE=1 PIP_REQUIRE_VIRTUALENV=1\n\
                 eval -- \"$1\""
            } else {
                ". \"$KCODER_SHELL_SNAPSHOT\" >/dev/null 2>&1 || true\neval -- \"$1\""
            };
            shell_options.extend([
                "-c".into(),
                bootstrap.into(),
                "kcoder-shell".into(),
                command.into(),
            ]);
            return ShellInvocation {
                program,
                args: shell_options,
            };
        }
        shell_options.extend(["-c".into(), command.into()]);
        return ShellInvocation {
            program,
            args: shell_options,
        };
    }

    ShellInvocation {
        program: preferred_shell.to_string(),
        args: vec!["-c".into(), command.into()],
    }
}

pub(super) fn default_bash_shell() -> String {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Ok(shell) = std::env::var("SHELL")
            && shell_supports_pipefail(&shell)
        {
            candidates.push(PathBuf::from(shell));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("Git/bin/bash.exe"));
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("Git/bin/bash.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Programs/Git/bin/bash.exe"));
        }
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return path.to_string_lossy().into_owned();
        }
        "bash.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

pub(super) fn shell_supports_pipefail(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.contains("bash"))
        .unwrap_or_else(|| shell.contains("bash"))
}
