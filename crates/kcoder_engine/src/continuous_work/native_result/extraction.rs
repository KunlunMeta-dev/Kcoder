//! Prepare bounded, non-authorizing facts from the original background event.
//!
//! The caller must be the actual native publisher and separately verify its
//! work binding. Preparation neither publishes bytes nor commits a receipt.
//! Existing ToolOutput producers do not expose trustworthy completeness facts;
//! text here is therefore always marked unknown, regardless of its contents.

use kcoder_tools::{ToolExecutionMetadata, background::BackgroundJobEvent};
use kcoder_types::{
    BackgroundEventIdentity, ContentBlock, TaskStatus,
    continuous_work::terminal_evidence::{
        BackgroundContentCompleteness, BackgroundPayloadKind, BackgroundProcessFacts,
        BackgroundProcessState, MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES,
    },
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fmt, io};

const MAX_TEXT_BLOCKS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractionError {
    InvalidIdentity,
    IdentityMismatch,
    InvalidLimit,
}

/// Prepared bytes remain private to the owning host. Debug output never prints
/// their content; preparation does not mean they were stored or delivered.
#[derive(Clone, PartialEq, Eq)]
pub struct PreparedPayload {
    pub kind: BackgroundPayloadKind,
    pub sha256: String,
    bytes: Vec<u8>,
}

impl PreparedPayload {
    pub fn private_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

impl fmt::Debug for PreparedPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedPayload")
            .field("kind", &self.kind)
            .field("byte_len", &self.bytes.len())
            .field("content", &"[private]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparedContent {
    Available(PreparedPayload),
    /// The native event does not include an output body.
    NotProvided,
    /// Serialization stopped before allocating more than the caller's bound.
    TooLarge,
    /// Multimodal, executable-looking or overly numerous blocks are not copied.
    Unsupported,
    Unencodable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTerminalEvidence {
    pub event: BackgroundEventIdentity,
    pub status: TaskStatus,
    pub output_is_error: Option<bool>,
    pub completeness: BackgroundContentCompleteness,
    pub process: BackgroundProcessFacts,
    pub content: PreparedContent,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolOutputEnvelope<'a> {
    schema_version: u8,
    is_error: bool,
    content: &'a [ContentBlock],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEnvelope<'a> {
    schema_version: u8,
    diagnostic: &'a str,
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl io::Write for BoundedWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("background result exceeds capture limit"));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode<T: Serialize>(value: &T, kind: BackgroundPayloadKind, limit: usize) -> PreparedContent {
    let mut writer = BoundedWriter {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        return if writer.exceeded {
            PreparedContent::TooLarge
        } else {
            PreparedContent::Unencodable
        };
    }
    let sha256 = format!("{:x}", Sha256::digest(&writer.bytes));
    PreparedContent::Available(PreparedPayload {
        kind,
        sha256,
        bytes: writer.bytes,
    })
}

fn process_facts(metadata: &[ToolExecutionMetadata]) -> BackgroundProcessFacts {
    let mut processes = metadata.iter().filter_map(|entry| match entry {
        ToolExecutionMetadata::Process {
            exit_code, signal, ..
        } => Some((*exit_code, *signal)),
        _ => None,
    });
    let first = processes.next();
    if processes.next().is_some() {
        return BackgroundProcessFacts {
            state: BackgroundProcessState::Conflicting,
            exit_code: None,
            signal: None,
        };
    }
    match first {
        None => BackgroundProcessFacts {
            state: BackgroundProcessState::NotReported,
            exit_code: None,
            signal: None,
        },
        Some((None, None)) => BackgroundProcessFacts {
            state: BackgroundProcessState::Indeterminate,
            exit_code: None,
            signal: None,
        },
        Some((Some(exit_code), None)) => BackgroundProcessFacts {
            state: BackgroundProcessState::Observed,
            exit_code: Some(exit_code),
            signal: None,
        },
        Some((None, Some(signal))) if signal > 0 => BackgroundProcessFacts {
            state: BackgroundProcessState::Observed,
            exit_code: None,
            signal: Some(signal),
        },
        _ => BackgroundProcessFacts {
            state: BackgroundProcessState::Conflicting,
            exit_code: None,
            signal: None,
        },
    }
}

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

/// Extract facts from a real producer's event and exact run identity. Only
/// text blocks are captured; other output kinds remain explicitly unsupported.
/// Hidden `user_context`, process working directories and other metadata are
/// never copied into this payload or a public projection.
pub fn prepare_terminal(
    identity: &BackgroundEventIdentity,
    event: &BackgroundJobEvent,
    maximum_bytes: usize,
) -> Result<Option<PreparedTerminalEvidence>, ExtractionError> {
    if maximum_bytes == 0 || maximum_bytes as u64 > MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES {
        return Err(ExtractionError::InvalidLimit);
    }
    if !atom(&identity.run.parent_session_id)
        || !atom(&identity.run.agent_id)
        || !atom(&identity.run.run_id)
        || !atom(&identity.event_id)
    {
        return Err(ExtractionError::InvalidIdentity);
    }
    let mut payload = event;
    while let BackgroundJobEvent::Scoped {
        identity: scoped,
        event,
    } = payload
    {
        if scoped != identity {
            return Err(ExtractionError::IdentityMismatch);
        }
        payload = event;
    }
    if payload.id() != identity.run.agent_id {
        return Err(ExtractionError::IdentityMismatch);
    }
    let (status, is_error, process, content) = match payload {
        BackgroundJobEvent::Completed { output, .. } => {
            let content = if output.content.len() > MAX_TEXT_BLOCKS
                || output
                    .content
                    .iter()
                    .any(|block| !matches!(block, ContentBlock::Text { .. }))
            {
                PreparedContent::Unsupported
            } else {
                encode(
                    &ToolOutputEnvelope {
                        schema_version: 1,
                        is_error: output.is_error,
                        content: &output.content,
                    },
                    BackgroundPayloadKind::ToolOutput,
                    maximum_bytes,
                )
            };
            (
                TaskStatus::Completed,
                Some(output.is_error),
                process_facts(&output.execution_metadata),
                content,
            )
        }
        BackgroundJobEvent::Failed {
            error,
            execution_metadata,
            ..
        } => (
            TaskStatus::Failed,
            None,
            process_facts(execution_metadata),
            encode(
                &DiagnosticEnvelope {
                    schema_version: 1,
                    diagnostic: error,
                },
                BackgroundPayloadKind::TerminalDiagnostic,
                maximum_bytes,
            ),
        ),
        BackgroundJobEvent::Cancelled { reason, .. }
        | BackgroundJobEvent::Halted { reason, .. } => {
            let status = if matches!(payload, BackgroundJobEvent::Cancelled { .. }) {
                TaskStatus::Cancelled
            } else {
                TaskStatus::Halted
            };
            (
                status,
                None,
                process_facts(&[]),
                encode(
                    &DiagnosticEnvelope {
                        schema_version: 1,
                        diagnostic: reason,
                    },
                    BackgroundPayloadKind::TerminalDiagnostic,
                    maximum_bytes,
                ),
            )
        }
        _ => return Ok(None),
    };
    Ok(Some(PreparedTerminalEvidence {
        event: identity.clone(),
        status,
        output_is_error: is_error,
        completeness: BackgroundContentCompleteness::Unobserved,
        process,
        content,
    }))
}

#[cfg(test)]
#[path = "extraction/tests.rs"]
mod tests;
