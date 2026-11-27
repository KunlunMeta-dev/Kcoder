//! Catalog intent is atomic for the entire original member set, before any claim.
use super::super::preparation::PreparationIntent;
use super::*;

impl Operation {
    pub(in crate::source_transfer::private_credentials) fn preparation(
        &self,
        job: &str,
    ) -> Result<Option<PreparationIntent>> {
        let _lease = self
            .root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &self.catalog_lock,
                PrivateLeaseMode::Shared,
            )?
            .context("private_credentials_busy")?;
        let catalog: Catalog = ordinary::load(&self.root, "catalog.json")?
            .context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        Ok(catalog.preparations.get(job).cloned())
    }
    pub(in crate::source_transfer::private_credentials) fn reserve_preparation(
        &self,
        intent: &PreparationIntent,
    ) -> Result<()> {
        ensure!(self.writer.is_some(), "private_credentials_busy");
        intent.validate()?;
        let _lease = self
            .root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &self.catalog_lock,
                PrivateLeaseMode::Exclusive,
            )?
            .context("private_credentials_busy")?;
        let mut catalog: Catalog = ordinary::load(&self.root, "catalog.json")?
            .context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        if let Some(saved) = catalog.preparations.get(&intent.job_id) {
            ensure!(
                saved == intent,
                "private_credentials_publication_binding_changed"
            );
            return Ok(());
        }
        ensure!(
            catalog.preparations.len() < 256,
            "private_credentials_operation_limit"
        );
        // Every member must already be an original target operation in this
        // exact native namespace; UUIDs alone are never reservation authority.
        for member in &intent.members {
            let context = member.context();
            let record = catalog
                .operations
                .get(&format!("target-{}", member.offer_id()))
                .and_then(Option::as_ref)
                .context("private_credentials_owner_unknown")?;
            ensure!(
                record.anchor.owner == self.anchor.owner
                    && record.parent_request == context.request_id
                    && record.anchor.binding
                        == super::super::target::ordinary_context_digest(context)?,
                "private_credentials_publication_binding_changed"
            );
        }
        catalog
            .preparations
            .insert(intent.job_id.clone(), intent.clone());
        ensure!(
            serde_json::to_vec(&catalog)?.len() as u64
                <= super::super::super::model::MAX_METADATA_BYTES,
            "private_credentials_budget_exceeded"
        );
        ordinary::save(&self.root, "catalog.json", &catalog)
    }
    pub(in crate::source_transfer::private_credentials) fn reserved_for_preparation(
        &self,
    ) -> Result<bool> {
        let _lease = self
            .root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &self.catalog_lock,
                PrivateLeaseMode::Shared,
            )?
            .context("private_credentials_busy")?;
        let catalog: Catalog = ordinary::load(&self.root, "catalog.json")?
            .context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        Ok(catalog.preparations.values().any(|intent| {
            intent
                .members
                .iter()
                .any(|member| self.name == format!("target-{}", member.offer_id()))
        }))
    }
}

pub(in crate::source_transfer::private_credentials) fn preparation_for_job(
    store: &Store,
    job: &str,
) -> Result<Option<PreparationIntent>> {
    let (root, identity) = store.private_credential_root(false)?;
    let _lease = root
        .try_existing_portable_lock(
            OsStr::new("catalog.lock"),
            &identity,
            PrivateLeaseMode::Shared,
        )?
        .context("private_credentials_busy")?;
    let catalog: Catalog =
        ordinary::load(&root, "catalog.json")?.context("private_credentials_owner_unknown")?;
    validate_catalog(&catalog)?;
    Ok(catalog.preparations.get(job).cloned())
}

/// A legacy claim without a complete intent is never authoritative absence.
pub(in crate::source_transfer::private_credentials) fn legacy_publication_for_job(
    store: &Store,
    job: &str,
) -> Result<bool> {
    let (root, identity) = store.private_credential_root(false)?;
    let entries = {
        let _lease = root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &identity,
                PrivateLeaseMode::Shared,
            )?
            .context("private_credentials_busy")?;
        let catalog: Catalog =
            ordinary::load(&root, "catalog.json")?.context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        catalog
            .operations
            .into_iter()
            .filter_map(|(name, record)| {
                record
                    .filter(|record| record.milestones.get("publication_started") == Some(&true))
                    .filter(|_| name.starts_with("target-"))
                    .map(|record| (name, record))
            })
            .collect::<Vec<_>>()
    };
    for (name, record) in entries {
        let offer = name.strip_prefix("target-").unwrap();
        let operation = controller_by_id(store, "target", &record.parent_request, offer)?;
        // A started but missing receipt cannot be assigned to an unrelated job,
        // so it is unknown rather than proof of no preparation for this job.
        let claim: super::super::PublicationClaim =
            match json(&operation.directory, "publication.json") {
                Ok(value) => value,
                Err(_) => return Ok(true),
            };
        if claim.job_id == job {
            return Ok(true);
        }
    }
    Ok(false)
}
