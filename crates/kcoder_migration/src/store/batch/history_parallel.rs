//! Independent history children share bounded IO lanes; their parent journal has one writer.
use super::*;
use crate::history_jobs::{HistoryImportEvent, HistoryJobStore};
use std::{
    ops::Range,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::mpsc,
};

const HISTORY_LANES: usize = crate::history_jobs::HISTORY_IMPORT_CONCURRENCY;
struct Work {
    index: usize,
    job: MigrationJob,
    action: BatchAction,
    plan: crate::batch::history::HistoryBatchAction,
    prepared: Option<history::PreparedHistoryExecution>,
}
enum Event {
    Progress {
        action_id: String,
        event: HistoryImportEvent,
        respond: mpsc::SyncSender<bool>,
    },
    Finished {
        work: Box<Work>,
        outcome: Result<crate::providers::ProviderPublication>,
    },
}

impl MigrationStore {
    fn admit_history_lane(&self, job_id: &str, index: usize) -> Result<Option<Work>> {
        let _lock = self.batch_write_lock()?;
        let mut job = self.load(job_id)?;
        if job.status != JobStatus::Applying {
            return Ok(None);
        }
        let action = job.batch.as_ref().unwrap().actions[index].clone();
        if matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped) {
            return Ok(None);
        }
        let BatchActionKind::History { plan } = &action.action else {
            anyhow::bail!("migration_invalid_journal")
        };
        let plan = plan.clone();
        let blocked = action.item_ids.iter().any(|id| {
            job.inventory
                .items
                .iter()
                .find(|item| &item.preview.id == id)
                .is_none_or(|item| {
                    job.batch
                        .as_ref()
                        .unwrap()
                        .source_for(id)
                        .map_or(true, |source| !source.unchanged(item))
                })
        });
        if blocked
            && !matches!(
                action.status,
                ItemStatus::Committing | ItemStatus::CommitUnknown
            )
        {
            set_action(
                &mut job,
                index,
                ItemStatus::Failed,
                Some("migration_source_changed".into()),
            );
            bump(&mut job)?;
            self.save(&job)?;
            return Ok(None);
        }
        set_action(&mut job, index, ItemStatus::Committing, None);
        bump(&mut job)?;
        self.save(&job)?;
        Ok(Some(Work {
            index,
            job,
            action,
            plan,
            prepared: None,
        }))
    }

    fn commit_history_lane(
        &self,
        work: &Work,
        outcome: Result<crate::providers::ProviderPublication>,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        #[cfg(test)]
        if outcome.is_ok() && FAIL_AFTER_PUBLICATION.with(|fail| fail.replace(false)) {
            anyhow::bail!("migration_injected_lost_batch_receipt");
        }
        let _lock = self.batch_write_lock()?;
        let mut current = self.load(&work.job.job_id)?;
        match outcome {
            Ok(publication) => {
                current.receipts.push(ItemCommitReceipt {
                    item_id: work.action.item_ids[0].clone(),
                    operation_id: work.action.action_id.clone(),
                    target_id: publication.target_id,
                    target_revision: publication.target_revision,
                    ownership_confirmed: publication.ownership_confirmed,
                });
                self.record_history_diagnostics(&mut current, &work.action, targets)?;
                set_action(&mut current, work.index, ItemStatus::Committed, None);
            }
            Err(error) => {
                let mut code = safe_code(&error);
                if code == "migration_operation_unconfirmed"
                    && let Some(cause) = error.chain().find_map(|cause| {
                        let value = cause.to_string();
                        ((value.starts_with("history_") || value.starts_with("external_history_"))
                            && value.len() < 110
                            && value
                                .bytes()
                                .all(|byte| byte.is_ascii_lowercase() || byte == b'_'))
                        .then_some(value)
                    })
                {
                    code = format!("migration_{cause}");
                }
                let status = if code == "migration_history_resource_admission_failed" {
                    ItemStatus::Failed
                } else {
                    ItemStatus::CommitUnknown
                };
                set_action(&mut current, work.index, status, Some(code));
            }
        }
        bump(&mut current)?;
        self.save(&current)
    }

    pub(super) fn run_parallel_history(
        &self,
        job_id: &str,
        range: Range<usize>,
        targets: &BatchTargets<'_>,
        resuming: bool,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<()> {
        let history: &HistoryJobStore = targets
            .history
            .context("migration_history_target_required")?;
        history.verify_batch_parent(&self.directory)?;
        self.prepare_history_resources(&self.read(job_id)?, history)?;
        let total = self.read(job_id)?.batch.as_ref().unwrap().actions.len();
        let (send, receive) = mpsc::channel::<Event>();
        let mut next = range.start;
        let mut active = 0;
        let mut stopped = false;
        let mut failure = None;
        let mut finished = Vec::new();
        std::thread::scope(|scope| {
            while active > 0 || next < range.end && !stopped {
                let mut staged = Vec::new();
                // No parent journal writes while an admitted child still reads its
                // original parent. Shared IO must drain before receipts or new claims.
                while active == 0 && staged.len() < HISTORY_LANES && next < range.end && !stopped {
                    let permitted =
                        catch_unwind(AssertUnwindSafe(|| check(BatchRunEvent::Checkpoint)))
                            .unwrap_or(false);
                    if !permitted {
                        stopped = true;
                        failure.get_or_insert_with(|| {
                            anyhow::anyhow!("migration_batch_worker_stopped")
                        });
                        break;
                    }
                    let index = next;
                    next += 1;
                    let mut work = match self.admit_history_lane(job_id, index) {
                        Ok(Some(work)) => work,
                        Ok(None) => continue,
                        Err(error) => {
                            stopped = true;
                            failure.get_or_insert(error);
                            break;
                        }
                    };
                    match self.prepare_history_execution(
                        &work.job,
                        &work.action,
                        &work.plan,
                        history,
                        resuming,
                    ) {
                        Ok(prepared) => work.prepared = Some(prepared),
                        Err(error) => {
                            if let Err(commit) =
                                self.commit_history_lane(&work, Err(error), targets)
                            {
                                stopped = true;
                                failure.get_or_insert(commit);
                            }
                            continue;
                        }
                    }
                    let completed = work
                        .job
                        .batch
                        .as_ref()
                        .unwrap()
                        .actions
                        .iter()
                        .filter(|action| {
                            matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped)
                        })
                        .count();
                    let permitted = catch_unwind(AssertUnwindSafe(|| {
                        check(BatchRunEvent::Action {
                            action_id: &work.action.action_id,
                            index: completed,
                            total,
                        })
                    }))
                    .unwrap_or(false);
                    if !permitted {
                        stopped = true;
                        failure.get_or_insert_with(|| {
                            anyhow::anyhow!("migration_batch_worker_stopped")
                        });
                        break;
                    }
                    staged.push(work);
                }
                for mut work in staged {
                    if stopped {
                        break;
                    }
                    active += 1;
                    let sender = send.clone();
                    let spawned = std::thread::Builder::new()
                        .name("migration-history".into())
                        .stack_size(2 * 1024 * 1024)
                        .spawn_scoped(scope, move || {
                            let outcome = catch_unwind(AssertUnwindSafe(|| {
                                let prepared = work
                                    .prepared
                                    .take()
                                    .expect("a staged child retains its original execution lease");
                                self.run_prepared_history(
                                    &work.job,
                                    &work.action,
                                    &work.plan,
                                    history,
                                    prepared,
                                    &mut |event| {
                                        let BatchRunEvent::History { event, .. } = event else {
                                            return false;
                                        };
                                        let (respond, result) = mpsc::sync_channel(1);
                                        sender
                                            .send(Event::Progress {
                                                action_id: work.action.action_id.clone(),
                                                event,
                                                respond,
                                            })
                                            .is_ok()
                                            && result.recv().unwrap_or(false)
                                    },
                                )
                            }))
                            .unwrap_or_else(|_| {
                                Err(anyhow::anyhow!("migration_history_batch_worker_failed"))
                            });
                            let _ = sender.send(Event::Finished {
                                work: Box::new(work),
                                outcome,
                            });
                        });
                    if spawned.is_err() {
                        active -= 1;
                        stopped = true;
                        failure.get_or_insert_with(|| {
                            anyhow::anyhow!("migration_history_batch_worker_failed")
                        });
                    }
                }
                if active == 0 {
                    break;
                }
                // Workers wait for each progress decision, bounding this channel to the live lanes.
                // The original non-Send callback remains on its owning thread.
                match receive.recv() {
                    Ok(Event::Progress {
                        action_id,
                        event,
                        respond,
                    }) => {
                        let allowed = !stopped
                            && catch_unwind(AssertUnwindSafe(|| {
                                check(BatchRunEvent::History {
                                    action_id: &action_id,
                                    event,
                                })
                            }))
                            .unwrap_or(false);
                        if !allowed {
                            stopped = true;
                            failure.get_or_insert_with(|| {
                                anyhow::anyhow!("migration_batch_worker_stopped")
                            });
                        }
                        let _ = respond.send(allowed);
                    }
                    Ok(Event::Finished { work, outcome }) => {
                        active -= 1;
                        finished.push((work, outcome));
                        if active != 0 {
                            continue;
                        }
                        for (work, outcome) in finished.drain(..) {
                            if let Err(error) = self.commit_history_lane(&work, outcome, targets) {
                                stopped = true;
                                failure.get_or_insert(error);
                            }
                            // Publish actual completion order after every parent reader has exited.
                            match self.read(job_id) {
                                Ok(current) => {
                                    let completed = current
                                        .batch
                                        .as_ref()
                                        .unwrap()
                                        .actions
                                        .iter()
                                        .filter(|action| {
                                            matches!(
                                                action.status,
                                                ItemStatus::Committed | ItemStatus::Skipped
                                            )
                                        })
                                        .count();
                                    let allowed = !stopped
                                        && catch_unwind(AssertUnwindSafe(|| {
                                            check(BatchRunEvent::Action {
                                                action_id: &work.action.action_id,
                                                index: completed.saturating_sub(1),
                                                total,
                                            })
                                        }))
                                        .unwrap_or(false);
                                    if !allowed {
                                        stopped = true;
                                        failure.get_or_insert_with(|| {
                                            anyhow::anyhow!("migration_batch_worker_stopped")
                                        });
                                    }
                                }
                                Err(error) => {
                                    stopped = true;
                                    failure.get_or_insert(error);
                                }
                            }
                        }
                    }
                    Err(_) => {
                        stopped = true;
                        failure.get_or_insert_with(|| {
                            anyhow::anyhow!("migration_history_batch_worker_failed")
                        });
                        break;
                    }
                }
            }
        });
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(())
    }
}
