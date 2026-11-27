//! Typed, request-local transcript projection shared by app-server readers.

#[path = "artifacts.rs"]
mod artifacts;
#[path = "attachment_envelope.rs"]
mod attachment_envelope;
#[path = "attempt_rows.rs"]
mod attempt_rows;
#[path = "projection.rs"]
mod projection;
#[path = "../../app_server/tool_images.rs"]
pub mod tool_images;
#[path = "../../app_server/transcript_window.rs"]
pub mod transcript_window;

pub use artifacts::{ApprovalDecisionArtifact, TurnOutcomeArtifact};
pub use attachment_envelope::{
    KCODER_ATTACHMENTS_CLOSE, KCODER_ATTACHMENTS_OPEN, MAX_ATTACHMENTS_PER_TURN,
    split_history_attachment_envelope,
};
pub use attempt_rows::AttemptRows;
pub use projection::*;

use kcoder_app_protocol::ThreadMessage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const MAX_TRANSCRIPT_MESSAGE_BYTES: usize = 64 * 1024;

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
