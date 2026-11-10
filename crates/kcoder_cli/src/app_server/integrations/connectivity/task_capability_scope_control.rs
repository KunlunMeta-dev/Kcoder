//! Finite source-selection control over original bindings and native authority.
mod authorization;
mod public;
mod storage;
#[cfg(test)]
pub(crate) use public::try_apply_pending;
pub(crate) use public::{NativeTaskCapabilityScopeControlTarget, apply_pending_binding};

use super::native_task_capability_scope::{
    NativeAcceptedTaskIdentity, NativeTaskCapabilityScopeBinding,
};
use crate::app_server::integrations::core::{
    NativeIntegrationContext,
    task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit,
};
use anyhow::{Context, Result, ensure};
pub(crate) use authorization::{
    NativeTaskCapabilityScopeAdmission, NativeTaskCapabilityScopeAuthorizationReceipt,
};
use kcoder_types::integrations::core::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
pub(crate) use storage::{
    NativeTaskCapabilityScopeControlPhase, NativeTaskCapabilityScopeControlReceipt,
};

/// Root registers these finite methods in the existing RPC dispatcher. This
/// module never resolves a latest task or accepts caller-provided native paths.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeTaskCapabilityScopeControlMethod {
    Read,
    Set,
    ReadOperation,
}
impl NativeTaskCapabilityScopeControlMethod {
    pub(crate) fn from_wire(method: &str) -> Option<Self> {
        match method {
            "readTaskSources" => Some(Self::Read),
            "setTaskSources" => Some(Self::Set),
            "readTaskSourceOperation" => Some(Self::ReadOperation),
            _ => None,
        }
    }
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Read => "readTaskSources",
            Self::Set => "setTaskSources",
            Self::ReadOperation => "readTaskSourceOperation",
        }
    }
}
fn hash<T: Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
