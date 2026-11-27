//! One root-authenticated read of an existing finalized publication as its real OS owner.
#[cfg(target_os = "linux")]
use super::same_account_other_workspace;
use anyhow::Result;
#[cfg(target_os = "linux")]
use anyhow::ensure;
#[cfg(target_os = "linux")]
use kcoder_types::integrations::{
    core::{IntegrationNullable, IntegrationScope},
    knowledge::{KnowledgeOwner, KnowledgeVisibility},
};
#[cfg(target_os = "linux")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use std::{fs::File, io::Write};

#[cfg(target_os = "linux")]
const CONTROL_ENV: &str = "KCODER_PRIVATE_SHARED_PUBLICATION_FD_V1";

#[cfg(target_os = "linux")]
pub fn run() -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let descriptor: i32 = std::env::var(CONTROL_ENV)?.parse()?;
    ensure!(
        descriptor >= 3 && unsafe { libc::geteuid() } >= 1000,
        "KNOWLEDGE_SHARED_READER_PEER_REQUIRED"
    );
    let descriptor = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
    ensure!(descriptor >= 0, "KNOWLEDGE_SHARED_READER_PEER_REQUIRED");
    // SAFETY: fcntl returned a new owned descriptor; no path grants authority.
    let socket = unsafe { std::os::unix::net::UnixDatagram::from_raw_fd(descriptor) };
    let parent = unsafe { libc::getppid() };
    let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
    let mut peer_length = std::mem::size_of_val(&peer) as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut peer as *mut libc::ucred).cast(),
                &mut peer_length,
            )
        } == 0
            && peer.uid == 0
            && peer.pid == parent,
        "KNOWLEDGE_SHARED_READER_PEER_REQUIRED"
    );
    // A dead owner cannot leave this fixed, non-spawning reader behind.
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } == 0
            && unsafe { libc::getppid() } == parent,
        "KNOWLEDGE_SHARED_READER_OWNER_LOST"
    );
    socket.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(3)))?;
    let (bytes, mut files) = receive_control(&socket)?;
    let outcome = (|| -> Result<_> {
        let envelope: Value = serde_json::from_slice(&bytes)?;
        if envelope["directory"] == true {
            ensure!(files.len() == 1, "KNOWLEDGE_DIRECTORY_METADATA_INVALID");
            super::shared_directory_reader::read(&bytes, files.pop().unwrap())
        } else {
            ensure!(files.is_empty(), "KNOWLEDGE_SHARED_READER_INVALID_REQUEST");
            read_fixed(&bytes)
        }
    })();
    let (response, body) = match outcome {
        Ok((metadata, body)) => (json!({"ok":true,"result":metadata}), body),
        Err(error) => (
            json!({"ok":false,"error":match error.to_string().as_str() {
                "KNOWLEDGE_PUBLICATION_REVOKED" => "KNOWLEDGE_PUBLICATION_REVOKED",
                "KNOWLEDGE_PUBLICATION_EXPIRED" => "KNOWLEDGE_PUBLICATION_EXPIRED",
                "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE" => "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE",
                "KNOWLEDGE_PUBLICATION_NOT_FOUND" => "KNOWLEDGE_PUBLICATION_NOT_FOUND",
                "KNOWLEDGE_INDEX_STALE" => "KNOWLEDGE_INDEX_STALE",
                "KNOWLEDGE_PUBLICATION_CORRUPT" => "KNOWLEDGE_PUBLICATION_CORRUPT",
                "KNOWLEDGE_INVALID_CURSOR" => "KNOWLEDGE_INVALID_CURSOR",
                "KNOWLEDGE_SHARED_READER_NOT_SHARED" => "KNOWLEDGE_RESOURCE_DENIED",
                _ => "KNOWLEDGE_SHARED_READER_UNAVAILABLE",
            }}),
            None,
        ),
    };
    let raw = serde_json::to_vec(&response)?;
    let mut vector = libc::iovec {
        iov_base: raw.as_ptr().cast_mut().cast(),
        iov_len: raw.len(),
    };
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    let mut ancillary = [0usize; 4];
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    if let Some(body) = &body {
        message.msg_control = ancillary.as_mut_ptr().cast();
        message.msg_controllen =
            unsafe { libc::CMSG_SPACE(std::mem::size_of::<i32>() as u32) } as usize;
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        ensure!(!header.is_null(), "KNOWLEDGE_SHARED_READER_RESPONSE_FAILED");
        unsafe {
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as usize;
            *libc::CMSG_DATA(header).cast::<i32>() = body.as_raw_fd();
        }
    }
    ensure!(
        unsafe { libc::sendmsg(socket.as_raw_fd(), &message, libc::MSG_NOSIGNAL) }
            == raw.len() as isize,
        "KNOWLEDGE_SHARED_READER_RESPONSE_FAILED"
    );
    ensure!(
        response["ok"] == true,
        "KNOWLEDGE_SHARED_READER_UNAVAILABLE"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn receive_control(socket: &std::os::unix::net::UnixDatagram) -> Result<(Vec<u8>, Vec<File>)> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let mut bytes = [0u8; 8193];
    let mut ancillary = [0usize; 8];
    let mut vector = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&ancillary);
    let length = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
    ensure!(length > 0, "KNOWLEDGE_SHARED_READER_INVALID_REQUEST");
    let mut files = Vec::new();
    let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    while !header.is_null() {
        let value = unsafe { &*header };
        if value.cmsg_level == libc::SOL_SOCKET && value.cmsg_type == libc::SCM_RIGHTS {
            let count = value
                .cmsg_len
                .saturating_sub(unsafe { libc::CMSG_LEN(0) } as usize)
                / std::mem::size_of::<i32>();
            for index in 0..count {
                let descriptor = unsafe { *libc::CMSG_DATA(header).cast::<i32>().add(index) };
                // SAFETY: SCM_RIGHTS transfers a new owned descriptor in this frame.
                files.push(unsafe { File::from_raw_fd(descriptor) });
            }
        }
        header = unsafe { libc::CMSG_NXTHDR(&message, header) };
    }
    ensure!(
        length <= 8192
            && message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) == 0
            && files.len() <= 1,
        "KNOWLEDGE_SHARED_READER_INVALID_REQUEST"
    );
    Ok((bytes[..length as usize].to_vec(), files))
}

