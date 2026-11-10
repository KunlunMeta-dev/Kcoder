//! Current organization authority from the privileged account supervisor.
//! The environment selects an inherited descriptor; Linux peer credentials,
//! the live parent and its current account store are the authentication proof.

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};

const CHANNEL_ENV: &str = "KCODER_PRIVATE_ORGANIZATION_FD_V1";

pub(super) struct OrganizationModelIdentity<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub origin: &'a str,
    pub revision: &'a str,
    pub resource: &'a str,
    pub workspace: &'a str,
}

#[derive(Debug)]
pub(super) struct OrganizationAuthority {
    #[cfg(target_os = "linux")]
    socket: Mutex<std::os::unix::net::UnixDatagram>,
    parent_pid: u32,
    pub(super) organization_id: String,
    pub(super) principal_id: String,
    identity_revision: u64,
}

impl OrganizationAuthority {
    pub(super) fn wiki_job_request(&self, request: Value) -> Result<Value> {
        self.verify()?;
        self.request(request)
    }
    pub(super) fn publication_request(
        &self,
        request: Value,
    ) -> Result<(Value, Option<std::fs::File>)> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            self.verify()?;
            let socket = self
                .socket
                .lock()
                .map_err(|_| anyhow::anyhow!("ORGANIZATION_CHANNEL_FAILED"))?;
            Self::verify_peer(socket.as_raw_fd(), self.parent_pid)?;
            let raw = serde_json::to_vec(&request)?;
            ensure!(
                raw.len() <= 8192 && socket.send(&raw)? == raw.len(),
                "ORGANIZATION_REQUEST_INCOMPLETE"
            );
            let mut bytes = [0u8; 8193];
            let mut control = [0usize; 8];
            let mut vector = libc::iovec {
                iov_base: bytes.as_mut_ptr().cast(),
                iov_len: bytes.len(),
            };
            let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
            message.msg_iov = &mut vector;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = std::mem::size_of_val(&control);
            let length =
                unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
            ensure!(length > 0, "ORGANIZATION_RESPONSE_INVALID");
            let mut files = Vec::new();
            let mut ancillary = unsafe { libc::CMSG_FIRSTHDR(&message) };
            while !ancillary.is_null() {
                let header = unsafe { &*ancillary };
                if header.cmsg_level == libc::SOL_SOCKET && header.cmsg_type == libc::SCM_RIGHTS {
                    let count = (header
                        .cmsg_len
                        .saturating_sub(unsafe { libc::CMSG_LEN(0) } as usize))
                        / std::mem::size_of::<i32>();
                    for index in 0..count {
                        let descriptor =
                            unsafe { *(libc::CMSG_DATA(ancillary).cast::<i32>().add(index)) };
                        // SAFETY: every descriptor in this SCM_RIGHTS frame is newly owned.
                        files.push(unsafe { std::fs::File::from_raw_fd(descriptor) });
                    }
                }
                ancillary = unsafe { libc::CMSG_NXTHDR(&message, ancillary) };
            }
            ensure!(
                length <= 8192
                    && message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) == 0
                    && files.len() <= 1,
                "ORGANIZATION_RESPONSE_INVALID"
            );
            let response: Value = serde_json::from_slice(&bytes[..length as usize])?;
            if response["ok"] != true {
                anyhow::bail!(match response["error"].as_str() {
                    Some("KNOWLEDGE_PUBLICATION_REVOKED") => "KNOWLEDGE_PUBLICATION_REVOKED",
                    Some("KNOWLEDGE_INVALID_CURSOR") => "KNOWLEDGE_INVALID_CURSOR",
                    Some("KNOWLEDGE_PUBLICATION_EXPIRED") => "KNOWLEDGE_PUBLICATION_EXPIRED",
                    Some("KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE") =>
                        "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE",
                    Some("KNOWLEDGE_PUBLICATION_NOT_FOUND") => "KNOWLEDGE_PUBLICATION_NOT_FOUND",
                    Some("KNOWLEDGE_INDEX_STALE") => "KNOWLEDGE_INDEX_STALE",
                    Some("KNOWLEDGE_PUBLICATION_CORRUPT") => "KNOWLEDGE_PUBLICATION_CORRUPT",
                    Some("KNOWLEDGE_SHARED_READER_UNAVAILABLE") =>
                        "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE",
                    _ => "KNOWLEDGE_RESOURCE_DENIED",
                });
            }
            ensure!(
                response.get("result").is_some(),
                "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"
            );
            Self::verify_peer(socket.as_raw_fd(), self.parent_pid)?;
            Ok((response["result"].clone(), files.pop()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = request;
            bail!("ORGANIZATION_OS_ISOLATION_UNSUPPORTED")
        }
    }
    pub(super) fn verify_personal_launch() -> Result<()> {
        #[cfg(target_os = "linux")]
        ensure!(
            Self::worker_marker()?.is_none(),
            "ORGANIZATION_GOVERNED_CHANNEL_REQUIRED"
        );
        Ok(())
    }
    pub(super) fn capture() -> Result<Option<Arc<Self>>> {
        static AUTHORITY: OnceLock<
            std::result::Result<Option<Arc<OrganizationAuthority>>, String>,
        > = OnceLock::new();
        match AUTHORITY.get_or_init(|| {
            Self::capture_once().map_err(|error| {
                let code = error.to_string();
                if code.starts_with("ORGANIZATION_") {
                    code
                } else {
                    "ORGANIZATION_NATIVE_AUTHORITY_UNAVAILABLE".into()
                }
            })
        }) {
            Ok(authority) => Ok(authority.clone()),
            Err(error) => bail!("{error}"),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn capture_once() -> Result<Option<Arc<Self>>> {
        ensure!(
            std::env::var_os(CHANNEL_ENV).is_none(),
            "ORGANIZATION_OS_ISOLATION_UNSUPPORTED"
        );
        Ok(None)
    }

    #[cfg(target_os = "linux")]
    fn capture_once() -> Result<Option<Arc<Self>>> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let marker = Self::worker_marker()?;
        let Some(descriptor) = std::env::var_os(CHANNEL_ENV) else {
            ensure!(marker.is_none(), "ORGANIZATION_GOVERNED_CHANNEL_REQUIRED");
            return Ok(None);
        };
        let marker = marker.context("ORGANIZATION_WORKER_BINDING_REQUIRED")?;
        let descriptor = descriptor
            .to_str()
            .context("ORGANIZATION_CHANNEL_INVALID")?
            .parse::<i32>()?;
        ensure!(descriptor >= 3, "ORGANIZATION_CHANNEL_INVALID");
        // Duplicating closes only this capability on drop. It cannot claim an
        // arbitrary caller-created socket because peer UID/PID are checked.
        let duplicated = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
        ensure!(duplicated >= 0, "ORGANIZATION_CHANNEL_UNAVAILABLE");
        let socket = unsafe { std::os::unix::net::UnixDatagram::from_raw_fd(duplicated) };
        let parent_pid = unsafe { libc::getppid() } as u32;
        ensure!(
            parent_pid != std::process::id(),
            "ORGANIZATION_PARENT_INVALID"
        );
        Self::verify_peer(socket.as_raw_fd(), parent_pid)?;
        socket.set_read_timeout(Some(std::time::Duration::from_secs(6)))?;
        socket.set_write_timeout(Some(std::time::Duration::from_secs(6)))?;
        let mut authority = Self {
            socket: Mutex::new(socket),
            parent_pid,
            organization_id: String::new(),
            principal_id: String::new(),
            identity_revision: 0,
        };
        let snapshot = authority.request(json!({"operation": "inspect"}))?;
        authority.organization_id = snapshot["organizationId"]
            .as_str()
            .context("ORGANIZATION_SNAPSHOT_INVALID")?
            .into();
        authority.principal_id = snapshot["principalId"]
            .as_str()
            .context("ORGANIZATION_SNAPSHOT_INVALID")?
            .into();
        authority.identity_revision = snapshot["identityRevision"]
            .as_u64()
            .context("ORGANIZATION_SNAPSHOT_INVALID")?;
        ensure!(
            !authority.organization_id.is_empty() && !authority.principal_id.is_empty(),
            "ORGANIZATION_SNAPSHOT_INVALID"
        );
        ensure!(
            marker["organizationId"] == authority.organization_id
                && marker["principalId"] == authority.principal_id
                && snapshot["workerUid"].as_u64() == Some(unsafe { libc::geteuid() } as u64)
                && snapshot["workerGid"].as_u64() == Some(unsafe { libc::getegid() } as u64),
            "ORGANIZATION_WORKER_BINDING_MISMATCH"
        );
        // Tool subprocesses do not inherit the runtime's authority descriptor.
        ensure!(
            unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "ORGANIZATION_CHANNEL_INVALID"
        );
        Ok(Some(Arc::new(authority)))
    }

    #[cfg(target_os = "linux")]
    fn worker_marker() -> Result<Option<Value>> {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let uid = unsafe { libc::geteuid() };
        if uid == 0 {
            return Ok(None);
        }
        let mut record: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 65536];
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut record,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        ensure!(
            status == 0 && !result.is_null() && !record.pw_dir.is_null(),
            "ORGANIZATION_OS_IDENTITY_UNAVAILABLE"
        );
        let home = unsafe { std::ffi::CStr::from_ptr(record.pw_dir) }.to_str()?;
        let home = std::path::Path::new(home);
        ensure!(home.is_absolute(), "ORGANIZATION_OS_HOME_INVALID");
        let parent = home.parent().context("ORGANIZATION_OS_HOME_INVALID")?;
        let path = parent.join(format!(".kcoder-organization-{uid}.json"));
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        for directory in parent.ancestors() {
            let info = std::fs::symlink_metadata(directory)?;
            ensure!(
                info.is_dir()
                    && info.uid() == 0
                    && (info.mode() & 0o022 == 0 || info.mode() & libc::S_ISVTX != 0),
                "ORGANIZATION_MARKER_PARENT_UNTRUSTED"
            );
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)?;
        let info = file.metadata()?;
        ensure!(
            info.is_file()
                && info.uid() == 0
                && info.mode() & 0o222 == 0
                && info.nlink() == 1
                && info.len() <= 4096,
            "ORGANIZATION_MARKER_UNTRUSTED"
        );
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        let marker: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            marker["version"] == 1
                && marker["workerUid"].as_u64() == Some(uid as u64)
                && marker["workerGid"].as_u64() == Some(unsafe { libc::getegid() } as u64),
            "ORGANIZATION_MARKER_INVALID"
        );
        Ok(Some(marker))
    }

    #[cfg(target_os = "linux")]
    fn verify_peer(descriptor: i32, parent_pid: u32) -> Result<()> {
        let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                descriptor,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut peer as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        ensure!(
            result == 0
                && length as usize == std::mem::size_of_val(&peer)
                && peer.uid == 0
                && peer.pid as u32 == parent_pid
                && unsafe { libc::geteuid() } >= 1000
                && unsafe { libc::getppid() } as u32 == parent_pid,
            "ORGANIZATION_NATIVE_PEER_UNTRUSTED"
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn request(&self, request: Value) -> Result<Value> {
        use std::os::fd::AsRawFd;
        let socket = self
            .socket
            .lock()
            .map_err(|_| anyhow::anyhow!("ORGANIZATION_CHANNEL_FAILED"))?;
        Self::verify_peer(socket.as_raw_fd(), self.parent_pid)?;
        let bytes = serde_json::to_vec(&request)?;
        ensure!(bytes.len() <= 8192, "ORGANIZATION_REQUEST_TOO_LARGE");
        ensure!(
            socket.send(&bytes)? == bytes.len(),
            "ORGANIZATION_REQUEST_INCOMPLETE"
        );
        let mut bytes = [0; 8193];
        let length = socket.recv(&mut bytes)?;
        ensure!(
            (1..=8192).contains(&length),
            "ORGANIZATION_RESPONSE_INVALID"
        );
        let response: Value = serde_json::from_slice(&bytes[..length])?;
        ensure!(
            response["ok"] == true && response.get("result").is_some(),
            "ORGANIZATION_AUTHORIZATION_DENIED"
        );
        Self::verify_peer(socket.as_raw_fd(), self.parent_pid)?;
        Ok(response["result"].clone())
    }

    #[cfg(not(target_os = "linux"))]
    fn request(&self, _request: Value) -> Result<Value> {
        bail!("ORGANIZATION_OS_ISOLATION_UNSUPPORTED")
    }

    pub(super) fn verify(&self) -> Result<u64> {
        let snapshot = self.request(json!({"operation": "inspect"}))?;
        ensure!(
            snapshot["organizationId"] == self.organization_id
                && snapshot["principalId"] == self.principal_id
                && snapshot["identityRevision"].as_u64() == Some(self.identity_revision),
            "ORGANIZATION_IDENTITY_REVOKED"
        );
        snapshot["policyRevision"]
            .as_u64()
            .context("ORGANIZATION_POLICY_INVALID")
    }

    pub(super) fn budget_request(&self, root_operation: &str, action: Value) -> Result<Value> {
        self.verify()?;
        let result = self.request(
            json!({"operation":"budget.request","rootOperationId":root_operation,"action":action}),
        )?;
        ensure!(
            result["organizationId"] == self.organization_id
                && result["principalId"] == self.principal_id,
            "ORGANIZATION_BUDGET_OWNER_CHANGED"
        );
        self.verify()?;
        Ok(result["reservation"].clone())
    }

    pub(super) fn authorize(
        &self,
        action: &str,
        resource_id: &str,
        request_id: &str,
    ) -> Result<()> {
        self.verify()?;
        let result = self.request(json!({"operation": "evaluate", "action": action,
            "resourceId": resource_id, "requestId": request_id}))?;
        ensure!(
            result["organizationId"] == self.organization_id
                && result["principalId"] == self.principal_id
                && result["allowed"] == true,
            "ORGANIZATION_RESOURCE_DENIED"
        );
        Ok(())
    }

    pub(super) fn authorize_model(
        &self,
        model: OrganizationModelIdentity<'_>,
        request_id: &str,
    ) -> Result<()> {
        let before = self.verify()?;
        let result = self.request(json!({
            "operation": "model.evaluate", "provider": model.provider, "model": model.model,
            "endpointOrigin": model.origin, "configurationRevision": model.revision,
            "workspaceResourceId": model.workspace, "modelResourceId": model.resource, "requestId": request_id,
        }))?;
        ensure!(
            result["organizationId"] == self.organization_id
                && result["principalId"] == self.principal_id
                && result["policyRevision"].as_u64() == Some(before)
                && result["allowed"] == true
                && self.verify()? == before,
            "ORGANIZATION_MODEL_DENIED"
        );
        Ok(())
    }
}
