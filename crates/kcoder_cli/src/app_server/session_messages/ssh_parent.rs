//! Peer-specific parent capture from the kernel, independent of retention and migration.
use anyhow::{Result, ensure};
use kcoder_app_protocol::cross_session_router::{PeerRouterIdentityV1, ssh_parent::*};
use std::sync::atomic::{AtomicBool, Ordering};

/// Startup selectors only. Neither variant is a transport authorization grant.
#[derive(Clone, Debug)]
pub(crate) enum PeerSshLaunch {
    KernelNonce(String),
    Enrolled(String),
}

/// Profile adoption can retire an existing legacy SSH connection too. The
/// marker is only a deny condition; the original kernel proof is still required.
pub(crate) struct LegacySshProfileFence {
    parent: std::sync::Arc<CapturedPeerSshParent>,
    profile: std::path::PathBuf,
}
impl LegacySshProfileFence {
    pub(crate) fn capture(
        parent: std::sync::Arc<CapturedPeerSshParent>,
        profile: &std::path::Path,
    ) -> Result<Self> {
        let fence = Self {
            parent,
            profile: profile.into(),
        };
        super::router_authority::PeerRouterTransportFence::verify(&fence)?;
        Ok(fence)
    }
}
impl super::router_authority::PeerRouterTransportFence for LegacySshProfileFence {
    fn verify(&self) -> Result<()> {
        self.parent.verify()?;
        ensure!(
            kcoder_host_transport::ssh_peer_pins::may_attempt_legacy_kernel_capture(&self.profile)?,
            "peer_ssh_legacy_lane_retired"
        );
        Ok(())
    }
}

