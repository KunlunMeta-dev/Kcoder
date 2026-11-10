use super::*;
use kcoder_config::PortableLeaseIdentity;

pub(super) const PROOF_BYTES: u64 = 8192;
pub(super) const PLAN_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_FILES: usize = (HISTORICAL_LOCAL_UPLOAD_MAX_BYTES
    .div_ceil(HISTORICAL_LOCAL_UPLOAD_PART_BYTES as u64)
    + 1) as usize;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::local_attachment::upload) struct Birth {
    pub directory: PortableLeaseIdentity,
    pub parts: PortableLeaseIdentity,
    pub writer: PortableLeaseIdentity,
    pub control: PortableLeaseIdentity,
    pub catalog: PortableLeaseIdentity,
    pub collection_control: PortableLeaseIdentity,
    pub collection_writer: PortableLeaseIdentity,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileProof {
    pub temporary_name: String,
    pub identity: PortableLeaseIdentity,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Versions {
    pub version: u8,
    pub binding: String,
    pub name: String,
    pub manifest: String,
    pub values: Vec<FileProof>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Leaf {
    pub name: String,
    pub proof: FileProof,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Plan {
    pub version: u8,
    pub binding: String,
    pub collection_id: String,
    pub upload_sequence: u64,
    pub manifest: Option<String>,
    pub reserved_bytes: u64,
    pub leaves: Vec<Leaf>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadCollectionStage {
    Prepared,
    Blocked,
    Collecting,
    Collected,
    Cancelled,
    OutcomeUnknown,
}
pub struct UploadCollectionView {
    pub operation_id: String,
    pub selection: HistoricalAttachmentSelection,
    pub collection_id: String,
    pub sequence: u64,
    pub upload_sequence: u64,
    pub stage: UploadCollectionStage,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub storage_retired: bool,
    pub deleted_bytes: u64,
    pub released_reservation_bytes: u64,
    pub worker_running: bool,
    pub failure_code: Option<String>,
}
pub struct UploadCollectionPage {
    pub items: Vec<UploadCollectionView>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub version: u8,
    pub binding: String,
    pub collection_id: String,
    pub upload_sequence: u64,
    pub sequence: u64,
    pub stage: UploadCollectionStage,
    pub cancel_revision: u64,
    pub acknowledged: u64,
    pub tombstone: bool,
    pub plan: Option<String>,
    #[serde(default)]
    pub prior_plans: Vec<String>,
    pub pending: Option<String>,
    pub removed: Vec<String>,
    pub deleted_bytes: u64,
    pub completion: Option<PortableLeaseIdentity>,
    pub failure: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Completion {
    pub version: u8,
    pub binding: String,
    pub collection_id: String,
    pub plan: String,
    pub deleted_bytes: u64,
    pub released_reservation_bytes: u64,
}
pub(super) fn canonical_leaf(leaf: &str) -> Option<&str> {
    let core = if let Some(rest) = leaf.strip_prefix('.') {
        let (prefix, sequence) = rest.strip_suffix(".tmp")?.rsplit_once('.')?;
        let (core, pid) = prefix.rsplit_once('.')?;
        if !sequence.parse::<u64>().is_ok_and(|value| value > 0)
            || !pid.parse::<u32>().is_ok_and(|value| value > 0)
        {
            return None;
        }
        core
    } else {
        leaf
    };
    if core == "payload.bin" {
        return Some(core);
    }
    let index = core.strip_prefix("part-")?.strip_suffix(".bin")?;
    (index.len() == 4
        && index
            .parse::<u32>()
            .is_ok_and(|index| (index as usize) < MAX_FILES - 1))
    .then_some(core)
}
pub(super) fn slot(name: &str) -> Result<(&str, &str)> {
    let (parent, leaf) = name
        .split_once('/')
        .map_or(("", name), |(parent, leaf)| (parent, leaf));
    let canonical = canonical_leaf(leaf).context("local_upload_collection_invalid_path")?;
    ensure!(
        leaf.len() <= 128
            && ((parent.is_empty() && canonical == "payload.bin")
                || (parent == "parts" && canonical.starts_with("part-"))),
        "local_upload_collection_invalid_path"
    );
    Ok((parent, leaf))
}
pub(super) fn logical_name(name: &str) -> Result<String> {
    let (parent, leaf) = slot(name)?;
    let canonical = canonical_leaf(leaf).context("local_upload_collection_invalid_path")?;
    Ok(if parent.is_empty() {
        canonical.into()
    } else {
        format!("{parent}/{canonical}")
    })
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    budget: u64,
) -> Result<Option<T>> {
    let file = match directory.open_regular_file_snapshot(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= budget,
        "local_upload_collection_metadata_budget"
    );
    let mut bytes = Vec::new();
    file.take(budget + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= budget,
        "local_upload_collection_metadata_budget"
    );
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("local_upload_collection_invalid_metadata"))
}
pub(super) fn write_json(
    directory: &PrivateDirectory,
    name: &str,
    value: &impl Serialize,
    budget: u64,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= budget,
        "local_upload_collection_metadata_budget"
    );
    directory.atomic_replace(OsStr::new(name), &bytes)
}
