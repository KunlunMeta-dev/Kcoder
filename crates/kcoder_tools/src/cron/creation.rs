//! Creation evidence commits with the job and survives firing or deletion.
use super::*;
use sha2::{Digest, Sha256};

pub(super) const MAX_CREATIONS: usize = 512;
const CREATION_BYTES: usize = 2 * 1024 * 1024;
pub const CREATION_CONTEXT_CHANGED: &str = "cron creation context changed; prepare a new creation";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CreationReceipt {
    pub request_id: String,
    pub intent: String,
    pub job: CronJob,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid cron creation request identity".into());
    }
    Ok(())
}

pub(super) fn request_epoch(id: &str) -> Result<u64, String> {
    validate_id(id)?;
    let Some(versioned) = id.strip_prefix("cron-v1-") else {
        return Ok(0);
    };
    let (epoch, nonce) = versioned
        .split_once('-')
        .ok_or("invalid cron creation generation")?;
    if nonce.is_empty() || epoch.is_empty() || !epoch.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid cron creation generation".into());
    }
    epoch
        .parse()
        .map_err(|_| "invalid cron creation generation".into())
}

/// Rotate evidence and its replay fence in the same atomic commit as the next job.
pub(super) fn admit(file: &mut CronFile, id: &str) -> Result<(), String> {
    if request_epoch(id)? != file.creation_epoch {
        return Err(CREATION_CONTEXT_CHANGED.into());
    }
    if file.creations.len() >= MAX_CREATIONS
        || serde_json::to_vec(&file.creations)
            .map_err(|e| e.to_string())?
            .len()
            >= CREATION_BYTES
    {
        file.creation_epoch = file
            .creation_epoch
            .checked_add(1)
            .ok_or("cron creation generation exhausted")?;
        let mut bytes = 0;
        let mut retained = 0;
        for receipt in file.creations.iter().rev().take(MAX_CREATIONS / 2) {
            bytes += serde_json::to_vec(receipt)
                .map_err(|e| e.to_string())?
                .len();
            if bytes > CREATION_BYTES / 2 {
                break;
            }
            retained += 1;
        }
        file.creations.drain(..file.creations.len() - retained);
    }
    Ok(())
}

pub(super) fn intent(
    id: Option<&str>,
    owner: &Option<String>,
    prompt: &str,
    schedule: &CronSchedule,
    jitter: Option<u64>,
) -> Result<Option<String>, String> {
    let Some(id) = id else { return Ok(None) };
    validate_id(id)?;
    let bytes =
        serde_json::to_vec(&(owner, prompt, schedule, jitter)).map_err(|e| e.to_string())?;
    Ok(Some(format!("{:x}", Sha256::digest(bytes))))
}

pub(super) fn validate(receipts: &[CreationReceipt]) -> Result<(), String> {
    let mut ids = std::collections::BTreeSet::new();
    if receipts.len() > MAX_CREATIONS {
        return Err("cron creation receipt capacity exceeded".into());
    }
    for receipt in receipts {
        request_epoch(&receipt.request_id)?;
        if receipt.intent.len() != 64
            || !receipt.intent.bytes().all(|b| b.is_ascii_hexdigit())
            || !ids.insert((&receipt.job.session_id, &receipt.request_id))
        {
            return Err("invalid cron creation receipt".into());
        }
    }
    Ok(())
}

impl CronScheduler {
    pub fn create_for_session_with_request(
        &self,
        owner: String,
        prompt: String,
        schedule: CronSchedule,
        jitter: Option<u64>,
        request_id: &str,
    ) -> Result<CronJob, String> {
        self.create_owned(Some(owner), prompt, schedule, jitter, Some(request_id))
    }

    /// Atomic store snapshots need no write, lock-file creation, or task migration.
    pub fn read_creation(&self, owner: &str, request_id: &str) -> Result<Option<CronJob>, String> {
        Ok(self.read_creation_state(owner, request_id)?.0)
    }

    pub fn creation_epoch(&self) -> Result<u64, String> {
        Ok(read_cron_file(&self.0.path)?
            .unwrap_or_default()
            .creation_epoch)
    }