#[cfg(not(target_os = "linux"))]
pub fn run() -> Result<()> {
    anyhow::bail!("KNOWLEDGE_SHARED_READER_PLATFORM_UNAVAILABLE")
}

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    request_id: String,
    organization_id: String,
    publisher_principal_id: String,
    reader_scope: IntegrationScope,
    owner: KnowledgeOwner,
    publication_id: String,
    version: u64,
    usage: String,
    expected_sha256: Option<String>,
    retrieval: Option<Retrieval>,
}

#[cfg(target_os = "linux")]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retrieval {
    query: String,
    limit: usize,
    observed_at_ms: u64,
}

#[cfg(target_os = "linux")]
struct FixedAccess<'a>(&'a Request);
#[cfg(target_os = "linux")]
impl kcoder_knowledge::integrations::knowledge::PublicationAccess for FixedAccess<'_> {
    fn check(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        action: kcoder_knowledge::integrations::knowledge::PublicationAction,
    ) -> Result<bool> {
        Ok(caller == &self.0.reader_scope
            && owner == &self.0.owner
            && id == self.0.publication_id
            && action == kcoder_knowledge::integrations::knowledge::PublicationAction::Read)
    }
}

#[cfg(target_os = "linux")]
fn read_fixed(raw: &[u8]) -> Result<(Value, Option<File>)> {
    use sha2::{Digest, Sha256};
    use std::os::fd::{AsRawFd, FromRawFd};
    let request: Request = serde_json::from_slice(raw)?;
    if let Some(query) = &request.retrieval {
        ensure!(
            !query.query.trim().is_empty()
                && query.query.len() <= 4096
                && (1..=20).contains(&query.limit)
                && request.usage == "use",
            "KNOWLEDGE_INVALID_QUERY"
        );
    }
    request.reader_scope.validate()?;
    ensure!(
        request.version > 0
            && matches!(request.usage.as_str(), "read" | "use")
            && request.owner.organization_id
                == Some(IntegrationNullable::Value(request.organization_id.clone()))
            && request.reader_scope.organization_id == request.owner.organization_id
            && (request.reader_scope.account_id != request.owner.account_id
                || same_account_other_workspace(&request.owner, &request.reader_scope))
            && std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID").ok().as_deref()
                == Some(&request.publisher_principal_id),
        "KNOWLEDGE_SHARED_READER_REFERENCE_DENIED"
    );
    let ((publication, retrieval), facts) = super::publisher_catalog::with_catalog(
        &request.owner,
        &request.publisher_principal_id,
        |catalog| {
            let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
            let publication = catalog.resolve_publication(
                &request.reader_scope,
                &request.owner,
                &request.publication_id,
                Some(request.version),
                &FixedAccess(&request),
                now,
            )?;
            let retrieval = request
                .retrieval
                .as_ref()
                .map(|query| {
                    let mut value = catalog.retrieve_publication(
                        &request.reader_scope,
                        &request.owner,
                        &request.publication_id,
                        request.version,
                        &query.query,
                        query.limit,
                        &FixedAccess(&request),
                        now,
                    )?;
                    // This is result identity, never an authority or expiry clock.
                    value.observed_at_ms = query.observed_at_ms;
                    Ok::<_, anyhow::Error>(value)
                })
                .transpose()?;
            Ok((publication, retrieval))
        },
    )?;
    ensure!(
        publication.draft.visibility != KnowledgeVisibility::Personal
            && publication
                .draft
                .audience_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
            && !publication.revoked,
        "KNOWLEDGE_SHARED_READER_NOT_SHARED"
    );
    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    ensure!(
        publication
            .draft
            .valid_from_ms
            .is_none_or(|time| now >= time)
            && publication
                .draft
                .valid_until_ms
                .is_none_or(|time| now < time),
        "KNOWLEDGE_PUBLICATION_EXPIRED"
    );
    let publication_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&publication)?));
    let raw = if let Some(value) = retrieval {
        serde_json::to_vec(&value)?
    } else {
        serde_json::to_vec(&publication)?
    };
    ensure!(raw.len() <= 512 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
    let sha256 = format!("{:x}", Sha256::digest(&raw));
    if let Some(expected) = &request.expected_sha256 {
        ensure!(
            expected == &sha256,
            "KNOWLEDGE_SHARED_READER_SOURCE_CHANGED"
        );
    }
    let body = if request.expected_sha256.is_none() {
        let descriptor = unsafe {
            libc::memfd_create(
                c"kcoder-shared-publication".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        ensure!(
            descriptor >= 0,
            "KNOWLEDGE_SHARED_READER_BUFFER_UNAVAILABLE"
        );
        // SAFETY: memfd_create returned a new private anonymous descriptor.
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        file.write_all(&raw)?;
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        ensure!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } == 0,
            "KNOWLEDGE_SHARED_READER_BUFFER_UNAVAILABLE"
        );
        Some(file)
    } else {
        None
    };
    Ok((
        json!({"format":"kcoder-shared-publication/1","requestId":request.request_id,
        "organizationId":request.organization_id,"owner":request.owner,"publicationId":request.publication_id,
        "version":request.version,"bodySha256":sha256,"bodyBytes":raw.len(),"publisherUid":unsafe {libc::geteuid()},
        "payloadKind":if request.retrieval.is_some() {"retrieval"} else {"publication"},"publicationSha256":publication_sha256,"retrieval":request.retrieval,
        "identityGeneration":facts.generation,"identityRevision":facts.revision,
        "sourceIdentitySha256":facts.proof.source_identity_sha256}),
        body,
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixDatagram;

    #[test]
    fn control_datagram_keeps_the_original_byte_limit() {
        let (reader, writer) = UnixDatagram::pair().unwrap();
        let allowed = vec![b'a'; 8192];
        writer.send(&allowed).unwrap();
        let (received, files) = receive_control(&reader).unwrap();
        assert_eq!(received, allowed);
        assert!(files.is_empty());
        writer.send(&[b'a'; 8193]).unwrap();
        assert_eq!(
            receive_control(&reader).unwrap_err().to_string(),
            "KNOWLEDGE_SHARED_READER_INVALID_REQUEST"
        );
    }
}
