use crate::matrix::Suite;
use anyhow::Result;
use kcoder_test_harness::RunContext;
use std::fs;
use std::process::Command;

pub(super) fn configure_environment(
    command: &mut Command,
    context: &RunContext,
    suite: &Suite,
) -> Result<()> {
    const ALLOW: &[&str] = &[
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "CI",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
    ];
    for name in ALLOW {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let home = context.state_dir().join("home");
    fs::create_dir_all(&home)?;
    command.env("HOME", &home);
    command.env("USERPROFILE", &home);
    for name in &suite.pass_env {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    for (name, directory) in [("CARGO_HOME", ".cargo"), ("RUSTUP_HOME", ".rustup")] {
        if suite.pass_env.iter().any(|candidate| candidate == name)
            && let Some(candidate) = default_tool_home(name, directory)
        {
            command.env(name, candidate);
        }
    }
    if let Some((name, value)) =
        selected_credential_environment(suite, |name| std::env::var_os(name))?
    {
        command.env(name, value);
    }
    for (name, value) in &suite.env {
        command.env(name, value);
    }
    Ok(())
}

fn default_tool_home(name: &str, directory: &str) -> Option<std::path::PathBuf> {
    if std::env::var_os(name).is_some() {
        return None;
    }
    let candidate = std::path::PathBuf::from(std::env::var_os("HOME")?).join(directory);
    candidate.is_dir().then_some(candidate)
}

pub(super) fn selected_credential_environment(
    suite: &Suite,
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<Option<(String, std::ffi::OsString)>> {
    const CREDENTIAL_SELECTOR: &str = "KCODER_E2E_MODEL_CREDENTIAL_ENV";
    if !suite
        .pass_env
        .iter()
        .any(|name| name == CREDENTIAL_SELECTOR)
    {
        return Ok(None);
    }
    let Some(selected_name) = lookup(CREDENTIAL_SELECTOR) else {
        return Ok(None);
    };
    let selected_name = selected_name
        .into_string()
        .map_err(|_| anyhow::anyhow!("credential selector 不是有效 UTF-8"))?;
    anyhow::ensure!(
        valid_dynamic_env_name(&selected_name),
        "credential selector 包含无效环境变量名"
    );
    Ok(lookup(&selected_name).map(|value| (selected_name, value)))
}

fn valid_dynamic_env_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}
