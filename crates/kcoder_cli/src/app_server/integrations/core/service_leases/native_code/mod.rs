//! Native saved-code background service. Channel Host deployment remains separate.
mod approval;
pub(super) use kcoder_host_transport::native_code_diagnostics as diagnostics;
pub(crate) mod entry;
mod launch;
pub(crate) mod manager;
mod owner;
pub(crate) mod rpc;
mod runtime;
mod source;
#[cfg(target_os = "linux")]
mod worker;
pub(crate) use approval::NativeCodeServiceApproval;
pub(crate) use owner::NativeCodeServiceOwner;
use source::NativeSavedCodeSource;

use super::{NativeIntegrationContext, NativeServiceLeases, now};
use anyhow::Result;
use kcoder_types::integrations::core::*;
