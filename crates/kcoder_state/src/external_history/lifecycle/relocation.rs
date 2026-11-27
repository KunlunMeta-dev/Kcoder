//! The existing lifecycle remains the sole owner of epochs, births and tombstones.
use super::*;
use crate::history_storage_relocation::graph::OwnerGraph;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(in crate::external_history) struct RelocationArchives {
    pub locations: BTreeMap<String, String>,
    pub requests: BTreeMap<String, (String, String, bool)>,
    pub retiring: BTreeSet<String>,
}

pub(in crate::external_history) fn collect(
    base: &PrivateDirectory,
    graph: &mut OwnerGraph,
) -> Result<Option<RelocationArchives>> {
    let mut observed = RelocationArchives::default();
    let catalog = match Catalog::open_readonly(base) {
        Ok(Some(catalog)) => catalog,
        Ok(None) => return Ok(Some(observed)),
        // Invalid business metadata stays opaque to relocation. It must not
        // acquire a new owner mapping or become readable by moving it.
        Err(error)
            if missing(&error)
                || error.is::<metadata_snapshot::InvalidDocument>()
                || matches!(
                    error.to_string().as_str(),
                    "external_history_lifecycle_wrong_scope"
                        | "external_history_lifecycle_invalid_metadata"
                        | "external_history_lifecycle_budget_exceeded"
                ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    for request in catalog.document.requests.values() {
        let archive = catalog
            .document
            .archives
            .get(&request.archive)
            .context("external_history_lifecycle_changed")?;
        observed.requests.insert(
            format!(
                "request-{}.json",
                crate::external_history::hash(request.operation.as_bytes())
            ),
            (
                request.archive.clone(),
                request.snapshot.clone(),
                !matches!(archive.phase, ArchivePhase::Reserved | ArchivePhase::Active),
            ),
        );
    }
    let root = vec!["external-history".into(), DIRECTORY.into()];
    let mut files = vec![DOCUMENT.to_owned()];
    for record in catalog.document.retirements.values() {
        if let Some(name) = &record.quarantine {
            observed
                .locations
                .insert(name.clone(), record.archive.clone());
        }
        if record.execution.is_some() {
            let stem = format!("retirement-{}", hash(&record.operation)?);
            files.push(format!("{stem}.execution.lock"));
            files.push(format!("{stem}.execution.birth"));
        }
    }
    graph.add_directory(root.clone(), &catalog.directory, files)?;
    for archive in catalog.document.archives.values() {
        if !matches!(archive.phase, ArchivePhase::Active | ArchivePhase::Reserved) {
            observed.retiring.insert(archive.id.clone());
        }
        if archive.directory.is_some() {
            observed
                .locations
                .insert(archive.id.clone(), archive.id.clone());
        }
        let control = catalog
            .directory
            .open_child(OsStr::new(&archive.id), false)?;
        let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
        header.validate()?;
        ensure!(
            header.scope == catalog.document.scope
                && header.archive == archive.id
                && header.generation == archive.generation
                && header.directory == archive.directory
                && header.lease == archive.lease
                && control.history_regular_matches(OsStr::new("lease.lock"), &header.lease)?,
            "external_history_lifecycle_changed"
        );
        let mut path = root.clone();
        path.push(archive.id.clone());
        graph.add(&path, &control, &["identity.json", "lease.lock"])?;
        let raw = match base.open_child(OsStr::new(&archive.id), false) {
            Ok(raw) => Some((archive.id.clone(), raw)),
            Err(error) if missing(&error) => {
                let name = catalog
                    .document
                    .retirements
                    .values()
                    .find(|record| record.archive == archive.id && record.quarantined)
                    .and_then(|record| record.quarantine.as_ref());
                match name {
                    Some(name) => match base.open_child(OsStr::new(name), false) {
                        Ok(raw) => Some((name.clone(), raw)),
                        Err(error) if missing(&error) => None,
                        Err(error) => return Err(error),
                    },
                    None => None,
                }
            }
            Err(error) => return Err(error),
        };
        if let Some((raw_name, raw)) = &raw {
            ensure!(
                archive.directory.as_deref().is_some_and(|recorded| raw
                    .history_matches_directory(recorded)
                    .unwrap_or(false)),
                "external_history_lifecycle_changed"
            );
            if let Some(baseline) = &archive.baseline {
                baseline.retain_relocation_facts(
                    raw,
                    &["external-history".into(), raw_name.clone()],
                    graph,
                )?;
            }
            for derived in archive.derived.values() {
                let name = match raw.open_child(OsStr::new(&derived.name), false) {
                    Ok(_) => &derived.name,
                    Err(error) if !derived.published && missing(&error) => &derived.staging,
                    Err(error)
                        if missing(&error)
                            && !matches!(
                                archive.phase,
                                ArchivePhase::Active | ArchivePhase::Reserved
                            ) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let child = raw.open_child(OsStr::new(name), false)?;
                ensure!(
                    child.history_matches_directory(&derived.directory)?,
                    "external_history_derived_changed"
                );
                let path = vec![
                    "external-history".to_owned(),
                    raw_name.clone(),
                    name.clone(),
                ];
                graph.add(
                    &path,
                    &child,
                    &[
                        "owner.json",
                        "setup.lock",
                        "build.lock",
                        "catalog.sqlite3",
                        "catalog.sqlite3-journal",
                        "schema-intent.json",
                        "schema-ready.json",
                    ],
                )?;
                if let Some(seal) = &derived.seal {
                    seal.retain_relocation_facts(&child, &path, graph)?;
                }
            }
        }
        if let Some(anchor) = &archive.payload_tree {
            let tree_name = match control.open_child(OsStr::new("payload-tree"), false) {
                Ok(_) => "payload-tree",
                Err(error) if !anchor.published && missing(&error) => &anchor.staging,
                Err(error) => return Err(error),
            };
            let tree = control.open_child(OsStr::new(tree_name), false)?;
            ensure!(
                tree.history_matches_directory(&anchor.directory)?
                    && tree.history_regular_matches(OsStr::new("tree.lock"), &anchor.lease)?,
                "external_history_payload_changed"
            );
            path.push(tree_name.into());
            payload::relocation::collect(
                &tree,
                &path,
                !matches!(archive.phase, ArchivePhase::Active | ArchivePhase::Reserved),
                raw.as_ref().map(|(name, directory)| {
                    (directory, vec!["external-history".into(), name.clone()])
                }),
                graph,
            )?;
            for retirement in catalog
                .document
                .retirements
                .values()
                .filter(|record| record.archive == archive.id)
            {
                for plan in retirement
                    .payload_plan
                    .iter()
                    .chain(&retirement.payload_previous)
                {
                    payload::collect_relocation_plan(
                        &tree,
                        &path,
                        &retirement.operation,
                        plan,
                        graph,
                    )?;
                }
            }
        }
    }
    Ok(Some(observed))
}
