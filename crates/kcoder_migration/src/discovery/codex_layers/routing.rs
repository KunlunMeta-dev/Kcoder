use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Marker {
    directory: PathBuf,
    identity: String,
    present: Vec<bool>,
}
pub(super) fn directory(path: &Path) -> Result<(PathBuf, String)> {
    ensure!(
        path.is_absolute()
            && path.components().all(|part| !matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
        "migration_unsafe_source_path"
    );
    let handle = PrivateDirectory::open_existing(path)?;
    handle.verify_trusted_config_directory()?;
    let canonical = path
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
    let identity = handle.directory_identity()?;
    ensure!(
        PrivateDirectory::open_existing(&canonical)?.directory_identity()? == identity,
        "migration_source_changed"
    );
    Ok((canonical, identity))
}
pub(super) fn names(source: Option<&SourceDocument>) -> Result<Vec<String>> {
    let Some(source) = source else {
        return Ok(vec![".git".into()]);
    };
    let table = merge::PrivateTable(
        toml::from_str(source.text())
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?,
    );
    let Some(markers) = table.0.get("project_root_markers") else {
        return Ok(vec![".git".into()]);
    };
    let values = markers
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("migration_codex_root_markers_unsupported"))?;
    ensure!(
        values.len() <= 3
            && values
                .iter()
                .all(|value| matches!(value.as_str(), Some(".git" | ".hg" | ".sl"))),
        "migration_codex_root_markers_unsupported"
    );
    Ok(values
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect())
}
fn marker(path: &Path, names: &[String]) -> Result<Marker> {
    let (directory, identity) = directory(path)?;
    let handle = PrivateDirectory::open_existing(&directory)?;
    let mut present = Vec::new();
    for name in names {
        match handle.entry_metadata(OsStr::new(name)) {
            Ok(metadata) => {
                ensure!(
                    !metadata.file_type().is_symlink(),
                    "migration_unsafe_source_path"
                );
                present.push(true);
            }
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                present.push(false)
            }
            Err(_) => anyhow::bail!("migration_source_unavailable"),
        }
    }
    Ok(Marker {
        directory,
        identity,
        present,
    })
}
pub(super) fn capture(
    root: &Path,
    cwd: &Path,
    names: &[String],
) -> Result<(Vec<Marker>, Vec<PathBuf>)> {
    ensure!(
        cwd.starts_with(root)
            && names.len() <= 3
            && names
                .iter()
                .all(|name| matches!(name.as_str(), ".git" | ".hg" | ".sl")),
        "migration_invalid_source_binding"
    );
    let mut current = cwd.to_owned();
    let mut markers = Vec::new();
    loop {
        ensure!(
            markers.len() < MAX_LAYERS,
            "migration_source_budget_exceeded"
        );
        let value = marker(&current, names)?;
        let found = names.is_empty() || value.present.iter().any(|present| *present);
        markers.push(value);
        if found {
            break;
        }
        ensure!(
            current != root && current.pop() && current.starts_with(root),
            "migration_codex_project_root_unconfirmed"
        );
    }
    let paths = markers
        .iter()
        .rev()
        .map(|value| value.directory.clone())
        .collect();
    Ok((markers, paths))
}
pub(super) fn validate(
    root: &Path,
    cwd: &Path,
    names: &[String],
    recorded: &[Marker],
) -> Result<Vec<PathBuf>> {
    let (current, paths) = capture(root, cwd, names)?;
    ensure!(current == recorded, "migration_source_changed");
    Ok(paths)
}

pub(super) fn check_source_trust(source: Option<&SourceDocument>, cwd: &Path) -> Result<()> {
    let Some(source) = source else {
        return Ok(());
    };
    let table = merge::PrivateTable(
        toml::from_str(source.text())
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?,
    );
    let Some(projects) = table.0.get("projects") else {
        return Ok(());
    };
    let projects = projects
        .as_table()
        .ok_or_else(|| anyhow::anyhow!("migration_codex_trust_unsupported"))?;
    ensure!(projects.len() <= 1024, "migration_source_budget_exceeded");
    for (name, project) in projects {
        let path = Path::new(name);
        ensure!(
            path.is_absolute()
                && path
                    .components()
                    .all(|part| !matches!(part, std::path::Component::ParentDir)),
            "migration_codex_trust_unsupported"
        );
        if trust_contains(path, cwd)? {
            let level = project.get("trust_level").and_then(toml::Value::as_str);
            ensure!(
                level != Some("untrusted"),
                "migration_codex_project_untrusted"
            );
            ensure!(
                level == Some("trusted"),
                "migration_codex_trust_unsupported"
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
fn trust_contains(path: &Path, cwd: &Path) -> Result<bool> {
    Ok(cwd.starts_with(path))
}
#[cfg(windows)]
fn trust_contains(path: &Path, cwd: &Path) -> Result<bool> {
    fn lexical(path: &Path) -> Result<PathBuf> {
        let text = path
            .to_str()
            .filter(|text| text.is_ascii())
            .ok_or_else(|| anyhow::anyhow!("migration_codex_trust_unsupported"))?;
        let normalized = text.to_ascii_lowercase();
        let text = normalized
            .strip_prefix(r"\\?\unc\")
            .map(|rest| format!(r"\\{rest}"))
            .unwrap_or_else(|| {
                normalized
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&normalized)
                    .to_owned()
            });
        Ok(PathBuf::from(text.to_ascii_lowercase()))
    }
    // Do not open paths named by an untrusted configuration outside the selected hierarchy.
    Ok(lexical(cwd)?.starts_with(lexical(path)?))
}

pub(super) fn check_cwd(markers: &[Marker], cwd: &Path, identity: &str) -> Result<()> {
    ensure!(
        markers
            .first()
            .is_some_and(|marker| marker.directory == cwd && marker.identity == identity),
        "migration_source_changed"
    );
    Ok(())
}
