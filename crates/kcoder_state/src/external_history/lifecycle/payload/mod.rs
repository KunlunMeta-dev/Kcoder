//! Payload ownership is sharded by born node; scans never supply missing birth authority.
use super::*;
use crate::external_history::{ExternalHistoryReader, valid_hash};
use kcoder_config::{PortableLeaseIdentity, VerifiedPrivateLease};
use std::{
    collections::BTreeMap,
    io::{Seek, SeekFrom},
};
mod collect;
mod model;
mod publish;
pub(super) use collect::{PayloadCollection, PayloadPlanAnchor, reopen, snapshot};
mod store;
pub(super) use model::PayloadAnchor;
use model::*;

pub(crate) enum PayloadLease {
    Legacy(std::fs::File),
    Managed(Box<VerifiedPrivateLease>),
}
impl PayloadLease {
    pub fn file(&self) -> &std::fs::File {
        match self {
            Self::Legacy(file) => file,
            Self::Managed(lease) => lease.file(),
        }
    }
}
impl std::ops::Deref for PayloadLease {
    type Target = std::fs::File;
    fn deref(&self) -> &Self::Target {
        self.file()
    }
}
pub(crate) struct PayloadDirectory {
    pub directory: PrivateDirectory,
    pub node: Option<PayloadNode>,
}
impl std::ops::Deref for PayloadDirectory {
    type Target = PrivateDirectory;
    fn deref(&self) -> &PrivateDirectory {
        &self.directory
    }
}
impl PayloadDirectory {
    pub fn lock(&self, name: &str) -> Result<PayloadLease> {
        match &self.node {
            Some(node) => node.lock_control(&self.directory, name),
            None => self
                .directory
                .try_exclusive_lock(OsStr::new(name))?
                .map(PayloadLease::Legacy)
                .context("history_attachment_busy"),
        }
    }
}
pub(crate) struct PayloadNode {
    _guard: ArchiveReadGuard,
    tree: PrivateDirectory,
    header: Header,
    key: String,
    path: String,
    directory: String,
    lease: PortableLeaseIdentity,
}
fn node_key(path: &str) -> String {
    format!("node-{}", crate::external_history::hash(path.as_bytes()))
}
fn file_digest(
    directory: &PrivateDirectory,
    file: &std::fs::File,
    check: &mut impl FnMut() -> bool,
) -> Result<FileProof> {
    ensure!(check(), "external_history_lifecycle_cancelled");
    let identity = directory.portable_regular_handle_identity(file)?;
    let bytes = file.metadata()?.len();
    ensure!(
        bytes <= 256 * 1024 * 1024,
        "external_history_payload_budget_exceeded"
    );
    let mut input = file.try_clone()?;
    input.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut read = 0;
    let mut buffer = [0; 64 * 1024];
    while read < bytes {
        ensure!(check(), "external_history_lifecycle_cancelled");
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        read += count as u64;
        ensure!(read <= bytes, "external_history_payload_changed");
        digest.update(&buffer[..count]);
    }
    ensure!(
        read == bytes
            && file.metadata()?.len() == bytes
            && directory.portable_regular_handle_identity(file)? == identity,
        "external_history_payload_changed"
    );
    Ok(FileProof {
        name: String::new(),
        identity,
        bytes,
        sha256: format!("{:x}", digest.finalize()),
    })
}
