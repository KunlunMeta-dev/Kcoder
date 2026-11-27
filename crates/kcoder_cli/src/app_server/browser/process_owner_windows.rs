//! Preserve the existing supervised Chromium path, with original cleanup receipt mode.
use super::*;
use std::{fs::File, path::Path};

pub(super) fn spawn(
    chromium: &Path,
    args: &[String],
    receipt: Option<File>,
) -> Result<OwnedChromiumProcess> {
    let spec = SpawnSpec {
        executable: chromium.to_path_buf(),
        cwd: std::env::current_dir()?,
        args: args.iter().map(Into::into).collect(),
        env: std::env::vars_os().collect(),
    };
    let supervisor = locate_supervisor_or_sibling("KCODER_PROCESS_SUPERVISOR_BIN")?;
    let child = match receipt {
        Some(file) => SupervisedChild::spawn_with_cleanup_receipt(spec, &file, &supervisor),
        None => SupervisedChild::spawn(spec, &supervisor),
    }
    .context("failed to start headless Chromium through the original Windows owner")?;
    Ok(OwnedChromiumProcess::new(child))
}
