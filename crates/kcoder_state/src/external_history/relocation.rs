//! The immutable archive owner contributes only its named authority graph.
use super::*;
use crate::history_storage_relocation::graph::OwnerGraph;
use std::collections::BTreeSet;

pub(crate) fn collect(profile: &PrivateDirectory, graph: &mut OwnerGraph) -> Result<()> {
    let directory = match profile.open_child(OsStr::new("external-history"), false) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    directory.history_profile_seed(profile)?;
    let store = ExternalHistoryStore { directory };
    let base = vec!["external-history".to_owned()];
    let mut files = BTreeSet::from(["mutation.lock".to_owned()]);
    let Some(mut lifecycle) = lifecycle::relocation::collect(&store.directory, graph)? else {
        // Old job records still name this archive owner's original seed even
        // when its catalogue is damaged. Retain that one existing compatibility
        // fact and the real lock without adopting or repairing catalogue data.
        graph.add(&base, &store.directory, &["mutation.lock"])?;
        return Ok(());
    };
    store.directory.visit_entry_names_bounded(40_000, |name| {
        let Some(name) = name.to_str() else {
            return Ok(());
        };
        if valid_archive(name) {
            lifecycle
                .locations
                .entry(name.into())
                .or_insert(name.into());
        } else if name
            .strip_prefix("request-")
            .and_then(|name| name.strip_suffix(".json"))
            .is_some_and(valid_hash)
        {
            let request: Request = decode(
                &read_optional(&store.directory, name, METADATA_BYTES)?
                    .context("external_history_binding_missing")?,
            )?;
            ensure!(
                matches!(request.version, 1 | 2) && valid_archive(&request.archive_id),
                "HISTORY_RELOCATION_ARCHIVE_REQUEST_UNSUPPORTED"
            );
            let managed = lifecycle.requests.get(name);
            ensure!(
                request.version == 1
                    || managed.is_some_and(|(archive, snapshot, _)| *archive == request.archive_id
                        && *snapshot == request.snapshot_sha256),
                "external_history_operation_conflict"
            );
            let actual = match store
                .directory
                .open_child(OsStr::new(&request.archive_id), false)
            {
                Ok(actual) => (request.archive_id.clone(), actual),
                Err(error) if missing(&error) => {
                    if managed.is_some_and(|(_, _, retired)| *retired) {
                        files.insert(name.into());
                        return Ok(());
                    }
                    let staging = request
                        .staging_name
                        .as_deref()
                        .context("external_history_staging_missing")?;
                    let prefix = if request.version == 1 {
                        "staging-"
                    } else {
                        "staging-managed-"
                    };
                    ensure!(
                        staging
                            .strip_prefix(prefix)
                            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()),
                        "external_history_invalid_staging_identity"
                    );
                    (
                        staging.to_owned(),
                        store.directory.open_child(OsStr::new(staging), false)?,
                    )
                }
                Err(error) => return Err(error),
            };
            ensure!(
                actual
                    .1
                    .history_matches_directory(&request.directory_identity)?,
                "external_history_stored_content_changed"
            );
            lifecycle.locations.insert(actual.0, request.archive_id);
            files.insert(name.into());
        }
        Ok(())
    })?;
    graph.add_directory(base.clone(), &store.directory, files)?;
    for (name, archive_id) in lifecycle.locations {
        let raw = match store.directory.open_child(OsStr::new(&name), false) {
            Ok(raw) => raw,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        match read_optional(&raw, "binding.json", METADATA_BYTES)? {
            Some(bytes) => {
                let binding: Binding = decode(&bytes)?;
                validate_binding(&binding, &archive_id)?;
                let reader = ExternalHistoryReader {
                    directory: raw.duplicate_handle()?,
                    binding,
                    lifecycle: lifecycle::ArchiveReadGuard::legacy(),
                };
                if reader.receipt()?.is_some() {
                    reader.verify(&mut |_| true)?;
                }
            }
            None => ensure!(
                lifecycle.retiring.contains(&archive_id),
                "external_history_binding_missing"
            ),
        }
        let path = vec![base[0].clone(), name];
        graph.add(
            &path,
            &raw,
            &[
                "binding.json",
                "import.lock",
                "receipt.json",
                RAW,
                RAW_CHUNKS,
                INDEX,
                INDEX_CHUNKS,
                "original.bin",
                "original-chunks.bin",
                "original.json",
            ],
        )?;
        collect_archive_children(&raw, &path, graph)?;
    }
    collect_branches(&store, graph)?;
    Ok(())
}

