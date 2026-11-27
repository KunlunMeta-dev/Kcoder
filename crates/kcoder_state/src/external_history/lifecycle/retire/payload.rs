//! Payload plans are immutable original-proof snapshots, with independently durable node progress.
use super::*;
use crate::external_history::lifecycle::payload::{self, PayloadCollection};
use std::cell::RefCell;
impl Collection {
    pub(super) fn prepare_payload(
        &mut self,
        raw: &PrivateDirectory,
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        let control = self
            .directory
            .open_child(OsStr::new(&self.archive.id), false)?;
        let archive = self.archive.clone();
        let scope = self.scope.clone();
        let mut error = None;
        let snapshot = payload::snapshot(&control, &archive, &scope, raw, &mut || match self
            .check(external, false)
        {
            Ok(()) => true,
            Err(value) => {
                error = Some(value);
                false
            }
        });
        if let Some(error) = error {
            return Err(error);
        }
        let Some(snapshot) = snapshot? else {
            return Ok(());
        };
        let current = self.catalogue()?.retirement(&self.operation)?.clone();
        let anchor = if let Some(anchor) = current
            .payload_plan
            .as_ref()
            .filter(|anchor| anchor.digest == snapshot.digest())
        {
            anchor.clone()
        } else {
            ensure!(
                current.tombstone.is_none()
                    && !current.quarantined
                    && current.removed.is_empty()
                    && current.pending.is_none()
                    && current.payload_removed_nodes == 0,
                "external_history_payload_plan_changed"
            );
            let reserved = current
                .payload_previous
                .iter()
                .map(|anchor| anchor.metadata_bytes)
                .sum::<u64>()
                + current
                    .payload_plan
                    .as_ref()
                    .map_or(0, |anchor| anchor.metadata_bytes);
            ensure!(
                current.payload_previous.len() < 16
                    && reserved
                        .checked_add(snapshot.metadata_bytes())
                        .is_some_and(|bytes| bytes <= 64 * 1024 * 1024),
                "external_history_payload_metadata_budget_exceeded"
            );
            let anchor = snapshot.reserve()?;
            let mut catalog = self.catalogue()?;
            let record = catalog
                .document
                .retirements
                .get_mut(&self.operation)
                .unwrap();
            if let Some(previous) = record.payload_plan.replace(anchor.clone()) {
                record.payload_previous.push(previous);
            }
            bump(record)?;
            catalog.save()?;
            anchor
        };
        let mut error = None;
        let operation = self.operation.clone();
        let published = snapshot.publish(&operation, &anchor, &mut || match self
            .check(external, false)
        {
            Ok(()) => true,
            Err(value) => {
                error = Some(value);
                false
            }
        });
        if let Some(error) = error {
            return Err(error);
        }
        self.payload = Some(published?);
        self.acknowledge_payload_plan()?;
        Ok(())
    }
    fn acknowledge_payload_plan(&self) -> Result<()> {
        let mut catalog = self.catalogue()?;
        let record = catalog
            .document
            .retirements
            .get_mut(&self.operation)
            .unwrap();
        if let Some(anchor) = &mut record.payload_plan
            && !anchor.published
        {
            anchor.published = true;
            bump(record)?;
            catalog.save()?;
        }
        Ok(())
    }
    pub(super) fn reopen_payload(&mut self) -> Result<()> {
        if self.payload.is_some() {
            return Ok(());
        }
        let record = self.catalogue()?.retirement(&self.operation)?.clone();
        if let Some(anchor) = &record.payload_plan {
            let control = self
                .directory
                .open_child(OsStr::new(&self.archive.id), false)?;
            self.payload = Some(payload::reopen(
                &control,
                &self.archive,
                &self.scope,
                &self.operation,
                anchor,
            )?);
            self.acknowledge_payload_plan()?;
        }
        Ok(())
    }
    pub(super) fn payload_roots(&self) -> Result<Vec<String>> {
        self.payload
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), PayloadCollection::roots)
    }
    pub(super) fn collect_payload(
        &mut self,
        raw: &PrivateDirectory,
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        let Some(payload) = self.payload.take() else {
            return Ok(());
        };
        let result = {
            let owner = RefCell::new(&mut *self);
            let failure = RefCell::new(None);
            let result = payload.collect(
                raw,
                &mut || match owner.borrow_mut().check(external, false) {
                    Ok(()) => true,
                    Err(error) => {
                        *failure.borrow_mut() = Some(error);
                        false
                    }
                },
                |bytes, nodes| {
                    let owner = owner.borrow();
                    let mut catalog = owner.catalogue()?;
                    let record = catalog
                        .document
                        .retirements
                        .get_mut(&owner.operation)
                        .unwrap();
                    let anchor = record
                        .payload_plan
                        .as_ref()
                        .context("external_history_payload_plan_changed")?;
                    ensure!(
                        nodes <= anchor.nodes
                            && bytes >= record.payload_removed_bytes
                            && nodes >= record.payload_removed_nodes,
                        "external_history_payload_progress_changed"
                    );
                    if bytes != record.payload_removed_bytes
                        || nodes != record.payload_removed_nodes
                    {
                        record.payload_removed_bytes = bytes;
                        record.payload_removed_nodes = nodes;
                        bump(record)?;
                        catalog.save()?;
                    }
                    Ok(())
                },
            );
            if let Some(error) = failure.into_inner() {
                Err(error)
            } else {
                result
            }
        };
        self.payload = Some(payload);
        result
    }
    pub(super) fn payload_complete(&self) -> Result<()> {
        let record = self.catalogue()?.retirement(&self.operation)?.clone();
        if let Some(anchor) = &record.payload_plan {
            let payload = self
                .payload
                .as_ref()
                .context("external_history_payload_plan_changed")?;
            let (bytes, nodes) = payload.observed_progress()?;
            ensure!(
                anchor.nodes == nodes
                    && record.payload_removed_nodes == nodes
                    && record.payload_removed_bytes == bytes,
                "external_history_payload_progress_changed"
            );
        }
        Ok(())
    }
}
