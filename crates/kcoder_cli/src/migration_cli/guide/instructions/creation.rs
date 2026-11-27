//! Reopening an original request observes or explicitly finishes its sealed capture.
use super::*;
use kcoder_migration::store::{BatchCreationStage as Stage, BatchCreationWorkerState as Worker};
pub(in crate::migration_cli::guide) fn open(guide: &Guide<'_>) -> Result<Option<MigrationJob>> {
    let request = guide.io.text(
        "creation_request_id",
        "Original capture request UUID (checks its original owner and receipt without rediscovering sources)",
        None,
    )?;
    recover(guide, &request)
}
pub(super) fn recover(guide: &Guide<'_>, request: &str) -> Result<Option<MigrationJob>> {
    loop {
        let store = guide.store()?;
        let observation = store.read_batch_creation(request)?;
        guide.io.state("creation",&json!({"requestId":observation.request_id,"jobId":observation.job_id,"stage":format!("{:?}",observation.stage).to_ascii_lowercase(),"workerState":format!("{:?}",observation.worker_state).to_ascii_lowercase(),"controlRevision":observation.control_revision,"cancelRequested":observation.cancel_requested}))?;
        if let Some(job) = observation.job {
            return Ok(Some(job));
        }
        let command=guide.io.ask("creation_control", "read checks without changes; cancel requests stopping this capture; resume explicitly resumes a fully archived capture; back exits while retaining its original ID. For partial captures, use the same original UUID in the initial instructions entry to explicitly reauthorize and verify the original selection. No guessing or replacement request.", json!({"canFinishWithoutSource":observation.stage==Stage::Prepared&&observation.worker_state==Worker::Stopped}),Some("read"))?;
        if command == "back" {
            return Ok(None);
        }
        if command == "read" {
            continue;
        }
        ensure!(
            matches!(command.as_str(), "cancel" | "resume"),
            "migration_guide_invalid_selection"
        );
        if command == "resume"
            && (observation.stage != Stage::Prepared || observation.worker_state != Worker::Stopped)
        {
            guide.io.notice(
                "migration_batch_creation_original_source_required",
                "Archiving is incomplete or the owner is still running; publishing without the source is not allowed. The original request is retained and capture was not retried.",
            )?;
            continue;
        }
        let control = guide.io.text(
            "creation_control_id",
            "UUID for this explicit control request (leave blank to create; if a receipt is lost, read the original request first)",
            None,
        )?;
        let control = if control.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            control
        };
        let required = if command == "cancel" {
            "CANCEL"
        } else {
            "RESUME"
        };
        if guide.io.text(
            "creation_confirm",
            &format!(
                "Enter {required} to confirm controlling the original capture. Resume only publishes its original archived batch; it does not import into the target or enable content."
            ),
            None,
        )? != required
        {
            continue;
        }
        let fresh = guide.store()?;
        let current = fresh.read_batch_creation(request)?;
        ensure!(
            current.control_revision == observation.control_revision
                && current.stage == observation.stage
                && current.worker_state == observation.worker_state,
            "migration_revision_conflict"
        );
        let revision = current
            .control_revision
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        let result = if command == "cancel" {
            fresh.cancel_batch_creation_request(request, &control, revision)
        } else {
            let intent = fresh.batch_creation_intent(request)?;
            fresh
                .resume_batch_creation(&intent, &control, revision)
                .and_then(|resumed| {
                    fresh.continue_batch_creation(
                        &intent,
                        resumed
                            .control_revision
                            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?,
                        |_| {
                            Err(anyhow::anyhow!(
                                "migration_batch_creation_original_source_required"
                            ))
                        },
                        &mut |_, _| guide.io.active().is_ok(),
                    )
                })
        };
        if let Err(error) = result {
            guide.io.notice(
                &safe_error(&error),
                "Control was not treated as successful. Read the same original request first; do not replay changes.",
            )?;
        }
    }
}