fn collect_archive_children(
    raw: &PrivateDirectory,
    path: &[String],
    graph: &mut OwnerGraph,
) -> Result<()> {
    raw.visit_entry_names_bounded(20_000, |name| {
        let Some(name) = name.to_str() else {
            return Ok(());
        };
        if ["normalized-", "tool-links-"]
            .iter()
            .any(|prefix| name.strip_prefix(prefix).is_some_and(valid_hash))
        {
            let child = raw.open_child(OsStr::new(name), false)?;
            if read_optional(&child, "owner.json", 32 * 1024)?.is_none() {
                return Ok(());
            }
            let mut child_path = path.to_vec();
            child_path.push(name.into());
            collect_database(&child, &child_path, graph)?;
        } else if matches!(name, "attachments-v1" | "local-attachments-v1") {
            let parent = raw.open_child(OsStr::new(name), false)?;
            let mut parent_path = path.to_vec();
            parent_path.push(name.into());
            graph.add(&parent_path, &parent, &["budget.lock", "catalog.lock"])?;
            parent.visit_entry_names_bounded(14_100, |leaf| {
                let Some(id) = leaf.to_str() else {
                    return Ok(());
                };
                let attachment = name == "attachments-v1";
                if !(if attachment {
                    valid_hash(id)
                } else {
                    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
                }) {
                    return Ok(());
                }
                let child = parent.open_child(leaf, false)?;
                // A born payload without a final intent is contributed separately
                // by the original lifecycle ledger, never adopted from its name.
                let record = if attachment {
                    "binding.json"
                } else {
                    "intent.json"
                };
                if read_optional(&child, record, METADATA_BYTES)?.is_none() {
                    return Ok(());
                }
                let mut child_path = parent_path.clone();
                child_path.push(id.into());
                graph.add(
                    &child_path,
                    &child,
                    &[
                        "binding.json",
                        "intent.json",
                        "writer.lock",
                        "control.lock",
                        "payload.bin",
                        "receipt.json",
                        "control.json",
                        "state.json",
                        "source-reference.json",
                        "retired.json",
                    ],
                )?;
                Ok(())
            })?;
        }
        Ok(())
    })
}

fn collect_database(
    directory: &PrivateDirectory,
    path: &[String],
    graph: &mut OwnerGraph,
) -> Result<()> {
    if let Some(bytes) = read_optional(directory, "owner.json", 32 * 1024)? {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Owner {
            schema: u32,
            scope: String,
        }
        let owner: Owner = decode(&bytes)?;
        ensure!(
            owner.schema == 1,
            "HISTORY_RELOCATION_DATABASE_OWNER_UNSUPPORTED"
        );
        if let Some(opened) = crate::history_index::files::open_database_in(
            directory.duplicate_handle()?,
            &owner.scope,
            false,
            4 * 1024 * 1024 * 1024,
        )? {
            let integrity: String =
                opened
                    .connection
                    .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            ensure!(integrity == "ok", "HISTORY_RELOCATION_DATABASE_CORRUPT");
        }
    }
    graph.add(
        path,
        directory,
        &[
            "owner.json",
            "setup.lock",
            "build.lock",
            "catalog.sqlite3",
            "catalog.sqlite3-journal",
            "schema-intent.json",
            "schema-ready.json",
        ],
    )
}

fn collect_branches(store: &ExternalHistoryStore, graph: &mut OwnerGraph) -> Result<()> {
    let branches = match store.directory.open_child(OsStr::new("branches"), false) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    let base = vec!["external-history".into(), "branches".into()];
    graph.add(&base, &branches, &["catalog.lock"])?;
    branches.visit_entry_names_bounded(4100, |name| {
        let Some(id) = name
            .to_str()
            .filter(|name| name.strip_prefix("branch-").is_some_and(valid_hash))
        else {
            return Ok(());
        };
        let directory = branches.open_child(name, false)?;
        store.branch_binding(&directory, id)?;
        let mut path = base.clone();
        path.push(id.into());
        graph.add(
            &path,
            &directory,
            &[
                "binding.json",
                "build.lock",
                "lifecycle.lock",
                "control.lock",
                "cancel.json",
                "tools.cancel.json",
                "source-reference.json",
                "retired.json",
            ],
        )?;
        collect_database(&directory, &path, graph)?;
        if let Ok(links) = directory.open_child(OsStr::new("tool-links-v1"), false) {
            path.push("tool-links-v1".into());
            collect_database(&links, &path, graph)?;
        }
        Ok(())
    })
}
