//! Native-only single-Main transport. These frames are not public RPC or grants.
//! The receiver must retain the actual OS peer and original public/source owner.
use super::{connectivity::*, *};
use crate::{
    ApprovalRequestParams, ApprovalResponse, ClientCapabilities, ImplementationInfo,
    InitializeResult, QuestionRequestParams, QuestionResponse,
};
use serde::{Deserialize, Serialize};
mod task_turn;
pub use task_turn::*;
mod task_interrupt;
pub use task_interrupt::*;
mod task_async_question;
pub use task_async_question::*;
mod task_ui_registration;
pub use task_ui_registration::*;
mod task_start;
pub use task_start::*;
mod task_read;
pub use task_read::*;
mod task_command;
pub use task_command::*;
pub const CHANNEL_PEER_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const CHANNEL_PEER_STREAM_CAPACITY: usize = 32;
pub const CHANNEL_PEER_PENDING_PER_STREAM: usize = 64;
// The Studio/Gateway initializer already negotiates more than 64 capabilities.
// Keep a finite metadata bound independently of the existing 2 MiB frame limit.
pub const CHANNEL_PEER_INITIALIZE_CAPABILITIES: usize = 256;

/// An authenticated first-party launcher selects task infrastructure. This
/// control carries no platform member, source binding or execution consent.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AppServerHostManagerRequest {
    StartAppServerHost {
        selection: kcoder_types::integrations::core::AppServerHostSelection,
        budget_ms: u64,
    },
    ReadAppServerHost {
        selection: kcoder_types::integrations::core::AppServerHostSelection,
        budget_ms: u64,
    },
}

impl AppServerHostManagerRequest {
    pub fn parts(
        &self,
    ) -> Result<
        (
            &kcoder_types::integrations::core::AppServerHostSelection,
            u64,
            bool,
        ),
        String,
    > {
        let (selection, budget, start) = match self {
            Self::StartAppServerHost {
                selection,
                budget_ms,
            } => (selection, *budget_ms, true),
            Self::ReadAppServerHost {
                selection,
                budget_ms,
            } => (selection, *budget_ms, false),
        };
        if selection.revision == 0
            || (start && !selection.enabled)
            || selection.launch_ref.len() != 64
            || !selection
                .launch_ref
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !(1..=60_000).contains(&budget)
        {
            return Err(invalid());
        }
        Ok((selection, budget, start))
    }
}

