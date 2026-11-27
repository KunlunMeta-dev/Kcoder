//! Read-only admission for explicit profiles. Selection resolution stays independent.
use super::{control::read_storage_migration, writers::RootLease};
use crate::PrivateDirectory;
use anyhow::{Result, ensure};
use kcoder_types::StorageMigrationDisposition;
use std::{collections::BTreeSet, path::Path};

/// Called after all lifetime writer registrations and before any business owner.
/// Unknown global operation metadata fails closed even for an explicit profile;
/// a valid operation outside these roots leaves that profile unchanged.
pub(super) fn assert_active_operation_outside_roots(
    home: &Path,
    own_roots: &[&Path],
    held: &[RootLease],
) -> Result<()> {
    let Some(receipt) = read_storage_migration(home)? else {
        return match PrivateDirectory::open_existing(
            &home.join(".config/kcoder-storage-migrations"),
        ) {
            Ok(_) => anyhow::bail!("STORAGE_OPERATION_MISSING"),
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                Ok(())
            }
            Err(error) => Err(error.context("STORAGE_CONTROL_INVALID")),
        };
    };
    if receipt.disposition != StorageMigrationDisposition::Active {
        return Ok(());
    }
    let plan = &receipt.plan;
    let published = super::component_publication::active_component_directory_scopes(&receipt)?;
    let mut scopes = BTreeSet::new();
    for path in [
        &plan.from.data_root,
        &plan.from.cache_root,
        &plan.from.gateway_root,
        &plan.from.desktop_root,
        &plan.target.data_root,
        &plan.target.cache_root,
    ]
    .into_iter()
    .chain(
        plan.components
            .iter()
            .flat_map(|part| [&part.source, &part.destination]),
    )
    .chain(published.keys())
    {
        scopes.insert(super::resolve::absolute(path)?);
    }
    let own_paths = own_roots
        .iter()
        .map(|path| super::resolve::absolute(path))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !own_paths.iter().any(|own| scopes
            .iter()
            .any(|scope| own.starts_with(scope) || scope.starts_with(own))),
        "STORAGE_MIGRATION_PENDING"
    );

    let mut own_identities = BTreeSet::new();
    let mut own_ancestors = BTreeSet::new();
    for path in own_roots {
        let identity = PrivateDirectory::open_existing(path)?.directory_identity()?;
        let mut found = false;
        for lease in held {
            if lease.matches_directory(&identity)? {
                let (actual, ancestors) = lease.scope_identities()?;
                ensure!(actual == identity, "STORAGE_ROOT_CHANGED");
                own_identities.insert(actual);
                own_ancestors.extend(ancestors);
                found = true;
                break;
            }
        }
        ensure!(found, "STORAGE_ROOT_CHANGED");
    }
    let mut frozen = plan
        .components
        .iter()
        .map(|part| part.source_identity.clone())
        .chain(published.into_values())
        .collect::<BTreeSet<_>>();
    for binding in &plan.target_bindings {
        if super::resolve::absolute(&binding.path)?
            == super::resolve::absolute(&binding.existing_ancestor)?
        {
            frozen.insert(binding.ancestor_identity.clone());
        }
    }
    ensure!(
        frozen.is_disjoint(&own_ancestors),
        "STORAGE_MIGRATION_PENDING"
    );
    for scope in scopes {
        if let Some(probe) = RootLease::existing_identity_probe(&scope)? {
            let (identity, ancestors) = probe.scope_identities()?;
            ensure!(
                !own_ancestors.contains(&identity) && own_identities.is_disjoint(&ancestors),
                "STORAGE_MIGRATION_PENDING"
            );
        }
    }
    for lease in held {
        lease.verify()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "active_operation_tests.rs"]
mod tests;
