//! Source-owner collection for history invalidation journals and deletion evidence.
use super::{graph::OwnerGraph, *};
use crate::history_index::{
    HistoryCatalog, TrackedHistoryCatalog, files,
    journal::{self, JournalDomain},
};
pub use crate::history_store::{RegisteredProfileSession, RegisteredProfileSessionState};

pub(super) fn collect(
    profile: &PrivateDirectory,
    profile_path: &Path,
    graph: &mut OwnerGraph,
) -> Result<()> {
    visit_roots(profile, profile_path, |directory, actual, path| {
        collect_root(directory, actual, path, graph)
    })
}

fn visit_roots(
    profile: &PrivateDirectory,
    profile_path: &Path,
    mut visit: impl FnMut(&PrivateDirectory, &Path, &[String]) -> Result<()>,
) -> Result<()> {
    let profile_path = dunce::canonicalize(profile_path)?;
    if let Some(history) = child(profile, "history")? {
        visit(&history, &profile_path.join("history"), &["history".into()])?;
    }
    let Some(projects) = child(profile, "projects")? else {
        return Ok(());
    };
    projects.visit_entry_names_bounded(MAX_DIRECTORIES, |name| {
        if !projects.entry_metadata(name)?.is_dir() {
            return Ok(());
        }
        let Some(name) = name.to_str() else {
            return Ok(());
        };
        let project = projects.open_child(OsStr::new(name), false)?;
        let path = vec!["projects".into(), name.into()];
        visit(&project, &profile_path.join("projects").join(name), &path)
    })?;
    Ok(())
}

/// Read only State's registered existing session directories. Legacy sources
/// require the normal strict decoder; ambiguous data is never reported as empty.
pub fn registered_profile_sessions(profile_path: &Path) -> Result<Vec<RegisteredProfileSession>> {
    let profile = PrivateDirectory::open_existing(profile_path)?;
    profile.verify_config_root_directory()?;
    let identity = profile.directory_identity()?;
    let mut sessions = Vec::new();
    visit_roots(&profile, profile_path, |directory, actual, _| {
        directory.history_profile_seed(&profile)?;
        sessions.extend(crate::history_store::registered_session_directories(
            directory, actual,
        )?);
        Ok(())
    })?;
    ensure!(
        PrivateDirectory::open_existing(profile_path)?.directory_identity()? == identity,
        "HISTORY_RELOCATION_PROFILE_CHANGED"
    );
    Ok(sessions)
}

