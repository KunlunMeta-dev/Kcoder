//! Reject only current locators whose registered internal addresses would move.
//! Signed routes and user target configuration remain byte-for-byte unchanged.
use super::*;
use kcoder_workspace_resources::managed_worktrees::relocation::profile_relocation_reference_paths;

const LIMIT: u64 = 1024 * 1024;
const UNSUPPORTED: &str = "STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED";

fn optional_json(root: &PrivateDirectory, name: &str) -> Result<Option<Value>> {
    let mut file = match root.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let before = observed_file(&file)?;
    let mut bytes = Vec::new();
    (&mut file).take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "STORAGE_GATEWAY_REFERENCE_METADATA_TOO_LARGE"
    );
    ensure!(
        observed_file(&file)? == before
            && observed_file(&root.open_single_link_regular_file(OsStr::new(name))?)? == before,
        "STORAGE_GATEWAY_OWNER_CHANGED"
    );
    Ok(Some(
        serde_json::from_slice(&bytes).context("STORAGE_GATEWAY_REFERENCE_METADATA_INVALID")?,
    ))
}

fn path(value: &Value) -> Option<PathBuf> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn route_paths(route: &Value, paths: &mut BTreeSet<PathBuf>) {
    for key in ["workspacePath", "workspaceSelection"] {
        if let Some(path) = path(&route[key]) {
            paths.insert(path);
        }
    }
}

fn route_key<'a>(device: &'a Value, route: &'a Value) -> Option<(&'a str, &'a str, &'a str)> {
    Some((
        device["deviceId"].as_str()?,
        device["authorizationGeneration"].as_str()?,
        route["routeId"].as_str()?,
    ))
}

fn reference_file(path: &Path) -> Option<PortableLeaseIdentity> {
    let path = node_storage_path(path).ok()?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return None;
        };
        let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
            return None;
        };
        let drive = [u16::from(drive), b':' as u16, b'\\' as u16, 0];
        // SAFETY: drive is a live NUL-terminated three-character root.
        if !matches!(
            unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(drive.as_ptr()) },
            2 | 3 | 5 | 6
        ) {
            return None;
        }
    }
    let parent = PrivateDirectory::open_existing(path.parent()?).ok()?;
    let file = parent
        .open_single_link_regular_file(path.file_name()?)
        .ok()?;
    PortableLeaseIdentity::from_regular_handle(&file).ok()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn gateway_internal_settings_alias_requires_the_actual_complete_file_identity() -> Result<()> {
        let owned = tempfile::tempdir()?;
        let root = PrivateDirectory::open_existing(owned.path())?;
        root.atomic_replace(OsStr::new("Original Settings.json"), b"owned original")?;
        root.atomic_replace(OsStr::new("external.json"), b"owned external")?;
        let original = owned.path().join("Original Settings.json");
        let alias = owned.path().join("ORIGINAL SETTINGS.JSON");
        let mixed = PathBuf::from(format!(r"\\?\{}", original.display()).replacen(
            r"\Original Settings.json",
            "/Original Settings.json",
            1,
        ));
        let expected =
            reference_file(&original).context("owned local filesystem must expose complete IDs")?;
        ensure!(
            reference_file(&alias).as_ref() == Some(&expected),
            "owned fixture requires a case-insensitive directory"
        );
        ensure!(reference_file(&mixed).as_ref() == Some(&expected));
        ensure!(reference_file(&owned.path().join("external.json")).as_ref() != Some(&expected));
        ensure!(reference_file(&owned.path().join("missing.json")).is_none());
        // The prefix check must return before any UNC filesystem access.
        ensure!(reference_file(Path::new(r"\\not-a-host.invalid\share\settings.json")).is_none());
        Ok(())
    }
}

pub(super) fn check(plan: &StorageMigrationPlan, owner: &GatewayDomainsSource) -> Result<()> {
    let Some(gateway) = &owner.gateway else {
        return Ok(());
    };
    let mut workspaces = BTreeSet::new();
    let mut settings = BTreeSet::new();
    if let Some(servers) = optional_json(gateway, "servers.json")? {
        let servers = servers
            .as_array()
            .context("STORAGE_GATEWAY_REFERENCE_METADATA_INVALID")?;
        ensure!(
            servers.len() <= 32,
            "STORAGE_GATEWAY_REFERENCE_METADATA_INVALID"
        );
        for server in servers {
            if server["transport"] != "local" {
                continue;
            }
            if let Some(path) =
                path(&server["workspace"]).or_else(|| path(&server["workspacePath"]))
            {
                workspaces.insert(path);
            }
            if let Some(path) = path(&server["settingsFile"]) {
                settings.insert(path);
            }
        }
    }
    if let Some(mobile) = directory(gateway, Path::new("mobile-device-auth"))?
        && let Some(ledger) = optional_json(&mobile, "devices.json")?
    {
        let mut completed = BTreeSet::new();
        for fact in ledger["revocations"].as_array().into_iter().flatten() {
            for row in fact["routes"].as_array().into_iter().flatten() {
                if row["complete"] == true {
                    if let Some(key) = route_key(&fact["statement"], &row["route"]) {
                        completed.insert(key);
                    }
                } else if row["complete"] == false {
                    route_paths(&row["route"], &mut workspaces);
                }
            }
        }
        for row in ledger["retentionRoutes"].as_array().into_iter().flatten() {
            if route_key(row, &row["route"]).is_none_or(|key| !completed.contains(&key)) {
                route_paths(&row["route"], &mut workspaces);
            }
        }
    }
    // Only the existing Native/Gateway settings leaves have known ownership.
    // Other user overlays and fields resembling paths are never interpreted.
    for (source, target) in [
        (&plan.from.data_root, &plan.target.data_root),
        (
            &plan.from.gateway_root,
            &plan.target.data_root.join("studio/gateway"),
        ),
    ] {
        if settings.is_empty() {
            break;
        }
        if source == target {
            continue;
        }
        let file = source.join("settings.json");
        if let Some(known) = reference_file(&file) {
            for candidate in &settings {
                #[cfg(not(windows))]
                if candidate != &file {
                    continue;
                }
                if reference_file(candidate).is_some_and(|identity| identity == known) {
                    anyhow::bail!(UNSUPPORTED);
                }
            }
        }
    }
    let candidates = workspaces
        .iter()
        .cloned()
        .chain(
            settings
                .iter()
                .filter_map(|path| path.parent().map(Path::to_path_buf)),
        )
        .collect::<BTreeSet<_>>();
    if candidates.is_empty() || plan.from.data_root == plan.target.data_root {
        return Ok(());
    }
    ensure!(
        profile_relocation_reference_paths(
            &plan.from.data_root,
            &plan.target.data_root,
            &candidates
        )?
        .is_empty(),
        UNSUPPORTED
    );
    Ok(())
}
