//! Project storage stays bound to its original key when an owned worktree moves.
use super::*;
use crate::workspace_identity::{
    WorkspaceAddressLookup, WorkspaceAddressReader, WorkspaceIdentity, WorkspaceLocation,
};
use std::sync::Arc;

fn mapped_location(profile: &Path, cwd: &Path) -> Result<Option<WorkspaceLocation>> {
    anyhow::ensure!(profile.is_absolute(), "WORKSPACE_IDENTITY_PATH_INVALID");
    let address = recorded_address(cwd);
    if !address.is_absolute() {
        return Ok(None);
    }
    let profile = match PrivateDirectory::open_existing(profile) {
        Ok(profile) => profile,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    match WorkspaceIdentity::lookup(&profile, &address)? {
        Some(
            WorkspaceAddressLookup::Current(location) | WorkspaceAddressLookup::Moved(location),
        ) => {
            location.verify(&profile)?;
            Ok(Some(location))
        }
        None => Ok(None),
    }
}

fn recorded_address(cwd: &Path) -> PathBuf {
    // Absolute metadata addresses belong to the original receipt. Resolving an
    // old name through today's filesystem can select an unrelated replacement.
    if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        normalized_project_path(cwd)
    }
}

impl Settings {
    /// Write into the original project bundle after a formally owned relocation.
    /// This returns a storage path, never permission to run in the old workspace.
    /// A mapped write must name the actual current directory; recorded old
    /// addresses belong to the read locator APIs until the caller restores cwd.
    pub fn project_data_dir_at(profile: &Path, cwd: impl AsRef<Path>) -> Result<PathBuf> {
        let cwd = cwd.as_ref();
        let mut location = mapped_location(profile, cwd)?;
        let actual = normalized_project_path(cwd);
        if location.is_none() && actual != cwd {
            location = mapped_location(profile, &actual)?;
        }
        if let Some(location) = &location {
            let directory = PrivateDirectory::open_existing(&actual)
                .context("WORKSPACE_IDENTITY_WRITE_DIRECTORY_CHANGED")?;
            anyhow::ensure!(
                directory.directory_identity()? == location.directory_identity(),
                "WORKSPACE_IDENTITY_WRITE_DIRECTORY_CHANGED"
            );
            location.verify(&PrivateDirectory::open_existing(profile)?)?;
        }
        let key = location.as_ref().map_or_else(
            || project_key_for_normalized_path(&actual),
            |location| location.project_storage_key().to_owned(),
        );
        Ok(profile.join("projects").join(key))
    }

    /// Project-scoped transcript directory for a working tree.
    ///
    /// The directory contains `<session>.jsonl` transcripts plus
    /// `<session>/...` session-scoped state such as session-memory summaries.
    pub fn project_data_dir(cwd: impl AsRef<Path>) -> Result<PathBuf> {
        Self::project_data_dir_at(&Self::config_dir()?, cwd)
    }

    /// Project directories that readers should search, newest format first.
    ///
    /// Windows builds before the user-facing canonicalization fix persisted
    /// escaped keys derived from `\\?\` paths. Keep that directory as a
    /// compatibility candidate alongside the older underscore-based format.
    pub fn project_data_dirs_for_read(cwd: impl AsRef<Path>) -> Result<Vec<PathBuf>> {
        Self::project_data_dirs_for_read_at(&Self::config_dir()?, cwd)
    }

    /// Read candidates anchored to the caller's already selected profile.
    pub fn project_data_dirs_for_read_at(
        profile: &Path,
        cwd: impl AsRef<Path>,
    ) -> Result<Vec<PathBuf>> {
        let cwd = cwd.as_ref();
        let location = mapped_location(profile, cwd)?;
        read_candidates(profile, cwd, location.as_ref())
    }

    /// Reuse one held address observation for a bounded metadata page.
    pub fn project_data_dirs_for_read_observed(
        profile: &Path,
        addresses: &Arc<WorkspaceAddressReader>,
        cwd: &Path,
    ) -> Result<Vec<PathBuf>> {
        anyhow::ensure!(profile.is_absolute(), "WORKSPACE_IDENTITY_PATH_INVALID");
        let held = PrivateDirectory::open_existing(profile)?;
        let address = recorded_address(cwd);
        let location = if address.is_absolute() {
            addresses
                .lookup(&held, &address)?
                .map(|location| match location {
                    WorkspaceAddressLookup::Current(location)
                    | WorkspaceAddressLookup::Moved(location) => location,
                })
        } else {
            None
        };
        let result = read_candidates(profile, cwd, location.as_ref())?;
        addresses.verify(&held)?;
        Ok(result)
    }