fn child(directory: &PrivateDirectory, name: &str) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new(name), false) {
        Ok(child) => Ok(Some(child)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn collect_root(
    directory: &PrivateDirectory,
    actual: &Path,
    path: &[String],
    graph: &mut OwnerGraph,
) -> Result<()> {
    collect_journal(directory, actual, path, JournalDomain::History, graph)?;
    crate::history_store::collect_relocation_sources(directory, actual, path, graph)?;
    if let Some(client) = child(directory, "client-sessions")? {
        let client_path = actual.join("client-sessions");
        let mut client_relative = path.to_vec();
        client_relative.push("client-sessions".into());
        collect_journal(
            &client,
            &client_path,
            &client_relative,
            JournalDomain::ClientMetadata,
            graph,
        )?;
        collect_catalogs(&client, &client_path, actual, &client_relative, graph)?;
    }
    Ok(())
}

fn collect_journal(
    directory: &PrivateDirectory,
    actual: &Path,
    path: &[String],
    domain: JournalDomain,
    graph: &mut OwnerGraph,
) -> Result<()> {
    journal::verify_relocation_source(actual, domain)?;
    let (database, token, lock) = domain.names();
    let database = child(directory, database)?;
    let token_present = match directory.entry_metadata(OsStr::new(token)) {
        Ok(_) => true,
        Err(error) if missing(&error) => false,
        Err(error) => return Err(error),
    };
    if database.is_none() && !token_present {
        match directory.entry_metadata(OsStr::new(lock)) {
            Ok(_) => graph.add_runtime_lock(path, directory, lock)?,
            Err(error) if missing(&error) => (),
            Err(error) => return Err(error),
        }
        return Ok(());
    }
    graph.add(path, directory, &[token, lock])?;
    if let Some(database) = database {
        let mut relative = path.to_vec();
        relative.push(domain.names().0.into());
        graph.add(
            &relative,
            &database,
            &[
                "owner.json",
                "setup.lock",
                "catalog.sqlite3",
                "catalog.sqlite3-journal",
            ],
        )?;
    }
    Ok(())
}

fn collect_catalogs(
    client: &PrivateDirectory,
    actual: &Path,
    history: &Path,
    path: &[String],
    graph: &mut OwnerGraph,
) -> Result<()> {
    for name in ["history-index", "history-list-index"] {
        let Some(directory) = child(client, name)? else {
            continue;
        };
        let scope = files::relocation_owner_scope(&directory)?
            .context("HISTORY_RELOCATION_CATALOG_OWNER_MISSING")?;
        if name == "history-index" {
            let catalog = HistoryCatalog::open(actual, &scope, false)?
                .context("HISTORY_RELOCATION_CATALOG_MISSING")?;
            catalog.revision()?;
        } else {
            let value: serde_json::Value = serde_json::from_str(&scope)?;
            let values = value
                .as_array()
                .context("HISTORY_RELOCATION_CATALOG_SCOPE_INVALID")?;
            ensure!(
                values.len() == 4 && values[0] == "kcoder.tracked-list.v1",
                "HISTORY_RELOCATION_CATALOG_SCOPE_INVALID"
            );
            let workspace = values[1]
                .as_str()
                .context("HISTORY_RELOCATION_CATALOG_SCOPE_INVALID")?;
            let catalog = TrackedHistoryCatalog::open(actual, history, workspace, false)?
                .context("HISTORY_RELOCATION_CATALOG_MISSING")?;
            catalog.checkpoint()?;
            graph.add(path, client, &[])?;
            let mut history_relative = path.to_vec();
            history_relative.pop();
            graph.add(
                &history_relative,
                &PrivateDirectory::open_existing(history)?,
                &[],
            )?;
        }
        let mut relative = path.to_vec();
        relative.push(name.into());
        graph.add(
            &relative,
            &directory,
            &[
                "owner.json",
                "setup.lock",
                "catalog.sqlite3",
                "catalog.sqlite3-journal",
            ],
        )?;
    }
    Ok(())
}

pub(super) fn verify_target(
    target: &PrivateDirectory,
    held: &[super::HeldDirectory],
) -> Result<()> {
    for control in held {
        let path = &control.snapshot.path;
        let known = matches!(path.as_slice(), [root, _] if root == "history")
            || matches!(path.as_slice(), [root, _, _] if root == "projects");
        if !known
            || !control
                .snapshot
                .files
                .iter()
                .any(|file| file.name == "source.json" || file.name == crate::historical_undo::SEAL)
        {
            continue;
        }
        let Some(control_name) = path
            .last()
            .filter(|name| Path::new(name).extension() == Some(OsStr::new("hctl")))
        else {
            continue;
        };
        let parent_path = &path[..path.len() - 1];
        let source_parent = held
            .iter()
            .find(|entry| entry.snapshot.path.as_slice() == parent_path)
            .context("HISTORY_RELOCATION_SOURCE_MISSING")?;
        let target_parent = open_relative(target, parent_path)?;
        let target_control = open_relative(target, path)?;
        let name = Path::new(control_name).with_extension("jsonl");
        crate::history_store::verify_relocated_deletion(&target_parent, name.as_os_str())?;
        crate::historical_undo::verify_relocation_target(
            &source_parent.directory,
            &target_parent,
            &control.directory,
            &target_control,
            control.snapshot.files.iter().map(|file| file.name.as_str()),
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
