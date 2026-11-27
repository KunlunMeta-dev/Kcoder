//! Shared synthetic uploads for Native unit tests; integration crates reuse the same fixture source.
use crate::{
    history_jobs::HistoryJobStore, history_sources::HistorySourceBinding,
    history_tool_attachments::HistoryToolAttachments,
    local_attachment::upload::HistoryLocalAttachmentUploads,
};
use kcoder_config::PrivateDirectory;
use kcoder_types::{
    external_history::*, historical_attachment::HistoricalAttachmentSelection,
    local_attachment_upload::*, migration::MigrationSourceKind,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[path = "../../tests/local_attachment_upload/fixture.rs"]
mod fixture;
pub(super) use fixture::Fixture;
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn sha(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