    /// Legacy project directory used by older KCoder builds.
    ///
    /// New sessions must use `project_data_dir`; readers use this only as a
    /// compatibility fallback while old `_path_style` transcripts remain.
    pub fn legacy_project_data_dir(cwd: impl AsRef<Path>) -> Result<PathBuf> {
        let profile = Self::config_dir()?;
        let location = mapped_location(&profile, cwd.as_ref())?;
        let key = location.as_ref().map_or_else(
            || legacy_project_key_for_path(cwd.as_ref()),
            |location| recorded_compatibility_keys(location.storage_workspace_path()).1,
        );
        Ok(profile.join("projects").join(key))
    }
}

fn read_candidates(
    profile: &Path,
    cwd: &Path,
    location: Option<&WorkspaceLocation>,
) -> Result<Vec<PathBuf>> {
    let (previous_key, legacy_key) = location.map_or_else(
        || {
            (
                previous_project_key_for_path(cwd),
                legacy_project_key_for_path(cwd),
            )
        },
        |location| recorded_compatibility_keys(location.storage_workspace_path()),
    );
    let projects = profile.join("projects");
    let mut dirs = Vec::new();
    for key in [
        location.map_or_else(
            || project_key_for_path(cwd),
            |location| location.project_storage_key().to_owned(),
        ),
        previous_key,
    ] {
        // Older unbounded keys can exceed the filesystem's component limit.
        // Such a directory could never have been created on this platform;
        // probing it turns an absent compatibility path into ENAMETOOLONG
        // and incorrectly marks otherwise healthy session lists incomplete.
        #[cfg(windows)]
        let component_length = key.encode_utf16().count();
        #[cfg(not(windows))]
        let component_length = key.len();
        if component_length > 255 {
            continue;
        }
        let dir = projects.join(key);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if project_key_component_is_supported(&legacy_key) {
        let dir = projects.join(legacy_key);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if let Some(location) = location {
        location.verify(&PrivateDirectory::open_existing(profile)?)?;
    }
    Ok(dirs)
}

fn recorded_compatibility_keys(cwd: &Path) -> (String, String) {
    #[cfg(windows)]
    let historical = historical_windows_path(cwd);
    #[cfg(not(windows))]
    let historical = cwd.to_path_buf();
    compatibility_keys_for_recorded_path(&historical)
}

fn compatibility_keys_for_recorded_path(path: &Path) -> (String, String) {
    // Apply the existing encodings to the recorded canonical address itself.
    // These older read candidates must not depend on the old name still existing.
    (
        project_key_for_normalized_path(path),
        path.to_string_lossy().replace(['/', '\\', ':', ' '], "_"),
    )
}

#[cfg(any(windows, test))]
fn historical_windows_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw.starts_with(r"\\?\") {
        return path.to_path_buf();
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return PathBuf::from(format!(r"\\?\{raw}"));
    }
    if let Some(tail) = raw.strip_prefix(r"\\") {
        let mut parts = tail.split('\\');
        if parts
            .next()
            .is_some_and(|server| !server.is_empty() && server != ".")
            && parts.next().is_some_and(|share| !share.is_empty())
        {
            return PathBuf::from(format!(r"\\?\UNC\{tail}"));
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_windows_compatibility_keys_are_pure_for_missing_drive_and_unc_addresses() {
        for (recorded, historical, previous, legacy) in [
            (
                r"C:\gone\project space",
                r"\\?\C:\gone\project space",
                "----C--gone-project-space",
                "__?_C__gone_project_space",
            ),
            (
                r"\\server\share\gone",
                r"\\?\UNC\server\share\gone",
                "----UNC-server-share-gone",
                "__?_UNC_server_share_gone",
            ),
            (
                r"\\?\C:\gone\project space",
                r"\\?\C:\gone\project space",
                "----C--gone-project-space",
                "__?_C__gone_project_space",
            ),
            (
                r"\\?\UNC\server\share\gone",
                r"\\?\UNC\server\share\gone",
                "----UNC-server-share-gone",
                "__?_UNC_server_share_gone",
            ),
        ] {
            let path = historical_windows_path(Path::new(recorded));
            assert_eq!(path, Path::new(historical));
            assert_eq!(
                compatibility_keys_for_recorded_path(&path),
                (previous.to_owned(), legacy.to_owned())
            );
        }
        assert_eq!(
            historical_windows_path(Path::new("/ordinary/unix/address")),
            Path::new("/ordinary/unix/address")
        );
        assert_eq!(
            historical_windows_path(Path::new(r"\\.\device")),
            Path::new(r"\\.\device")
        );
    }
}
