use super::*;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;

pub struct OfficeReadWorker {
    program: PathBuf,
}
impl OfficeReadWorker {
    pub fn from_trusted_program(program: &Path) -> Result<Self> {
        #[cfg(not(any(target_os = "linux", windows)))]
        anyhow::bail!("OFFICE_WORKER_PLATFORM_UNAVAILABLE");
        #[cfg(any(target_os = "linux", windows))]
        {
            let program = program
                .canonicalize()
                .context("OFFICE_COMPONENT_UNAVAILABLE")?;
            ensure!(program.is_file(), "OFFICE_COMPONENT_UNAVAILABLE");
            Ok(Self { program })
        }
    }
    pub async fn read(
        &self,
        header: OfficeReadHeader,
        bytes: Vec<u8>,
        timeout_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        header.validate()?;
        ensure!(
            bytes.len() as u64 == header.byte_length
                && (1..=60_000).contains(&timeout_ms)
                && !cancel.is_cancelled(),
            "OFFICE_INVALID_INPUT"
        );
        let mut encoded = serde_json::to_vec(&header)?;
        ensure!(encoded.len() < 16 * 1024, "OFFICE_INVALID_INPUT");
        encoded.push(b'\n');
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        let workspace = OwnedWorkspace::new(&header)?;
        let mut command = Command::new(&self.program);
        command
            .current_dir(workspace.path())
            .env("KCODER_CONFIG_DIR", workspace.path().join("config"));
        #[cfg(target_os = "linux")]
        command
            .arg(kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_V1)
            .arg(std::process::id().to_string())
            .arg(&self.program);
        command
            .arg(READ_WORKER_FLAG)
            .env_clear()
            .env("KCODER_CONFIG_DIR", workspace.path().join("config"))
            .env("LANG", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        let mut job = {
            command
                .creation_flags(kcoder_process_supervisor::suspended_child::SUSPENDED_CHILD_FLAGS);
            kcoder_process_supervisor::suspended_child::SuspendedChildJob::new()
                .context("OFFICE_CLEANUP_UNCONFIRMED")?
        };
        let mut child = command.spawn().context("OFFICE_COMPONENT_UNAVAILABLE")?;
        #[cfg(target_os = "linux")]
        let owner = match kcoder_process_supervisor::linux_stdio::StdioOwnerGuard::for_child(
            child.id().context("OFFICE_PROCESS_PROTOCOL")?,
        ) {
            Ok(owner) => owner,
            Err(_) => {
                if let Some(pid) = child.id() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                let _ = tokio::time::timeout(std::time::Duration::from_secs(4), child.wait()).await;
                anyhow::bail!("OFFICE_CLEANUP_UNCONFIRMED");
            }
        };
        #[cfg(windows)]
        {
            let assigned = (|| {
                let handle = child.raw_handle().context("OFFICE_PROCESS_PROTOCOL")?;
                job.assign_and_resume(unsafe {
                    std::os::windows::io::BorrowedHandle::borrow_raw(handle)
                })
            })();
            if assigned.is_err() {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(std::time::Duration::from_secs(4), child.wait()).await;
                anyhow::bail!("OFFICE_CLEANUP_UNCONFIRMED");
            }
        }
        let mut stdin = child.stdin.take().context("OFFICE_PROCESS_PROTOCOL")?;
        let stdout = child.stdout.take().context("OFFICE_PROCESS_PROTOCOL")?;
        let result = {
            let exchange = async {
                stdin.write_all(&encoded).await?;
                for chunk in bytes.chunks(512 * 1024) {
                    if cancel.is_cancelled() {
                        anyhow::bail!("OFFICE_CANCELLED");
                    }
                    stdin.write_all(chunk).await?;
                }
                stdin.shutdown().await?;
                drop(stdin);
                let mut output = Vec::new();
                stdout
                    .take(64 * 1024 + 1025)
                    .read_to_end(&mut output)
                    .await?;
                ensure!(
                    output.len() <= 64 * 1024 + 1024,
                    "OFFICE_READ_REPLY_TOO_LARGE"
                );
                Ok::<_, anyhow::Error>(output)
            };
            tokio::pin!(exchange);
            let outcome = async {
                let output = exchange.await?;
                let status = child.wait().await.context("OFFICE_PROCESS_PROTOCOL")?;
                let reply: Value =
                    serde_json::from_slice(&output).context("OFFICE_PROCESS_PROTOCOL")?;
                ensure!(
                    status.success() && reply.get("ok") == Some(&Value::Bool(true)),
                    "OFFICE_READ_FAILED"
                );
                reply
                    .get("result")
                    .cloned()
                    .context("OFFICE_PROCESS_PROTOCOL")
            };
            tokio::pin!(outcome);
            tokio::select! {result=&mut outcome=>result,_=cancel.cancelled()=>Err(anyhow::anyhow!("OFFICE_CANCELLED")),_=tokio::time::sleep_until(deadline)=>Err(anyhow::anyhow!("OFFICE_TIMEOUT"))}
        };
        // The exchange/status future has been dropped before child cleanup.
        if result.is_err() {
            #[cfg(target_os = "linux")]
            owner.request_stop();
            #[cfg(windows)]
            job.terminate().context("OFFICE_CLEANUP_UNCONFIRMED")?;
            settle(&mut child).await?;
        }
        workspace.finish()?;
        result
    }
}
async fn settle(child: &mut Child) -> Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(4), child.wait())
        .await
        .context("OFFICE_CLEANUP_UNCONFIRMED")?
        .context("OFFICE_CLEANUP_UNCONFIRMED")?;
    Ok(())
}

