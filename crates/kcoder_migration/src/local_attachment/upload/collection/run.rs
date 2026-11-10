use super::*;
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

fn bump_removed(record: &mut Record, plan: &Plan, name: &str) -> Result<()> {
    ensure!(
        record.pending.as_deref() == Some(name),
        "local_upload_collection_pending_changed"
    );
    let leaf = plan
        .leaves
        .iter()
        .find(|leaf| leaf.name == name)
        .context("local_upload_collection_plan_changed")?;
    if !record.removed.iter().any(|entry| entry == name) {
        record.removed.push(name.into());
        record.removed.sort();
        record.deleted_bytes = record
            .deleted_bytes
            .checked_add(leaf.proof.bytes)
            .context("local_upload_collection_budget_exceeded")?;
    }
    record.pending = None;
    Ok(())
}
impl Operation<'_> {
    fn run_collection_inner(&self, external: &mut impl FnMut(u64) -> bool) -> Result<()> {
        ensure!(
            self.directory.portable_retention_filesystem_supported()?,
            "local_upload_collection_unsupported"
        );
        let initial = self
            .collection_record()?
            .context("local_upload_collection_not_prepared")?;
        if self.completion(&initial)?.is_some() {
            self.edit_collection(|record| {
                record.stage = UploadCollectionStage::Collected;
                record.failure = None;
                Ok(())
            })?;
            return Ok(());
        }
        ensure!(
            initial.cancel_revision == initial.acknowledged,
            "local_upload_collection_cancelled"
        );
        self.check_sequence(initial.upload_sequence)?;
        let last = RefCell::new(Instant::now() - Duration::from_secs(1));
        let cancel = RefCell::new(None);
        let mut poll = |bytes| {
            if !external(bytes) {
                *cancel.borrow_mut() = Some(anyhow::anyhow!("local_upload_collection_cancelled"));
                return false;
            }
            if last.borrow().elapsed() < Duration::from_millis(250) {
                return true;
            }
            *last.borrow_mut() = Instant::now();
            let checked = (|| -> Result<()> {
                let record = self
                    .collection_record()?
                    .context("local_upload_collection_not_prepared")?;
                ensure!(
                    record.cancel_revision == record.acknowledged,
                    "local_upload_collection_cancelled"
                );
                Ok(())
            })();
            if let Err(error) = checked {
                *cancel.borrow_mut() = Some(error);
                return false;
            }
            true
        };
        let result = (|| -> Result<()> {
            self.edit_collection(|record| {
                record.stage = UploadCollectionStage::Collecting;
                record.failure = None;
                Ok(())
            })?;
            let record = self
                .collection_record()?
                .context("local_upload_collection_not_prepared")?;
            let plan = if record.plan.is_some() {
                match self.load_collection_plan(&record) {
                    Ok(plan) => plan,
                    Err(error)
                        if !record.tombstone
                            && (missing(&error)
                                || error.to_string() == "local_upload_collection_plan_missing") =>
                    {
                        let plan =
                            self.capture_collection_plan(record.upload_sequence, &mut poll)?;
                        ensure!(
                            record.plan.as_deref() == Some(hash(&plan)?.as_str()),
                            "local_upload_collection_plan_changed"
                        );
                        self.publish_collection_plan(&plan)?;
                        plan
                    }
                    Err(error) => return Err(error),
                }
            } else {
                let plan = self.capture_collection_plan(record.upload_sequence, &mut poll)?;
                let digest = hash(&plan)?;
                self.edit_collection(|record| {
                    ensure!(
                        !record.tombstone && record.plan.is_none(),
                        "local_upload_collection_plan_changed"
                    );
                    record.plan = Some(digest);
                    Ok(())
                })?;
                self.publish_collection_plan(&plan)?;
                plan
            };
            let local = HistoryLocalAttachments::open_existing(&self.store.root)?;
            let authorization = load::<Authorization>(&self.directory, "authorization.json")?;
            let manifest = self.manifest()?;
            {
                let polling = RefCell::new(&mut poll);
                let action = || -> Result<()> {
                    let mut record = self
                        .collection_record()?
                        .context("local_upload_collection_not_prepared")?;
                    if let Some(pending) = record.pending.clone() {
                        let (parent, leaf) = self.target_directory(&pending)?;
                        match parent.open_single_link_regular_file(OsStr::new(&leaf)) {
                            Err(error) if missing(&error) => {
                                record = self.edit_collection(|record| {
                                    bump_removed(record, &plan, &pending)
                                })?;
                            }
                            Err(error) => return Err(error),
                            Ok(_) => {}
                        }
                    }
                    self.verify_remaining_collection(&plan, &record, &mut |bytes| {
                        polling.borrow_mut()(bytes)
                    })?;
                    ensure!(
                        polling.borrow_mut()(record.deleted_bytes),
                        "local_upload_collection_cancelled"
                    );
                    if !record.tombstone {
                        let _control = self.control_lock()?;
                        self.check_sequence(record.upload_sequence)?;
                        self.edit_collection(|record| {
                            ensure!(
                                record.cancel_revision == record.acknowledged,
                                "local_upload_collection_cancelled"
                            );
                            record.tombstone = true;
                            Ok(())
                        })?;
                    }
                    for leaf in &plan.leaves {
                        let current = self
                            .collection_record()?
                            .context("local_upload_collection_not_prepared")?;
                        if current.removed.contains(&leaf.name) {
                            continue;
                        }
                        ensure!(
                            polling.borrow_mut()(current.deleted_bytes),
                            "local_upload_collection_cancelled"
                        );
                        let (parent, name) = self.target_directory(&leaf.name)?;
                        parent.portable_open_verified_regular(
                            OsStr::new(&name),
                            &leaf.proof.identity,
                        )?;
                        self.edit_collection(|record| {
                            ensure!(
                                record
                                    .pending
                                    .as_deref()
                                    .is_none_or(|name| name == leaf.name),
                                "local_upload_collection_pending_changed"
                            );
                            ensure!(
                                record.cancel_revision == record.acknowledged,
                                "local_upload_collection_cancelled"
                            );
                            record.pending = Some(leaf.name.clone());
                            Ok(())
                        })?;
                        let removed = parent.portable_remove_verified_regular_leaf(
                            OsStr::new(&name),
                            &leaf.proof.identity,
                        )?;
                        if removed
                            .removed
                            .iter()
                            .any(|removed| removed == OsStr::new(&name))
                        {
                            self.edit_collection(|record| bump_removed(record, &plan, &leaf.name))?;
                        }
                        if let Some(error) = removed.failure {
                            return Err(error);
                        }
                    }
                    let record = self
                        .collection_record()?
                        .context("local_upload_collection_not_prepared")?;
                    self.verify_remaining_collection(&plan, &record, &mut |bytes| {
                        polling.borrow_mut()(bytes)
                    })?;
                    self.publish_collection_completion(&record, &plan)?;
                    self.edit_collection(|record| {
                        record.stage = UploadCollectionStage::Collected;
                        record.failure = None;
                        Ok(())
                    })?;
                    Ok(())
                };
                if let Some(local) = local {
                    let binding =
                        crate::local_attachment::upload_dependency::UploadReleaseBinding {
                            key: &self.grant.operation_id,
                            selection: &self.grant.frozen.selection,
                            reference: &self.grant.frozen.reference,
                            info: &self.grant.frozen.info,
                            revision: &self.grant.frozen.revision,
                            selection_revision: authorization
                                .as_ref()
                                .map(|value| value.selection_revision.as_str()),
                            expected: manifest
                                .as_ref()
                                .map(|value| (value.bytes, value.sha256.as_str())),
                        };
                    local.with_upload_release_guard(
                        binding,
                        &mut |bytes| polling.borrow_mut()(bytes),
                        action,
                    )
                } else {
                    ensure!(
                        authorization.is_none(),
                        "local_upload_collection_local_dependency_unknown"
                    );
                    action()
                }
            }
        })();
        if let Some(error) = cancel.into_inner() {
            return Err(error);
        }
        result
    }
    fn publish_collection_plan(&self, plan: &Plan) -> Result<()> {
        let name = format!("collection-plan-{}.json", hash(plan)?);
        if let Some(existing) = read_json::<Plan>(&self.directory, &name, PLAN_BYTES)? {
            ensure!(
                hash(&existing)? == hash(plan)?,
                "local_upload_collection_plan_changed"
            );
            return Ok(());
        }
        let data = serde_json::to_vec(plan)?;
        ensure!(
            data.len() as u64 <= PLAN_BYTES,
            "local_upload_collection_metadata_budget"
        );
        self.directory.atomic_publish_from_reader(
            OsStr::new(&name),
            &mut Cursor::new(data),
            false,
            || Ok(None),
        )?;
        Ok(())
    }
    fn publish_collection_completion(&self, record: &Record, plan: &Plan) -> Result<()> {
        if self.completion(record)?.is_some() {
            return Ok(());
        }
        ensure!(
            record.completion.is_none()
                && record.pending.is_none()
                && record.removed.len() == plan.leaves.len(),
            "local_upload_collection_completion_unknown"
        );
        let completion = Completion {
            version: 1,
            binding: record.binding.clone(),
            collection_id: record.collection_id.clone(),
            plan: hash(plan)?,
            deleted_bytes: record.deleted_bytes,
            released_reservation_bytes: plan.reserved_bytes,
        };
        let bytes = serde_json::to_vec(&completion)?;
        self.directory.atomic_publish_observed_from_reader(
            OsStr::new("collection-complete.json"),
            &mut Cursor::new(bytes),
            false,
            || Ok(None),
            |file| {
                let identity = self.directory.portable_regular_handle_identity(file)?;
                self.edit_collection(|record| {
                    ensure!(
                        record.completion.is_none(),
                        "local_upload_collection_completion_unknown"
                    );
                    record.completion = Some(identity);
                    Ok(())
                })?;
                Ok(())
            },
        )?;
        Ok(())
    }
}
impl HistoryLocalAttachmentUploads {
    pub fn run_collection(
        &self,
        operation_id: &str,
        collection_id: &str,
        sequence: u64,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<UploadCollectionView> {
        let op = self.operation_inner(operation_id, true)?;
        let execution = op
            .collection_execution()?
            .context("local_upload_collection_busy")?;
        let record = op
            .collection_record()?
            .context("local_upload_collection_not_prepared")?;
        ensure!(
            record.collection_id == collection_id && record.sequence == sequence,
            "local_upload_collection_stale_sequence"
        );
        if record.stage != UploadCollectionStage::Collected
            && record.cancel_revision == record.acknowledged
            && let Err(error) = op.run_collection_inner(&mut check)
        {
            let cancelled = error.chain().any(|cause| {
                matches!(
                    cause.to_string().as_str(),
                    "local_upload_collection_cancelled" | "local_upload_cancelled"
                )
            });
            op.edit_collection(|record| {
                record.stage = if cancelled {
                    UploadCollectionStage::Cancelled
                } else if record.tombstone {
                    UploadCollectionStage::OutcomeUnknown
                } else {
                    UploadCollectionStage::Blocked
                };
                record.failure = Some(
                    if cancelled {
                        "local_upload_collection_cancelled"
                    } else if record.tombstone {
                        "local_upload_collection_outcome_unknown"
                    } else {
                        "local_upload_collection_blocked"
                    }
                    .into(),
                );
                Ok(())
            })?;
        }
        drop(execution);
        op.collection_view(
            &op.collection_record()?
                .context("local_upload_collection_not_prepared")?,
        )
    }
}
