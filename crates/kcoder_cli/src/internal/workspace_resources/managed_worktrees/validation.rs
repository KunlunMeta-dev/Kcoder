use anyhow::Result;

pub fn validate_thread_id(thread_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(thread_id) {
        anyhow::bail!("invalid thread id")
    }
    Ok(())
}

pub fn validate_worktree_id(worktree_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(worktree_id) {
        anyhow::bail!("invalid worktree id")
    }
    Ok(())
}

fn is_valid_external_artifact_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && !is_windows_reserved_basename(id)
}

pub fn is_windows_reserved_basename(value: &str) -> bool {
    let trimmed = value.trim_end_matches(['.', ' ']);
    let basename = trimmed.split('.').next().unwrap_or(trimmed);
    matches!(
        basename.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn valid_artifact_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
