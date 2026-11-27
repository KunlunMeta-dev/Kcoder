use super::*;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, io::Read};

const RECORD_BYTES: usize = 96 * 1024;
const RECORDS: usize = 32;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub version: u8,
    pub workspace: PathBuf,
    pub publication_observed: bool,
    pub result: p::TaskDeliveryResult,
}

pub(super) struct Store(PrivateDirectory);
impl Store {
    pub fn open(session: &Path) -> Result<Self> {
        Ok(Self(PrivateDirectory::open_or_create(
            &session.join("task-delivery"),
        )?))
    }
    pub fn load(&self, thread: &str, id: &str) -> Result<Record> {
        ensure!(is_hash(id), "invalid delivery identity");
        let mut bytes = Vec::new();
        self.0
            .open_regular_file(OsStr::new(&format!("{id}.json")))?
            .take(RECORD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= RECORD_BYTES,
            "delivery record exceeds budget"
        );
        let row: Record = serde_json::from_slice(&bytes)?;
        ensure!(
            row.version == 1 && row.result.delivery_id == id && row.result.thread_id == thread,
            "delivery owner mismatch"
        );
        ensure!(
            delivery_id(
                thread,
                &row.workspace,
                &row.result.source,
                &row.result.recipient,
                &row.result.comparison_id
            )? == id,
            "delivery source identity mismatch"
        );
        Ok(row)
    }
    pub fn save_new(&self, row: &Record) -> Result<p::TaskDeliveryResult> {
        let _lock = self
            .0
            .try_exclusive_lock(OsStr::new("delivery.lock"))?
            .context("delivery_busy")?;
        match self
            .0
            .open_regular_file(OsStr::new(&format!("{}.json", row.result.delivery_id)))
        {
            Ok(_) => {
                return Ok(self
                    .load(&row.result.thread_id, &row.result.delivery_id)?
                    .result);
            }
            Err(error) if error_is_not_found(&error) => {}
            Err(error) => return Err(error),
        }
        let mut count = 0;
        let mut unresolved = None;
        self.0.visit_entry_names_bounded(RECORDS + 2, |name| {
            if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) {
                count += 1;
                let prior = self.load(&row.result.thread_id, id)?;
                if prior.result.recipient == row.result.recipient
                    && prior.result.source.repository == row.result.source.repository
                    && prior.result.source.branch == row.result.source.branch
                    && prior.result.request.is_some()
                    && !prior.publication_observed
                {
                    unresolved = Some(prior.result);
                }
            }
            Ok(())
        })?;
        if let Some(mut prior) = unresolved {
            if prior.source != row.result.source {
                prior.status.source_changed = true;
                prior.status.ci_state = p::TaskDeliveryCiState::Unknown;
                prior.status.checks.clear();
                prior.status.limitation = Some("sourceChanged".into());
            }
            return Ok(prior);
        }
        ensure!(
            count < RECORDS,
            "delivery quota reached; existing receipts are retained"
        );
        self.write(row)?;
        Ok(row.result.clone())
    }
    pub fn request(
        &self,
        params: &p::TaskDeliveryRequestParams,
        workspace: &Path,
        source: &p::TaskDeliverySource,
    ) -> Result<p::TaskDeliveryResult> {
        let _lock = self
            .0
            .try_exclusive_lock(OsStr::new("delivery.lock"))?
            .context("delivery_busy")?;
        let mut row = self.load(&params.thread_id, &params.delivery_id)?;
        ensure!(
            row.workspace == workspace && row.result.source == *source,
            "delivery_source_changed: prepare the current commit again"
        );
        self.0.visit_entry_names_bounded(RECORDS + 2, |name| {
            let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { return Ok(()); };
            if id == params.delivery_id { return Ok(()); }
            let prior = self.load(&params.thread_id, id)?;
            if prior.result.source.repository == source.repository && prior.result.source.branch == source.branch && prior.result.request.is_some() {
                ensure!(prior.publication_observed,
                    "delivery_previous_request_unknown: reconcile original delivery {} before another publication request", id);
            }
            Ok(())
        })?;
        let draft = p::TaskDeliveryDraft {
            title: params.title.clone(),
            body: params.body.clone(),
        };
        let digest = hex_sha256(&serde_json::to_vec(&draft)?);
        if let Some(request) = &row.result.request {
            ensure!(
                request.request_id == params.request_id && request.draft_sha256 == digest,
                "delivery_request_unresolved: read the original request; never republish automatically"
            );
            return Ok(row.result);
        }
        row.result.draft = draft;
        let prompt = publish_prompt(&row, &params.request_id)?;
        row.result.request = Some(p::TaskDeliveryRequest {
            request_id: params.request_id.clone(),
            draft_sha256: digest,
            prompt,
        });
        self.write(&row)?;
        Ok(row.result)
    }
    pub fn observe(&self, thread: &str, id: &str, status: &p::TaskDeliveryStatus) -> Result<()> {
        let _lock = self
            .0
            .try_exclusive_lock(OsStr::new("delivery.lock"))?
            .context("delivery_busy")?;
        let mut row = self.load(thread, id)?;
        row.publication_observed |= status.push_state == "pushed"
            && status
                .pull_request
                .as_ref()
                .is_some_and(|pr| pr.matches_request);
        row.result.status = status.clone();
        self.write(&row)
    }
    fn write(&self, row: &Record) -> Result<()> {
        let bytes = serde_json::to_vec(row)?;
        ensure!(
            bytes.len() <= RECORD_BYTES,
            "delivery record exceeds budget"
        );
        self.0.atomic_replace(
            OsStr::new(&format!("{}.json", row.result.delivery_id)),
            &bytes,
        )
    }
}