/// Issued by the receiving host for one actual connection. Identity values are
/// correlation fields; deserializing them cannot create the corresponding owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerStreamRef {
    pub id: String,
    pub host_epoch: String,
    pub app_server_epoch: String,
    pub scope: IntegrationScope,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChannelPeerRequestId {
    Number(i64),
    Text(String),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerInitialize {
    pub protocol_version: String,
    pub client_info: ImplementationInfo,
    pub capabilities: ClientCapabilities,
}
impl ChannelPeerInitialize {
    pub fn validate(&self) -> Result<(), String> {
        atom(&self.protocol_version)?;
        atom(&self.client_info.name)?;
        if self.capabilities.experimental.len() > CHANNEL_PEER_INITIALIZE_CAPABILITIES {
            return Err(invalid());
        }
        Ok(())
    }
}

/// Native UI producer registration over the already authenticated manager
/// control lane. These locators bind one stream and grant no operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerUiRegistration {
    pub nonce: String,
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    pub expires_at_ms: u64,
    pub initialize: ChannelPeerInitialize,
    pub original_call: ConnectivityPortCall,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_launch_ref: Option<String>,
}
impl ChannelPeerUiRegistration {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        self.original_call.validate().map_err(|_| invalid())?;
        self.initialize.validate()?;
        if self.nonce.len() != 32
            || !self.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.original_call.request.scope != self.scope
            || self.source_authority_epoch == 0
            || self.expires_at_ms == 0
            || self.sdk_launch_ref.as_ref().is_some_and(|reference| {
                reference.len() != 64
                    || !reference
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// No arbitrary method, caller principal, role, trusted flag or alternate root.
/// This enum is accepted only on a finite UI peer captured from original Native
/// public control; SDK/source channels have no constructor for that peer kind.
#[derive(Serialize, Deserialize)]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum ChannelPeerUiCall {
    #[serde(rename = "task.start")]
    TaskStart(ChannelPeerTaskStart),
    #[serde(rename = "task.read")]
    TaskRead(ChannelPeerTaskRead),
    #[serde(rename = "connectivity")]
    Connectivity(ConnectivityPortCall),
    #[serde(rename = "taskResources.readFact")]
    TaskResources(ChannelPeerTaskResourceFactRead),
    #[serde(rename = "task.resume")]
    TaskResume(ChannelPeerTaskResume),
    #[serde(rename = "task.turnStart")]
    TaskTurnStart(ChannelPeerTaskTurnStart),
    #[serde(rename = "task.interrupt")]
    TaskInterrupt(ChannelPeerTaskInterrupt),
    #[serde(rename = "task.expert")]
    TaskExpert(ChannelPeerTaskExpert),
    #[serde(rename = "task.asyncQuestion")]
    TaskAsyncQuestion(ChannelPeerTaskAsyncQuestion),
    #[serde(rename = "task.command")]
    TaskCommand(ChannelPeerTaskCommand),
}
/// Resume is a finite original UI action, never permission to submit SDK input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskResume {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    #[serde(deserialize_with = "deserialize_original_task_resume")]
    pub resume: crate::ThreadResumeParams,
}
fn deserialize_original_task_resume<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::ThreadResumeParams, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StrictResume {
        thread_id: String,
        #[serde(default)]
        history: Option<crate::ThreadResumeHistoryOptionsV1>,
    }
    let value = StrictResume::deserialize(deserializer)?;
    Ok(crate::ThreadResumeParams {
        thread_id: value.thread_id,
        history: value.history,
    })
}
impl ChannelPeerTaskResume {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        atom(&self.resume.thread_id)?;
        if self.source_authority_epoch == 0
            || self
                .resume
                .history
                .as_ref()
                .is_some_and(|options| !options.is_valid())
        {
            return Err(invalid());
        }
        Ok(())
    }
}
/// Exact current grant locators on an already admitted original UI stream.
/// This observation cannot create a Main, grant access, or return resource contents.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskResourceFactRead {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    pub connection_ref: IntegrationRevisionRef,
    pub resource_refs: Vec<IntegrationTaskResourceRef>,
}
impl ChannelPeerTaskResourceFactRead {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        self.connection_ref.validate().map_err(|_| invalid())?;
        if self.resource_refs.is_empty() || self.resource_refs.len() > 100 {
            return Err(invalid());
        }
        let mut seen = std::collections::BTreeSet::new();
        for reference in &self.resource_refs {
            for value in [&reference.id, &reference.revision] {
                if value.is_empty() || value.chars().count() > 256 {
                    return Err(invalid());
                }
            }
            if !matches!(
                reference.kind.as_str(),
                "document" | "spreadsheet" | "mailbox" | "base" | "table"
            ) || !seen.insert((&reference.kind, &reference.id))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
/// Only original signed lease references enter this source-specific lane.
/// The native receiver revalidates its issuer/intent/current owner before use.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelPeerBackgroundCall {
    Attach {
        lease_ref: IntegrationRevisionRef,
        original_operation_id: String,
    },
    Read {
        lease_ref: IntegrationRevisionRef,
    },
    Stop {
        lease_ref: IntegrationRevisionRef,
        original_operation_id: String,
        expected_revision: u64,
    },
    /// Adopt only the exact already-approved successor. This is not fresh consent.
    Renew {
        predecessor_ref: IntegrationRevisionRef,
        successor_ref: IntegrationRevisionRef,
        original_operation_id: String,
        expected_revision: u64,
    },
    Revoke {
        lease_ref: IntegrationRevisionRef,
        original_operation_id: String,
        expected_revision: u64,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerInteractionOwner {
    pub stream: ChannelPeerStreamRef,
    pub request_id: ChannelPeerRequestId,
    pub thread_id: String,
    pub turn_id: String,
    pub interaction_id: String,
    pub interaction_revision: String,
    pub app_server_epoch: String,
}
/// The exact original receipt is mandatory even when the public compatibility
/// DTO permits omitted bindings. A new stream cannot answer an old numeric ID.
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelPeerInteractionResponse {
    Question {
        owner: ChannelPeerInteractionOwner,
        response: QuestionResponse,
    },
    Approval {
        owner: ChannelPeerInteractionOwner,
        response: ApprovalResponse,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelPeerClientFrame {
    AppServerUiRegister {
        registration: AppServerUiRegistration,
    },
    TaskUiRegister {
        registration: ChannelPeerTaskUiRegistration,
    },
    UiRegister {
        registration: ChannelPeerUiRegistration,
    },
    Initialize {
        admission_nonce: String,
        params: ChannelPeerInitialize,
    },
    BackgroundOpen {
        lease_ref: IntegrationRevisionRef,
        original_operation_id: String,
    },
    UiCall {
        stream: ChannelPeerStreamRef,
        sequence: u64,
        request_id: ChannelPeerRequestId,
        call: ChannelPeerUiCall,
    },
    BackgroundCall {
        stream: ChannelPeerStreamRef,
        sequence: u64,
        request_id: ChannelPeerRequestId,
        call: ChannelPeerBackgroundCall,
    },
    InteractionResponse {
        response: ChannelPeerInteractionResponse,
    },
    Close {
        stream: ChannelPeerStreamRef,
    },
}

/// Chosen by the actual native constructor/endpoint, never deserialized from a frame.
pub enum ChannelPeerLane {
    Ui,
    Background,
}
impl ChannelPeerLane {
    pub fn accepts(&self, frame: &ChannelPeerClientFrame) -> bool {
        match self {
            Self::Ui => matches!(
                frame,
                ChannelPeerClientFrame::UiRegister { .. }
                    | ChannelPeerClientFrame::AppServerUiRegister { .. }
                    | ChannelPeerClientFrame::TaskUiRegister { .. }
                    | ChannelPeerClientFrame::Initialize { .. }
                    | ChannelPeerClientFrame::UiCall { .. }
                    | ChannelPeerClientFrame::InteractionResponse { .. }
                    | ChannelPeerClientFrame::Close { .. }
            ),
            Self::Background => matches!(
                frame,
                ChannelPeerClientFrame::BackgroundOpen { .. }
                    | ChannelPeerClientFrame::BackgroundCall { .. }
                    | ChannelPeerClientFrame::Close { .. }
            ),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ChannelPeerReply {
    TaskStart(Box<ChannelPeerTaskCreationOutput>),
    TaskRead(Box<ChannelPeerTaskReadOutput>),
    Integration(IntegrationReply),
    TaskResources(serde_json::Value),
    TaskResume(Box<crate::ThreadResumeResult>),
    TaskTurnStart(crate::TurnStartResult),
    TaskInterrupted(ChannelPeerTaskInterrupted),
    TaskExpert(crate::ThreadExpertResult),
    TaskAsyncQuestion(ChannelPeerTaskAsyncQuestionResult),
    TaskCommand(Box<ChannelPeerTaskCommandOutput>),
    TaskRequestRejected(ChannelPeerTaskRequestRejected),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPeerFailure {
    Invalid,
    Unavailable,
    Rejected,
    Unknown,
    OwnerEnded,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPeerAdmissionStage {
    Register,
    Initialize,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelPeerServerFrame {
    AdmissionFailed {
        stage: ChannelPeerAdmissionStage,
        reason_sha256: Vec<String>,
    },
    UiRegistered {
        producer_nonce: String,
        admission_nonce: String,
    },
    Initialized {
        stream: ChannelPeerStreamRef,
        result: InitializeResult,
    },
    SourceOpened {
        stream: ChannelPeerStreamRef,
    },
    Reply {
        stream: ChannelPeerStreamRef,
        sequence: u64,
        request_id: ChannelPeerRequestId,
        result: ChannelPeerReply,
    },
    Failure {
        stream: ChannelPeerStreamRef,
        sequence: u64,
        request_id: ChannelPeerRequestId,
        failure: ChannelPeerFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason_sha256: Option<String>,
    },
    Question {
        owner: ChannelPeerInteractionOwner,
        params: QuestionRequestParams,
    },
    Approval {
        owner: ChannelPeerInteractionOwner,
        params: ApprovalRequestParams,
    },
    OwnerEnded {
        stream: ChannelPeerStreamRef,
    },
    /// Only original task notifications are forwarded; never requests/replies.
    TaskNotification {
        stream: ChannelPeerStreamRef,
        thread_id: String,
        notification: serde_json::Value,
    },
    TaskStreamEnded {
        stream: ChannelPeerStreamRef,
        thread_id: String,
    },
}
impl ChannelPeerServerFrame {
    pub fn validate(&self) -> Result<(), String> {
        if let Self::Failure {
            reason_sha256: Some(digest),
            ..
        } = self
            && (digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        {
            return Err(invalid());
        }
        match self {
            Self::TaskStreamEnded { stream, thread_id } => {
                stream.validate()?;
                atom(thread_id)
            }
            Self::TaskNotification {
                stream,
                thread_id,
                notification,
            } => {
                stream.validate()?;
                atom(thread_id)?;
                if !valid_task_notification(thread_id, notification) {
                    return Err(invalid());
                }
                Ok(())
            }
            Self::AdmissionFailed { reason_sha256, .. } => {
                if reason_sha256.is_empty()
                    || reason_sha256.len() > 6
                    || reason_sha256.iter().any(|digest| {
                        digest.len() != 64
                            || !digest
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                {
                    return Err(invalid());
                }
                Ok(())
            }
            Self::UiRegistered {
                producer_nonce,
                admission_nonce,
            } => {
                if [producer_nonce, admission_nonce].into_iter().any(|value| {
                    value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                }) {
                    return Err(invalid());
                }
                Ok(())
            }
            Self::Initialized { stream, .. }
            | Self::SourceOpened { stream }
            | Self::OwnerEnded { stream } => stream.validate(),
            Self::Reply {
                stream,
                sequence,
                request_id: id,
                ..
            }
            | Self::Failure {
                stream,
                sequence,
                request_id: id,
                ..
            } => {
                stream.validate()?;
                sequence_number(*sequence)?;
                request_id(id)
            }
            Self::Question { owner, params } => {
                owner.validate()?;
                if owner.thread_id != params.thread_id
                    || owner.turn_id != params.turn_id
                    || owner.interaction_id != params.question_id
                    || params.app_server_epoch.as_deref() != Some(owner.app_server_epoch.as_str())
                {
                    return Err(invalid());
                }
                Ok(())
            }
            Self::Approval { owner, params } => {
                owner.validate()?;
                if owner.thread_id != params.thread_id
                    || owner.turn_id != params.turn_id
                    || owner.interaction_id != params.approval_id
                    || params.app_server_epoch.as_deref() != Some(owner.app_server_epoch.as_str())
                {
                    return Err(invalid());
                }
                Ok(())
            }
        }
    }
    pub fn matches_reply(
        &self,
        expected: &ChannelPeerStreamRef,
        sequence: u64,
        id: &ChannelPeerRequestId,
    ) -> bool {
        match self {
            Self::Reply {
                stream,
                sequence: actual,
                request_id,
                ..
            }
            | Self::Failure {
                stream,
                sequence: actual,
                request_id,
                ..
            } => {
                stream == expected
                    && *actual == sequence
                    && request_id == id
                    && self.validate().is_ok()
            }
            _ => false,
        }
    }
}
impl ChannelPeerInteractionOwner {
    pub fn validate(&self) -> Result<(), String> {
        self.stream.validate()?;
        request_id(&self.request_id)?;
        for value in [
            &self.thread_id,
            &self.turn_id,
            &self.interaction_id,
            &self.interaction_revision,
            &self.app_server_epoch,
        ] {
            atom(value)?;
        }
        if self.app_server_epoch != self.stream.app_server_epoch {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ChannelPeerStreamRef {
    pub fn validate(&self) -> Result<(), String> {
        atom(&self.id)?;
        atom(&self.host_epoch)?;
        atom(&self.app_server_epoch)?;
        self.scope.validate().map_err(|_| invalid())
    }
}
impl ChannelPeerUiCall {
    pub fn scope(&self) -> &IntegrationScope {
        match self {
            Self::TaskStart(v) => &v.scope,
            Self::TaskRead(v) => &v.scope,
            Self::Connectivity(v) => &v.request.scope,
            Self::TaskResources(v) => &v.scope,
            Self::TaskResume(v) => &v.scope,
            Self::TaskTurnStart(v) => &v.scope,
            Self::TaskInterrupt(v) => &v.scope,
            Self::TaskExpert(v) => &v.scope,
            Self::TaskAsyncQuestion(v) => &v.scope,
            Self::TaskCommand(v) => &v.scope,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::TaskStart(value) => value.validate(),
            Self::TaskRead(value) => value.validate(),
            Self::Connectivity(call) => call.validate().map_err(|_| invalid()),
            Self::TaskResources(value) => value.validate(),
            Self::TaskResume(value) => value.validate(),
            Self::TaskTurnStart(value) => value.validate(),
            Self::TaskInterrupt(value) => value.validate(),
            Self::TaskExpert(value) => value.validate(),
            Self::TaskAsyncQuestion(value) => value.validate(),
            Self::TaskCommand(value) => value.validate(),
        }
    }
}
impl ChannelPeerInteractionResponse {
    pub fn matches_owner(&self, expected: &ChannelPeerInteractionOwner) -> bool {
        let owner = match self {
            Self::Question { owner, .. } | Self::Approval { owner, .. } => owner,
        };
        owner == expected && self.validate().is_ok()
    }
    pub fn validate(&self) -> Result<(), String> {
        let (owner, ids) = match self {
            Self::Question { owner, response } => (owner, response.binding()),
            Self::Approval { owner, response } => (owner, response.binding()),
        };
        owner.stream.validate()?;
        for value in [
            &owner.thread_id,
            &owner.turn_id,
            &owner.interaction_id,
            &owner.interaction_revision,
            &owner.app_server_epoch,
        ] {
            atom(value)?;
        }
        request_id(&owner.request_id)?;
        if owner.app_server_epoch != owner.stream.app_server_epoch
            || ids.0 != Some(owner.interaction_id.as_str())
            || ids.1 != Some(owner.thread_id.as_str())
            || ids.2 != Some(owner.turn_id.as_str())
        {
            return Err(invalid());
        }
        Ok(())
    }
}
impl ChannelPeerClientFrame {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::AppServerUiRegister { registration } => registration.validate(),
            Self::UiRegister { registration } => registration.validate(),
            Self::TaskUiRegister { registration } => registration.validate(),
            Self::Initialize {
                admission_nonce,
                params,
            } => {
                if admission_nonce.len() != 32
                    || !admission_nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(invalid());
                }
                params.validate()
            }
            Self::UiCall {
                stream,
                sequence,
                request_id: id,
                call,
            } => {
                stream.validate()?;
                sequence_number(*sequence)?;
                request_id(id)?;
                if call.scope() != &stream.scope {
                    return Err(invalid());
                }
                call.validate()
            }
            Self::BackgroundOpen {
                lease_ref,
                original_operation_id,
            } => {
                atom(original_operation_id)?;
                lease_ref.validate().map_err(|_| invalid())
            }
            Self::BackgroundCall {
                stream,
                sequence,
                request_id: id,
                call,
            } => {
                stream.validate()?;
                sequence_number(*sequence)?;
                request_id(id)?;
                let reference = match call {
                    ChannelPeerBackgroundCall::Read { lease_ref } => lease_ref,
                    ChannelPeerBackgroundCall::Renew {
                        predecessor_ref,
                        successor_ref,
                        original_operation_id,
                        expected_revision,
                    } => {
                        predecessor_ref.validate().map_err(|_| invalid())?;
                        successor_ref.validate().map_err(|_| invalid())?;
                        atom(original_operation_id)?;
                        sequence_number(*expected_revision)?;
                        if predecessor_ref.id == successor_ref.id {
                            return Err(invalid());
                        }
                        successor_ref
                    }
                    ChannelPeerBackgroundCall::Attach {
                        lease_ref,
                        original_operation_id,
                    } => {
                        atom(original_operation_id)?;
                        lease_ref
                    }
                    ChannelPeerBackgroundCall::Stop {
                        lease_ref,
                        original_operation_id,
                        expected_revision,
                    }
                    | ChannelPeerBackgroundCall::Revoke {
                        lease_ref,
                        original_operation_id,
                        expected_revision,
                    } => {
                        atom(original_operation_id)?;
                        sequence_number(*expected_revision)?;
                        lease_ref
                    }
                };
                reference.validate().map_err(|_| invalid())
            }
            Self::InteractionResponse { response } => response.validate(),
            Self::Close { stream } => stream.validate(),
        }
    }
}
fn atom(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn request_id(value: &ChannelPeerRequestId) -> Result<(), String> {
    match value {
        ChannelPeerRequestId::Number(_) => Ok(()),
        ChannelPeerRequestId::Text(value) => atom(value),
    }
}
fn sequence_number(value: u64) -> Result<(), String> {
    if (1..=9007199254740991).contains(&value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn invalid() -> String {
    "CHANNEL_PEER_FRAME_INVALID".into()
}
pub fn decode_channel_peer_frame(bytes: &[u8]) -> Result<ChannelPeerClientFrame, String> {
    if bytes.len() > CHANNEL_PEER_FRAME_BYTES {
        return Err(invalid());
    }
    let frame: ChannelPeerClientFrame = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    frame.validate()?;
    Ok(frame)
}
#[cfg(test)]
mod tests;

/// A finite UI configuration call, without input, role or permission overrides.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskExpert {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    pub expert: crate::ThreadExpertParams,
}
impl ChannelPeerTaskExpert {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        self.expert.validate().map_err(|_| invalid())
    }
}

fn valid_task_notification(thread: &str, frame: &serde_json::Value) -> bool {
    if frame.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
        || frame.get("id").is_some()
        || frame.get("result").is_some()
        || frame.get("error").is_some()
        || frame
            .get("params")
            .and_then(|p| p.get("threadId"))
            .and_then(serde_json::Value::as_str)
            != Some(thread)
    {
        return false;
    }
    let method = frame.get("method").and_then(serde_json::Value::as_str);
    matches!(
        method,
        Some(
            "item/started"
                | "item/completed"
                | "item/event"
                | "item/delta"
                | "turn/started"
                | "turn/completed"
                | "thread/goal/updated"
                | "asyncQuestion/changed"
        )
    ) || (method == Some("thread/started")
        && frame
            .get("params")
            .and_then(|p| p.get("thread"))
            .and_then(|t| t.get("id"))
            .and_then(serde_json::Value::as_str)
            == Some(thread))
}
