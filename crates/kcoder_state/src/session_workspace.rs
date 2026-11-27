//! Resolve recorded addresses only through the managed workspace owner's facts.
use crate::PreparedSessionResume;
use anyhow::Result;
use kcoder_config::{
    PrivateDirectory,
    workspace_identity::{WorkspaceAddressLookup, WorkspaceIdentity},
};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "session_workspace_tests.rs"]
mod tests;

/// A locator, not a workspace authorization. The caller still captures its
/// current Native/workspace owner after selecting this actual directory.
pub fn resolve_session_workspace(profile: &Path, recorded: &Path) -> Result<PathBuf> {
    if !recorded.is_absolute() {
        return Ok(recorded.to_owned());
    }
    let profile = PrivateDirectory::open_existing(profile)?;
    match WorkspaceIdentity::lookup(&profile, recorded)? {
        Some(
            WorkspaceAddressLookup::Current(location) | WorkspaceAddressLookup::Moved(location),
        ) => {
            location.verify(&profile)?;
            Ok(location.workspace_path().to_owned())
        }
        None => Ok(recorded.to_owned()),
    }
}

impl PreparedSessionResume {
    /// Re-anchor only formally relocated, host-owned workspace addresses in the
    /// prepared runtime state. The original sidecar, transcript and source stamp
    /// remain untouched until the existing resume transaction commits.
    pub fn resolve_workspace_addresses(&mut self, profile: &Path) -> Result<()> {
        let old_base = self.persisted_state.base_cwd.as_deref();
        let new_base = old_base
            .map(|path| resolve_session_workspace(profile, path))
            .transpose()?;
        let new_cwd = self
            .persisted_state
            .cwd
            .as_deref()
            .map(|cwd| -> Result<PathBuf> {
                if let (Some(old), Some(new)) = (old_base, new_base.as_deref())
                    && old != new
                    && let Ok(relative) = cwd.strip_prefix(old)
                {
                    anyhow::ensure!(
                        relative
                            .components()
                            .all(|part| matches!(part, std::path::Component::Normal(_))),
                        "SESSION_WORKSPACE_ADDRESS_INVALID"
                    );
                    let path = new.join(relative);
                    // A moved working subdirectory must be the real destination,
                    // never a link back to the retained source or another project.
                    PrivateDirectory::open_existing(&path)?;
                    return Ok(path);
                }
                resolve_session_workspace(profile, cwd)
            })
            .transpose()?;
        self.persisted_state.base_cwd = new_base;
        self.persisted_state.cwd = new_cwd;
        Ok(())
    }
}

impl crate::AppState {
    /// Restore using the caller's actual profile; the plain State API remains
    /// available to owners whose histories are independent of a Native profile.
    pub fn resume_from_history_at_profile(&self, profile: &Path, path: &Path) -> Result<usize> {
        let mut prepared = crate::prepare_session_resume(path)?;
        prepared.resolve_workspace_addresses(profile)?;
        self.apply_prepared_session_resume(prepared)
    }
}
