//! Only finite original task operations enter the held UI task queue.
use super::*;
use kcoder_app_protocol::integrations::channel_peer::{
    ChannelPeerTaskInterrupt, ChannelPeerTaskTurnStart,
};
use kcoder_types::integrations::core::{IntegrationRevisionRef, IntegrationScope};

// Short-lived and moved once; boxing the large variant buys nothing here.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub(in crate::app_server) enum NativeUiTaskCall {
    Start(ChannelPeerTaskTurnStart),
    Interrupt(ChannelPeerTaskInterrupt),
    Expert(kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskExpert),
    AsyncQuestion(kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskAsyncQuestion),
    Command(kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskCommand),
}
impl NativeUiTaskCall {
    pub(in crate::app_server) fn thread_id(&self) -> &str {
        match self {
            Self::Start(input) => &input.turn.thread_id,
            Self::Interrupt(input) => &input.thread_id,
            Self::Expert(input) => &input.expert.thread_id,
            Self::AsyncQuestion(input) => input.thread_id(),
            Self::Command(input) => input.operation.thread_id(),
        }
    }
    pub(in crate::app_server) fn scope(&self) -> &IntegrationScope {
        match self {
            Self::Start(input) => &input.scope,
            Self::Interrupt(input) => &input.scope,
            Self::Expert(input) => &input.scope,
            Self::AsyncQuestion(input) => &input.scope,
            Self::Command(input) => &input.scope,
        }
    }
    pub(in crate::app_server) fn source_epoch(&self) -> u64 {
        match self {
            Self::Start(input) => input.source_authority_epoch,
            Self::Interrupt(input) => input.source_authority_epoch,
            Self::Expert(input) => input.source_authority_epoch,
            Self::AsyncQuestion(input) => input.source_authority_epoch,
            Self::Command(input) => input.source_authority_epoch,
        }
    }
    pub(in crate::app_server) fn binding(&self) -> &Option<IntegrationRevisionRef> {
        match self {
            Self::Start(input) => &input.binding_ref,
            Self::Interrupt(input) => &input.binding_ref,
            Self::Expert(input) => &input.binding_ref,
            Self::AsyncQuestion(input) => &input.binding_ref,
            Self::Command(input) => &input.binding_ref,
        }
    }
    pub(in crate::app_server) fn validate(&self) -> Result<()> {
        match self {
            Self::Start(input) => input.validate(),
            Self::Interrupt(input) => input.validate(),
            Self::Expert(input) => input.validate(),
            Self::AsyncQuestion(input) => input.validate(),
            Self::Command(input) => input.validate(),
        }
        .map_err(anyhow::Error::msg)
    }
    pub(super) fn original(&self) -> Result<(&'static str, Value)> {
        match self {
            Self::Expert(input) => Ok((
                kcoder_app_protocol::METHOD_THREAD_EXPERT,
                serde_json::to_value(&input.expert)?,
            )),
            Self::Start(input) => Ok((
                "turn/start",
                serde_json::to_value(input.original().map_err(anyhow::Error::msg)?)?,
            )),
            Self::Interrupt(input) => Ok((
                "turn/interrupt",
                serde_json::to_value(input.original().map_err(anyhow::Error::msg)?)?,
            )),
            Self::AsyncQuestion(input) => Ok((input.method(), input.params()?)),
            Self::Command(input) => Ok(input.operation.original()?),
        }
    }
}