/// Only startup can construct this value. A launch nonce alone grants no authority.
pub(crate) struct CapturedPeerSshParent {
    nonce: Option<String>,
    instance: String,
    active: AtomicBool,
    bound: AtomicBool,
    #[cfg(target_os = "linux")]
    kernel: linux::KernelSshParent,
}
impl CapturedPeerSshParent {
    pub(crate) fn capture(nonce: Option<&str>) -> Result<Self> {
        ensure!(
            nonce.is_none_or(valid_nonce),
            "peer_ssh_parent_invalid_nonce"
        );
        #[cfg(not(target_os = "linux"))]
        anyhow::bail!("peer_ssh_parent_unavailable");
        #[cfg(target_os = "linux")]
        {
            let captured = Self {
                nonce: nonce.map(str::to_owned),
                instance: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                active: AtomicBool::new(true),
                bound: AtomicBool::new(false),
                kernel: linux::KernelSshParent::capture()?,
            };
            captured.verify()?;
            Ok(captured)
        }
    }
    pub(crate) fn verify(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire),
            "peer_ssh_parent_closed"
        );
        #[cfg(target_os = "linux")]
        self.kernel.verify()?;
        Ok(())
    }
    pub(crate) fn ready(&self) -> bool {
        self.nonce.is_some() && self.verify().is_ok()
    }
    pub(crate) fn bound(&self) -> bool {
        self.bound.load(Ordering::Acquire) && self.ready()
    }
    pub(crate) fn close(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub(crate) fn bind(
        &self,
        request: PeerSshParentBindParamsV1,
        identity: PeerRouterIdentityV1,
    ) -> Result<PeerSshParentBindingV1> {
        request.validate().map_err(anyhow::Error::msg)?;
        self.verify()?;
        ensure!(
            self.nonce.as_ref() == Some(&request.nonce),
            "peer_ssh_parent_nonce_changed"
        );
        #[cfg(target_os = "linux")]
        let uid = self.kernel.uid();
        #[cfg(not(target_os = "linux"))]
        let uid = 0;
        let binding = PeerSshParentBindingV1 {
            version: 1,
            purpose: PEER_SSH_PARENT_PURPOSE.into(),
            nonce: request.nonce,
            process_instance: self.instance.clone(),
            account_uid: uid,
            identity,
        };
        binding.validate().map_err(anyhow::Error::msg)?;
        self.verify()?;
        self.bound.store(true, Ordering::Release);
        Ok(binding)
    }
}
impl super::router_authority::PeerRouterTransportFence for CapturedPeerSshParent {
    fn verify(&self) -> Result<()> {
        CapturedPeerSshParent::verify(self)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use anyhow::Context;
    use std::{
        fs::{self, File, Metadata},
        os::unix::fs::MetadataExt,
        path::Path,
    };
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Object {
        dev: u64,
        ino: u64,
        kind: u32,
    }
    impl Object {
        fn of(metadata: &Metadata) -> Self {
            Self {
                dev: metadata.dev(),
                ino: metadata.ino(),
                kind: metadata.mode() & libc::S_IFMT,
            }
        }
        fn stream(&self) -> bool {
            self.kind == libc::S_IFIFO || self.kind == libc::S_IFSOCK
        }
    }
    #[derive(Clone, PartialEq, Eq)]
    struct Process {
        pid: u32,
        ppid: u32,
        start: u64,
        uid: u32,
        real_uid: u32,
    }
    fn process(pid: u32) -> Result<Process> {
        let root = format!("/proc/{pid}");
        let stat = fs::read_to_string(format!("{root}/stat"))?;
        let fields: Vec<_> = stat
            .rsplit_once(')')
            .context("peer_ssh_parent_invalid_process")?
            .1
            .split_whitespace()
            .collect();
        ensure!(fields.len() >= 20, "peer_ssh_parent_invalid_process");
        let status = fs::read_to_string(format!("{root}/status"))?;
        let uids: Vec<_> = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .context("peer_ssh_parent_uid_unavailable")?
            .split_whitespace()
            .collect();
        ensure!(uids.len() == 4, "peer_ssh_parent_uid_unavailable");
        Ok(Process {
            pid,
            ppid: fields[1].parse()?,
            start: fields[19].parse()?,
            uid: uids[1].parse()?,
            real_uid: uids[0].parse()?,
        })
    }
    fn secure_image(path: &Path) -> Result<File> {
        let path = fs::canonicalize(path)?;
        let mut parent = Some(path.as_path());
        while let Some(current) = parent {
            let metadata = fs::metadata(current)?;
            ensure!(metadata.uid() == 0, "peer_ssh_parent_untrusted_image");
            parent = current.parent();
        }
        let file = File::open(path)?;
        ensure!(
            file.metadata()?.is_file(),
            "peer_ssh_parent_untrusted_image"
        );
        Ok(file)
    }
    fn held_stdio(pid: u32, stdin: Object, stdout: Object) -> Result<()> {
        let mut input = false;
        let mut output = false;
        let entries = fs::read_dir(format!("/proc/{pid}/fd"))?;
        for (index, entry) in entries.enumerate() {
            ensure!(index < 4096, "peer_ssh_parent_fd_capacity");
            let entry = entry?;
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            let object = Object::of(&metadata);
            input |= object == stdin;
            output |= object == stdout;
            if input && output {
                return Ok(());
            }
        }
        anyhow::bail!("peer_ssh_parent_stdio_unowned")
    }
    pub(super) struct KernelSshParent {
        own: Process,
        chain: Vec<Process>,
        image: File,
        stdin: Object,
        stdout: Object,
    }
    impl KernelSshParent {
        pub(super) fn uid(&self) -> u32 {
            self.own.uid
        }
        pub(super) fn capture() -> Result<Self> {
            let own = process(std::process::id())?;
            ensure!(
                own.uid == unsafe { libc::geteuid() }
                    && own.real_uid == unsafe { libc::getuid() }
                    && own.uid == own.real_uid,
                "peer_ssh_parent_account_changed"
            );
            let stdin = Object::of(&fs::metadata("/proc/self/fd/0")?);
            let stdout = Object::of(&fs::metadata("/proc/self/fd/1")?);
            ensure!(
                stdin.stream() && stdout.stream(),
                "peer_ssh_parent_stdio_unavailable"
            );
            let mut chain = Vec::new();
            let mut next = own.ppid;
            for _ in 0..4 {
                let parent = process(next)?;
                ensure!(
                    parent.uid == own.uid && parent.real_uid == own.real_uid,
                    "peer_ssh_parent_account_changed"
                );
                let observed = Object::of(&fs::metadata(format!("/proc/{next}/exe"))?);
                let image = [
                    "/usr/sbin/sshd",
                    "/usr/local/sbin/sshd",
                    "/usr/lib/openssh/sshd-session",
                    "/usr/libexec/openssh/sshd-session",
                ]
                .iter()
                .filter_map(|path| secure_image(Path::new(path)).ok())
                .find(|file| {
                    file.metadata()
                        .is_ok_and(|metadata| Object::of(&metadata) == observed)
                });
                next = parent.ppid;
                chain.push(parent);
                if let Some(image) = image {
                    held_stdio(chain.last().expect("captured parent").pid, stdin, stdout)?;
                    let captured = Self {
                        own,
                        chain,
                        image,
                        stdin,
                        stdout,
                    };
                    captured.verify()?;
                    return Ok(captured);
                }
            }
            anyhow::bail!("peer_ssh_parent_unavailable")
        }
        pub(super) fn verify(&self) -> Result<()> {
            ensure!(
                process(self.own.pid)? == self.own,
                "peer_ssh_parent_process_changed"
            );
            for parent in &self.chain {
                ensure!(
                    process(parent.pid)? == *parent,
                    "peer_ssh_parent_process_changed"
                );
            }
            let parent = self.chain.last().context("peer_ssh_parent_unavailable")?;
            ensure!(
                Object::of(&fs::metadata(format!("/proc/{}/exe", parent.pid))?)
                    == Object::of(&self.image.metadata()?)
                    && Object::of(&fs::metadata("/proc/self/fd/0")?) == self.stdin
                    && Object::of(&fs::metadata("/proc/self/fd/1")?) == self.stdout,
                "peer_ssh_parent_stdio_changed"
            );
            held_stdio(parent.pid, self.stdin, self.stdout)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_ordinary_local_process_cannot_claim_an_ssh_parent() {
        assert!(CapturedPeerSshParent::capture(Some(&"a".repeat(64))).is_err());
    }
}
