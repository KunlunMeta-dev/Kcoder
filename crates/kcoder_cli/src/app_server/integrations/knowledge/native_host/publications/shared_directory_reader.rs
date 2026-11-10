//! A current-PDP allowlist is metadata authority, never a caller-supplied body or path.
use super::{resource_id, same_account_other_workspace};
use anyhow::{Result, ensure};
use kcoder_knowledge::integrations::knowledge::{PublicationAccess, PublicationAction};
use kcoder_types::integrations::{
    core::{IntegrationNullable, IntegrationScope},
    knowledge::KnowledgeOwner,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::{
    fs::File,
    io::{Read, Write},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    directory: bool,
    request_id: String,
    organization_id: String,
    publisher_principal_id: String,
    reader_scope: IntegrationScope,
    owner: KnowledgeOwner,
    mode: String,
    after: Option<String>,
    allowlist_bytes: u64,
    allowlist_sha256: String,
    expected_sha256: Option<String>,
}
struct Allowed<'a> {
    request: &'a Request,
    resources: BTreeSet<String>,
}
impl PublicationAccess for Allowed<'_> {
    fn check(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        action: PublicationAction,
    ) -> Result<bool> {
        ensure!(
            caller == &self.request.reader_scope,
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH"
        );
        if owner != &self.request.owner || action != PublicationAction::Read {
            return Ok(false);
        }
        Ok(self
            .resources
            .contains(&resource_id("publication", owner, id)?))
    }
}

#[cfg(target_os = "linux")]
pub(super) fn read(raw: &[u8], metadata: File) -> Result<(Value, Option<File>)> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    };
    let request: Request = serde_json::from_slice(raw)?;
    request.reader_scope.validate()?;
    ensure!(
        request.directory
            && matches!(request.mode.as_str(), "inspect" | "list" | "verify")
            && request.reader_scope.organization_id
                == Some(IntegrationNullable::Value(request.organization_id.clone()))
            && request.owner.organization_id == request.reader_scope.organization_id
            && (request.owner.account_id != request.reader_scope.account_id
                || same_account_other_workspace(&request.owner, &request.reader_scope)),
        "KNOWLEDGE_RESOURCE_DENIED"
    );
    let info = metadata.metadata()?;
    let required = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    let seals = unsafe { libc::fcntl(metadata.as_raw_fd(), libc::F_GET_SEALS) };
    ensure!(
        info.is_file()
            && info.uid() == 0
            && info.mode() & 0o777 == 0o600
            && info.nlink() == 0
            && info.len() == request.allowlist_bytes
            && (2..=4 * 1024 * 1024).contains(&request.allowlist_bytes)
            && seals >= 0
            && seals & required == required,
        "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
    );
    let mut bytes = Vec::new();
    metadata.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == request.allowlist_sha256,
        "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
    );
    let resources: BTreeSet<String> = serde_json::from_slice(&bytes)?;
    ensure!(
        resources.len() <= 10000
            && resources.iter().all(|key| key.len() == 74
                && key.starts_with("knowledge:")
                && key[10..]
                    .bytes()
                    .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())),
        "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
    );
    let access = Allowed {
        request: &request,
        resources,
    };
    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    let ((page, epoch, transition), facts) = super::publisher_catalog::with_catalog(
        &request.owner,
        &request.publisher_principal_id,
        |catalog| {
            let page = catalog.list_shared_native_publications(
                &request.reader_scope,
                &request.owner,
                &access,
                request.after.as_deref(),
                now,
            )?;
            let (epoch, transition) = catalog.publication_listing_time_snapshot(now)?;
            Ok((page, epoch, transition))
        },
    )?;
    ensure!(
        transition
            .is_none_or(|time| u64::try_from(chrono::Utc::now().timestamp_millis())
                .is_ok_and(|now| now < time)),
        "KNOWLEDGE_INVALID_CURSOR"
    );
    let visible = !page.items.is_empty();
    let raw = serde_json::to_vec(&page)?;
    ensure!(raw.len() <= 768 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
    let sha256 = format!("{:x}", Sha256::digest(&raw));
    if let Some(expected) = &request.expected_sha256 {
        ensure!(expected == &sha256, "KNOWLEDGE_INVALID_CURSOR");
    }
    let body = if request.mode == "list" {
        let descriptor = unsafe {
            libc::memfd_create(
                c"kcoder-shared-directory".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        ensure!(descriptor >= 0, "KNOWLEDGE_SHARED_READER_UNAVAILABLE");
        // SAFETY: memfd_create returned a new anonymous descriptor owned by this read.
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        ensure!(
            unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } == 0,
            "KNOWLEDGE_SHARED_READER_UNAVAILABLE"
        );
        file.write_all(&raw)?;
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        ensure!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, required) } == 0,
            "KNOWLEDGE_SHARED_READER_UNAVAILABLE"
        );
        Some(file)
    } else {
        None
    };
    Ok((
        json!({"format":"kcoder-shared-directory/1","requestId":request.request_id,"owner":request.owner,
        "publisherUid":unsafe {libc::geteuid()},"bodySha256":sha256,"bodyBytes":raw.len(),"hasItems":visible,
        "identityGeneration":facts.generation,"identityRevision":facts.revision,"sourceIdentitySha256":facts.proof.source_identity_sha256,
        "timeEpoch":epoch,"nextTransitionMs":transition,"mode":request.mode}),
        body,
    ))
}

#[cfg(not(target_os = "linux"))]
pub(super) fn read(_raw: &[u8], _metadata: File) -> Result<(Value, Option<File>)> {
    anyhow::bail!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE")
}
