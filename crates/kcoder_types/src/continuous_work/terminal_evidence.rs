//! Portable, non-authorizing facts for one original background terminal.
//!
//! A serialized record or its digest is not proof that a process ran, that a
//! payload remains available, or that the current caller owns it. The native
//! owner must bind this record to the original dispatch, verify the private
//! object and recheck current work/control authority before consuming it.

use super::{MAX_ATOM_BYTES, atom, digest};
use crate::{BackgroundEventIdentity, BackgroundRunKey, TaskStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const BACKGROUND_TERMINAL_EVIDENCE_V1: u32 = 1;
pub const MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024;

open_label!(BackgroundContentCompleteness {
    Complete => "complete", Truncated => "truncated", Unobserved => "unknown",
});
open_label!(BackgroundPayloadKind {
    ToolOutput => "tool_output", TerminalDiagnostic => "terminal_diagnostic",
});
open_label!(BackgroundPayloadState {
    Captured => "captured", NotProvided => "not_provided", TooLarge => "too_large",
    Unencodable => "unencodable", Unsupported => "unsupported",
});
open_label!(BackgroundProcessState {
    Observed => "observed", NotReported => "not_reported", Indeterminate => "indeterminate",
    Conflicting => "conflicting",
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictRun {
    parent_session_id: String,
    agent_id: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictEvent {
    run: StrictRun,
    event_id: String,
    run_sequence: u64,
}

fn deserialize_event<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BackgroundEventIdentity, D::Error> {
    let event = StrictEvent::deserialize(deserializer)?;
    Ok(BackgroundEventIdentity {
        run: BackgroundRunKey {
            parent_session_id: event.run.parent_session_id,
            agent_id: event.run.agent_id,
            run_id: event.run.run_id,
        },
        event_id: event.event_id,
        run_sequence: event.run_sequence,
    })
}

/// A host-generated opaque leaf within the owning private result store. It is
/// a locator only and cannot authorize access to a file or another work item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundPayloadRef {
    pub kind: BackgroundPayloadKind,
    pub object_id: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Structured native process facts. Missing metadata does not prove that no
/// process ran. `Observed` with code 141 is kept as 141 even if a shell tool
/// separately normalizes a head-limited pipeline's success presentation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundProcessFacts {
    pub state: BackgroundProcessState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

impl BackgroundProcessFacts {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        match self.state {
            BackgroundProcessState::Observed
                if self.exit_code.is_some() ^ self.signal.is_some() =>
            {
                if self.signal.is_some_and(|value| value <= 0) {
                    return Err("invalid process signal");
                }
                Ok(())
            }
            BackgroundProcessState::NotReported
            | BackgroundProcessState::Indeterminate
            | BackgroundProcessState::Conflicting
                if self.exit_code.is_none() && self.signal.is_none() =>
            {
                Ok(())
            }
            BackgroundProcessState::Unknown(_) => Ok(()),
            _ => Err("inconsistent process facts"),
        }
    }
}

/// Metadata for one terminal result. A diagnostic-only payload is not a full
/// ToolOutput. Completeness refers to source capture, not merely blob integrity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundTerminalEvidence {
    pub schema_version: u32,
    #[serde(deserialize_with = "deserialize_event")]
    pub event: BackgroundEventIdentity,
    pub status: TaskStatus,
    pub payload_state: BackgroundPayloadState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<BackgroundPayloadRef>,
    pub completeness: BackgroundContentCompleteness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_is_error: Option<bool>,
    pub process: BackgroundProcessFacts,
}

impl BackgroundTerminalEvidence {
    /// Validate bounds and internal consistency only. No filesystem, result,
    /// native owner, process, payload, or authorization is verified here.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if !atom(&self.event.run.parent_session_id)
            || !atom(&self.event.run.agent_id)
            || !atom(&self.event.run.run_id)
            || !atom(&self.event.event_id)
        {
            return Err("invalid background terminal identity");
        }
        self.process.validate_shape()?;
        if let Some(payload) = &self.payload
            && (payload.object_id.is_empty()
                || payload.object_id.len() > 128
                || !payload
                    .object_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                || !digest(&payload.sha256)
                || payload.bytes > MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES)
        {
            return Err("invalid background result object reference");
        }
        match (&self.payload_state, &self.payload) {
            (BackgroundPayloadState::Captured, Some(_))
            | (BackgroundPayloadState::NotProvided, None)
            | (BackgroundPayloadState::TooLarge, None)
            | (BackgroundPayloadState::Unencodable, None)
            | (BackgroundPayloadState::Unsupported, None)
            | (BackgroundPayloadState::Unknown(_), _) => {}
            _ => return Err("background payload state and reference disagree"),
        }
        if self
            .payload
            .as_ref()
            .is_some_and(|payload| payload.kind == BackgroundPayloadKind::TerminalDiagnostic)
            && self.completeness != BackgroundContentCompleteness::Unobserved
        {
            return Err("terminal diagnostic is not a complete tool output");
        }
        Ok(())
    }

    /// A future status or schema can remain readable, but cannot be used to
    /// create or mutate an authoritative terminal receipt by an older host.
    pub fn validate_for_storage(&self) -> Result<(), &'static str> {
        self.validate_shape()?;
        if self.schema_version != BACKGROUND_TERMINAL_EVIDENCE_V1
            || !matches!(
                self.status,
                TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Halted
            )
            || !self.payload_state.is_known()
            || !self.completeness.is_known()
            || !self.process.state.is_known()
            || self
                .payload
                .as_ref()
                .is_some_and(|payload| !payload.kind.is_known())
        {
            return Err("unknown background evidence cannot be stored by this host");
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "terminal_evidence/tests.rs"]
mod tests;
