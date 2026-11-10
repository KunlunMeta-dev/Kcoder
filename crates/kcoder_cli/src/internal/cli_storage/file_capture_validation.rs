//! Durable file-capture record validation, independent of Engine.

use crate::private_files::hex_sha256;
use anyhow::{Result, ensure};
use kcoder_app_protocol::{
    TurnFileCaptureLimitation as Limitation, TurnFileCaptureState as State, TurnFileChangesCapture,
};
use kcoder_workspace_resources::managed_worktrees::valid_artifact_id;
use std::ffi::OsStr;

pub const MAX_CAPTURE_RECORD_BYTES: u64 = 16 * 1024;

pub fn capture_identity(thread: &str, turn: &str, attempt: &str) -> String {
    hex_sha256(format!("{thread}\0{turn}\0{attempt}").as_bytes())
}

pub fn validate_file_capture(capture: &TurnFileChangesCapture, thread: &str) -> Result<()> {
    ensure!(
        capture.version == 1 && capture.thread_id == thread,
        "invalid capture owner"
    );
    for id in [&capture.thread_id, &capture.turn_id, &capture.attempt_id] {
        ensure!(
            !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control),
            "invalid capture identity"
        );
    }
    ensure!(
        capture.capture_id == capture_identity(thread, &capture.turn_id, &capture.attempt_id),
        "capture identity mismatch"
    );
    ensure!(
        capture.limitations.len() <= 6,
        "capture limitations exceed budget"
    );
    for window in [&capture.base, &capture.head].into_iter().flatten() {
        ensure!(
            window.started_at_ms <= window.completed_at_ms
                && window.completed_at_ms <= 8_640_000_000_000_000,
            "invalid capture window"
        );
    }
    if let Some(artifact) = &capture.artifact_id {
        ensure!(
            valid_artifact_id(artifact),
            "invalid capture artifact reference"
        );
    }
    if matches!(capture.state, State::Changed | State::Unchanged) {
        ensure!(
            capture.base.is_some() && capture.head.is_some() && capture.limitations.is_empty(),
            "incomplete capture cannot be complete"
        );
        ensure!(
            (capture.state == State::Changed) == capture.artifact_id.is_some(),
            "capture result mismatch"
        );
    }
    Ok(())
}

pub fn file_capture_for_history(mut capture: TurnFileChangesCapture) -> TurnFileChangesCapture {
    if capture.state == State::Capturing {
        capture.state = State::Unknown;
        if !capture.limitations.contains(&Limitation::CaptureIncomplete) {
            capture.limitations.push(Limitation::CaptureIncomplete);
        }
    }
    capture
}

pub fn decode_file_capture(
    bytes: &[u8],
    thread: &str,
    name: &OsStr,
) -> Result<TurnFileChangesCapture> {
    ensure!(
        bytes.len() as u64 <= MAX_CAPTURE_RECORD_BYTES,
        "capture record exceeds budget"
    );
    let capture: TurnFileChangesCapture = serde_json::from_slice(bytes)?;
    validate_file_capture(&capture, thread)?;
    ensure!(
        name == OsStr::new(&format!("{}.json", capture.capture_id)),
        "capture filename mismatch"
    );
    Ok(file_capture_for_history(capture))
}
