//! Profile-owned activation preferences, separate from installed skill content.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, ffi::OsStr, io::Read, path::Path};

const STATE: &str = "skill-activation.json";
const LOCK: &str = ".skill-activation.lock";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: u8,
    disabled: BTreeSet<String>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            disabled: BTreeSet::new(),
        }
    }
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
}

fn read(directory: &PrivateDirectory) -> Result<State> {
    let file = match directory.open_regular_file(OsStr::new(STATE)) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(State::default());
        }
        Err(error) => return Err(error).context("Skill activation settings are unavailable"),
    };
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "Skill activation settings exceed the size limit"
    );
    let state: State =
        serde_json::from_slice(&bytes).context("Skill activation settings are invalid")?;
    ensure!(
        state.version == 1
            && state.disabled.len() <= 4096
            && state.disabled.iter().all(|name| valid_name(name)),
        "Skill activation settings are invalid"
    );
    Ok(state)
}

/// A registry captures this snapshot when created; existing conversations keep
/// their skill snapshot rather than changing midway through a running turn.
pub fn disabled(profile: &Path) -> Result<BTreeSet<String>> {
    let directory = match PrivateDirectory::open_existing(profile) {
        Ok(directory) => directory,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(BTreeSet::new());
        }
        Err(error) => return Err(error).context("Skill activation profile is unavailable"),
    };
    Ok(read(&directory)?.disabled)
}

/// Names are the registry's authoritative resolved identities, including the
/// stable names of plugin prompts whose materialized paths change on reload.
/// The host must first authorize the name against its discovered catalog.
pub fn set_enabled(profile: &Path, name: &str, enabled: bool) -> Result<()> {
    ensure!(valid_name(name), "Invalid skill activation identity");
    let directory = PrivateDirectory::open_or_create(profile)?;
    let _lock = directory
        .try_exclusive_lock(OsStr::new(LOCK))?
        .context("Skill activation settings are busy; retry later")?;
    let mut state = read(&directory)?;
    if enabled {
        state.disabled.remove(name);
    } else {
        state.disabled.insert(name.to_owned());
    }
    ensure!(
        state.disabled.len() <= 4096,
        "Skill activation settings exceed the entry limit"
    );
    let bytes = serde_json::to_vec(&state)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "Skill activation settings exceed the size limit"
    );
    directory.atomic_replace(OsStr::new(STATE), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_is_profile_owned_persistent_and_preserves_other_names() -> Result<()> {
        let root = tempfile::tempdir()?;
        let first = root.path().join("account-one");
        let second = root.path().join("account-two");
        assert!(disabled(&first)?.is_empty());
        set_enabled(&first, "plugin:demo:market:command:review", false)?;
        set_enabled(&first, "local-skill", false)?;
        set_enabled(&first, "local-skill", true)?;
        assert_eq!(
            disabled(&first)?,
            BTreeSet::from(["plugin:demo:market:command:review".into()])
        );
        assert!(disabled(&second)?.is_empty());
        set_enabled(&second, "local-skill", false)?;
        assert!(!disabled(&first)?.contains("local-skill"));
        Ok(())
    }
    #[test]
    fn malformed_state_and_busy_writers_are_rejected_without_overwriting() -> Result<()> {
        let root = tempfile::tempdir()?;
        set_enabled(root.path(), "one", false)?;
        let directory = PrivateDirectory::open_existing(root.path())?;
        let lock = directory.try_exclusive_lock(OsStr::new(LOCK))?.unwrap();
        assert!(set_enabled(root.path(), "two", false).is_err());
        assert_eq!(disabled(root.path())?, BTreeSet::from(["one".into()]));
        drop(lock);
        directory.atomic_replace(OsStr::new(STATE), b"{invalid")?;
        assert!(disabled(root.path()).is_err());
        assert!(set_enabled(root.path(), "one", true).is_err());
        assert_eq!(std::fs::read(root.path().join(STATE))?, b"{invalid");
        Ok(())
    }
    #[cfg(unix)]
    #[test]
    fn activation_does_not_follow_a_state_symlink() -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        std::fs::create_dir(&profile)?;
        let outside = root.path().join("outside.json");
        std::fs::write(&outside, b"OUTSIDE")?;
        std::os::unix::fs::symlink(&outside, profile.join(STATE))?;
        assert!(disabled(&profile).is_err());
        assert!(set_enabled(&profile, "skill", false).is_err());
        assert_eq!(std::fs::read(&outside)?, b"OUTSIDE");
        Ok(())
    }
}