    /// No receipt is never a grant to replay, including after its generation retires.
    pub fn read_creation_state(
        &self,
        owner: &str,
        request_id: &str,
    ) -> Result<(Option<CronJob>, bool), String> {
        let epoch = request_epoch(request_id)?;
        let file = read_cron_file(&self.0.path)?.unwrap_or_default();
        let job = file
            .creations
            .into_iter()
            .find(|r| r.request_id == request_id && r.job.session_id.as_deref() == Some(owner))
            .map(|r| r.job);
        let retired = job.is_none() && epoch < file.creation_epoch;
        Ok((job, retired))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_creation_evidence_frees_capacity_without_allowing_old_requests_to_execute() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let path = root.path().join(".kcoder/cron/jobs.json");
        assert_eq!(scheduler.creation_epoch().unwrap(), 0);
        assert!(!path.parent().unwrap().exists());
        let schedule = CronSchedule::Every {
            every_seconds: 3600,
        };
        scheduler
            .create_for_session_with_request(
                "owner".into(),
                "review".into(),
                schedule.clone(),
                Some(0),
                "first",
            )
            .unwrap();
        let mut file = read_cron_file(&path).unwrap().unwrap();
        let original = file.creations[0].clone();
        file.jobs.clear();
        file.creations = (0..MAX_CREATIONS)
            .map(|index| {
                let mut receipt = original.clone();
                receipt.request_id = format!("completed-{index}");
                receipt.job.id = format!("deleted-{index}");
                receipt
            })
            .collect();
        persist_cron_file(&path, &file).unwrap();
        let fresh = scheduler
            .create_for_session_with_request(
                "owner".into(),
                "new review".into(),
                schedule.clone(),
                Some(0),
                "cron-v1-0-new",
            )
            .unwrap();
        let reopened = CronScheduler::load(root.path());
        assert_eq!(reopened.creation_epoch().unwrap(), 1);
        let (missing, retired) = reopened
            .read_creation_state("owner", "completed-0")
            .unwrap();
        assert!(missing.is_none() && retired);
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            reopened
                .create_for_session_with_request(
                    "owner".into(),
                    "review".into(),
                    schedule.clone(),
                    Some(0),
                    "completed-0"
                )
                .unwrap_err(),
            CREATION_CONTEXT_CHANGED
        );
        assert_eq!(
            reopened
                .create_for_session_with_request(
                    "owner".into(),
                    "never admitted".into(),
                    schedule.clone(),
                    Some(0),
                    "cron-v1-0-late"
                )
                .unwrap_err(),
            CREATION_CONTEXT_CHANGED
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            reopened
                .create_for_session_with_request(
                    "owner".into(),
                    "new review".into(),
                    schedule.clone(),
                    Some(0),
                    "cron-v1-0-new"
                )
                .unwrap()
                .id,
            fresh.id
        );
        reopened
            .create_for_session_with_request(
                "owner".into(),
                "another review".into(),
                schedule,
                Some(0),
                "cron-v1-1-next",
            )
            .unwrap();
        assert_eq!(reopened.list_for_session("owner").unwrap().len(), 2);
        assert!(read_cron_file(&path).unwrap().unwrap().creations.len() <= MAX_CREATIONS);

        // Escaped prompts must not fill the whole store before the count window rotates.
        let mut file = read_cron_file(&path).unwrap().unwrap();
        let mut large = file.creations.last().unwrap().clone();
        large.job.prompt = "\0".repeat(32 * 1024);
        file.jobs.clear();
        file.creations = (0..16)
            .map(|index| {
                let mut receipt = large.clone();
                receipt.request_id = format!("large-{index}");
                receipt
            })
            .collect();
        persist_cron_file(&path, &file).unwrap();
        reopened
            .create_for_session_with_request(
                "owner".into(),
                "fits after compaction".into(),
                CronSchedule::Every {
                    every_seconds: 3600,
                },
                Some(0),
                "cron-v1-1-after-large",
            )
            .unwrap();
        let compacted = read_cron_file(&path).unwrap().unwrap();
        assert_eq!(compacted.creation_epoch, 2);
        assert!(serde_json::to_vec(&compacted.creations).unwrap().len() < CREATION_BYTES);
    }

    #[test]
    fn creation_receipt_survives_restart_and_deletion_without_recreating_the_job() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".kcoder/cron/jobs.json");
        let scheduler = CronScheduler::load(root.path());
        let schedule = CronSchedule::Every {
            every_seconds: 3600,
        };
        let first = scheduler
            .create_for_session_with_request(
                "owner".into(),
                "review".into(),
                schedule.clone(),
                Some(0),
                "original",
            )
            .unwrap();
        assert_eq!(read_cron_file(&path).unwrap().unwrap().version, 5);
        assert!(scheduler.delete_for_session(&first.id, "owner").unwrap());
        let before = fs::read(&path).unwrap();
        let reopened = CronScheduler::load(root.path());
        assert_eq!(
            reopened
                .read_creation("owner", "original")
                .unwrap()
                .unwrap()
                .id,
            first.id
        );
        assert!(
            reopened
                .read_creation("other", "original")
                .unwrap()
                .is_none()
        );
        assert!(reopened.read_creation("owner", "absent").unwrap().is_none());
        let repeated = reopened
            .create_for_session_with_request(
                "owner".into(),
                "review".into(),
                schedule.clone(),
                Some(0),
                "original",
            )
            .unwrap();
        assert_eq!(repeated.id, first.id);
        assert!(reopened.list_for_session("owner").unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(
            reopened
                .create_for_session_with_request(
                    "owner".into(),
                    "changed".into(),
                    schedule,
                    Some(0),
                    "original"
                )
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn receipt_reads_do_not_create_storage_and_corrupt_evidence_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".kcoder/cron/jobs.json");
        let scheduler = CronScheduler::load(root.path());
        assert!(
            scheduler
                .read_creation("owner", "original")
                .unwrap()
                .is_none()
        );
        assert!(!path.parent().unwrap().exists());
        let job = scheduler
            .create_for_session_with_request(
                "owner".into(),
                "review".into(),
                CronSchedule::Every {
                    every_seconds: 3600,
                },
                None,
                "original",
            )
            .unwrap();
        let mut file = read_cron_file(&path).unwrap().unwrap();
        file.creations.push(file.creations[0].clone());
        assert!(validate(&file.creations).is_err());
        let original = fs::read(&path).unwrap();
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert!(scheduler.read_creation("owner", "original").is_err());
        fs::write(&path, original).unwrap();
        file.creations.truncate(1);
        file.creations[0].intent = "bad".into();
        assert!(validate(&file.creations).is_err());
        assert!(scheduler.read_creation("owner", "../other").is_err());
        assert_eq!(
            scheduler
                .read_creation("owner", "original")
                .unwrap()
                .unwrap()
                .id,
            job.id
        );
    }
}
