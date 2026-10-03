use crate::matrix::{RequiredExecutable, Suite};
use std::path::{Path, PathBuf};

pub(super) fn prerequisites(root: &Path, suite: &Suite) -> Vec<String> {
    let mut reasons = Vec::new();
    if !suite.platforms.is_empty()
        && !suite
            .platforms
            .iter()
            .any(|platform| platform == std::env::consts::OS)
    {
        reasons.push(format!("平台 {} 不在允许列表", std::env::consts::OS));
    }
    for program in &suite.requires_commands {
        if !program_exists(program) {
            reasons.push(format!("找不到命令: {program}"));
        }
    }
    for path in &suite.requires_files {
        let requested = root.join(path);
        match requested.canonicalize() {
            Ok(resolved) if resolved.starts_with(root) && is_executable_file(&resolved) => {}
            Ok(_) => reasons.push(format!(
                "文件前置条件逃逸工作区、不是文件或不可执行: {}",
                path.display()
            )),
            Err(_) => reasons.push(format!("路径不存在: {}", path.display())),
        }
    }
    for name in &suite.requires_env {
        if std::env::var_os(name).is_none_or(|value| value.is_empty()) {
            reasons.push(format!("缺少环境变量: {name}"));
        }
    }
    for requirement in &suite.requires_executables {
        if let Err(reason) =
            resolve_required_executable(root, requirement, |name| std::env::var_os(name))
        {
            reasons.push(reason);
        }
    }
    for alternatives in &suite.requires_any_env {
        if !exactly_one_env_is_enabled(alternatives, |name| std::env::var_os(name)) {
            reasons.push(format!(
                "必须且只能将一个环境变量显式设为 1: {}",
                alternatives.join(" 或 ")
            ));
        }
    }
    reasons
}

pub(super) fn resolve_required_executable(
    root: &Path,
    requirement: &RequiredExecutable,
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> std::result::Result<PathBuf, String> {
    let value = lookup(&requirement.env)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少 executable 环境变量: {}", requirement.env))?;
    let configured = PathBuf::from(value);
    let requested = if configured.is_absolute() {
        configured
    } else {
        root.join(configured)
    };
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("解析工作区根目录失败: {error}"))?;
    let resolved = requested.canonicalize().map_err(|error| {
        format!(
            "executable 环境变量 {} 指向的路径不存在: {} ({error})",
            requirement.env,
            requested.display()
        )
    })?;
    if !requirement.allow_external && !resolved.starts_with(&canonical_root) {
        return Err(format!(
            "executable 环境变量 {} 不允许指向工作区外: {}",
            requirement.env,
            resolved.display()
        ));
    }
    if !is_executable_file(&resolved) {
        return Err(format!(
            "executable 环境变量 {} 必须指向 regular executable: {}",
            requirement.env,
            resolved.display()
        ));
    }
    Ok(resolved)
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub(super) fn exactly_one_env_is_enabled(
    alternatives: &[String],
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> bool {
    alternatives
        .iter()
        .filter(|name| lookup(name).is_some_and(|value| value == "1"))
        .take(2)
        .count()
        == 1
}

fn program_exists(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|directory| {
            let candidate = directory.join(program);
            candidate.is_file()
                || cfg!(windows)
                    && ["exe", "cmd", "bat"]
                        .iter()
                        .any(|ext| candidate.with_extension(ext).is_file())
        })
    })
}
