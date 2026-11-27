//! Validate retained fixture history through public State recovery, in a private copy.
use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "replay evidence cannot contain symlinks"
    );
    if metadata.is_dir() {
        std::fs::create_dir(target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o700))?;
        }
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        ensure!(metadata.is_file(), "replay evidence must be regular files");
        std::fs::copy(source, target)?;
    }
    Ok(())
}
fn main() -> Result<()> {
    let path = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("history path required")?,
    );
    let prepared = kcoder_state::prepare_session_resume(&path)?;
    let cwd = prepared
        .persisted_base_cwd()
        .context("retained session has no cwd")?
        .to_owned();
    ensure!(cwd.is_dir(), "retained fixture workspace is missing");
    let entries = kcoder_state::load_transcript_history(&path)?;
    let sources = entries
        .iter()
        .flat_map(|entry| &entry.web_sources)
        .collect::<Vec<_>>();
    let temporary = tempfile::tempdir()?;
    let leaf = path.file_name().context("history leaf missing")?;
    let staged = temporary.path().join(leaf);
    for source in [
        path.clone(),
        path.with_extension("hctl"),
        path.with_extension(""),
    ] {
        copy_tree(
            &source,
            &temporary
                .path()
                .join(source.file_name().context("source leaf missing")?),
        )?;
    }
    let state = kcoder_state::AppState::new(&cwd);
    let applied = state.resume_from_history(&staged)?;
    let restored_ids = state
        .messages_with_web_sources()
        .into_iter()
        .flat_map(|(_, receipts)| receipts)
        .flat_map(|receipt| receipt.sources.into_iter().map(|source| source.source_id))
        .collect::<Vec<_>>();
    let expected = sources
        .iter()
        .flat_map(|receipt| {
            receipt
                .sources
                .iter()
                .map(|source| source.source_id.clone())
        })
        .collect::<Vec<_>>();
    ensure!(
        restored_ids == expected,
        "native source facts did not survive public State recovery"
    );
    println!(
        "{}",
        serde_json::json!({"prepared":true,"applied":true,"persistedCwd":cwd,"messages":applied,"sourceReceipts":sources.len(),"sourceIds":expected})
    );
    Ok(())
}
