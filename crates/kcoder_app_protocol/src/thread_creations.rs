//! Creation receipts do not authorize replaying a session startup lifecycle.
use crate::Thread;
use serde::{Deserialize, Serialize};
pub const CAPABILITY_THREAD_CREATION_RECEIPTS_V1: &str = "threadCreationReceiptsV1";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreationReadParams {
    pub client_request_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadCreationStatus {
    Ready,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreationReceipt {
    pub thread_id: String,
    pub status: ThreadCreationStatus,
    pub thread: Option<Thread>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreationReadResult {
    pub receipt: Option<ThreadCreationReceipt>,
}