/// An uncertain process tree keeps its private bytes and ownership record; a
/// confirmed exit releases only this exact workspace. No global-name cleanup.
struct OwnedWorkspace {
    directory: Option<tempfile::TempDir>,
    identity: String,
}
impl OwnedWorkspace {
    fn new(header: &OfficeReadHeader) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("kcoder-office-read-")
            .tempdir()?;
        let verified = kcoder_config::PrivateDirectory::open_existing(directory.path())?;
        let identity = verified.directory_identity()?;
        verified.atomic_replace(std::ffi::OsStr::new("owner.json"),&serde_json::to_vec(&json!({"schemaVersion":1,"owner":"office-read-worker-v1","nonce":uuid::Uuid::new_v4().to_string(),"directoryIdentity":identity,"parentPid":std::process::id(),"inputId":header.reference.id,"contentSha256":header.sha256,"scopeSha256":header.scope_sha256}))?)?;
        Ok(Self {
            directory: Some(directory),
            identity,
        })
    }
    fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("workspace retained until settlement")
            .path()
    }
    fn finish(mut self) -> Result<()> {
        let verified = kcoder_config::PrivateDirectory::open_existing(self.path())?;
        ensure!(
            verified.directory_identity()? == self.identity,
            "OFFICE_CLEANUP_UNCONFIRMED"
        );
        drop(verified);
        let directory = self
            .directory
            .take()
            .context("OFFICE_CLEANUP_UNCONFIRMED")?;
        directory.close().context("OFFICE_CLEANUP_UNCONFIRMED")?;
        Ok(())
    }
}
impl Drop for OwnedWorkspace {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            let _ = directory.keep();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires an explicitly selected freshly built KCoder binary"]
    async fn actual_driver_reads_and_cancels_its_owned_tree_under_one_budget() {
        let binary =
            std::env::var_os("KCODER_OFFICE_READER_TEST_BIN").expect("explicit current binary");
        let driver = OfficeReadWorker::from_trusted_program(Path::new(&binary)).unwrap();
        let bytes = "会议决议：1234.56元；责任人待确认。".as_bytes().to_vec();
        let header = OfficeReadHeader {
            schema_version: 1,
            operation: None,
            reference: OfficeArtifactRef {
                id: "input-driver-fixture".into(),
                revision: 1,
            },
            filename: "material.txt".into(),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            scope_sha256: "a".repeat(64),
            cursor: None,
            limit: 2,
        };
        let result = driver
            .read(header, bytes, 5000, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            result["chunks"][0]["text"]
                .as_str()
                .unwrap()
                .contains("1234.56")
        );
        let bytes = vec![b'a'; 32 * 1024 * 1024];
        let header = OfficeReadHeader {
            schema_version: 1,
            operation: None,
            reference: OfficeArtifactRef {
                id: "large-driver-fixture".into(),
                revision: 1,
            },
            filename: "large.txt".into(),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            scope_sha256: "a".repeat(64),
            cursor: None,
            limit: 2,
        };
        let start = std::time::Instant::now();
        let error = driver
            .read(header, bytes, 50, &CancellationToken::new())
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "OFFICE_TIMEOUT");
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }
}
