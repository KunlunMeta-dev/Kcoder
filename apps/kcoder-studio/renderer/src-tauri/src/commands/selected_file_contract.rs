//! Native selected-file IPC v1: metadata first, bounded binary chunks, explicit close.
pub(crate) const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 512;
pub(crate) const MAX_DEPTH: usize = 16;
pub(crate) const MAX_ENTRIES: usize = 4096;
pub(crate) const CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedFileMetadata {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) size: u64,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedFileRead {
    pub(crate) read_id: String,
    pub(crate) chunk_bytes: usize,
    pub(crate) files: Vec<SelectedFileMetadata>,
}
