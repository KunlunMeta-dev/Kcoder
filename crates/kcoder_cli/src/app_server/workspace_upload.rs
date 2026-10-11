//! Workspace publication uses the connection-owned attachment transport. Bytes
//! remain private until complete, and replacement requires a confirmed revision.
use super::{
    attachments::{self, AttachmentDirectories},
    workspace_io, workspace_revision,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{WorkspaceImportAttachmentParams, WorkspaceImportAttachmentResult};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

fn existing(parent: &PrivateDirectory, name: &str) -> Result<Option<File>> {
    match parent.open_regular_file(name.as_ref()) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|cause| cause.kind() == io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => {
            Err(error.context("destination must be a regular file, not a directory or link"))
        }
    }
}

struct ExactReader {
    file: File,
    remaining: u64,
    digest: Sha256,
}
impl Read for ExactReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut probe = [0];
            if self.file.read(&mut probe)? != 0 {
                return Err(io::Error::other("uploaded file changed size"));
            }
            return Ok(0);
        }
        let limit = bytes.len().min(self.remaining as usize);
        let size = self.file.read(&mut bytes[..limit])?;
        if size == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "uploaded file is incomplete",
            ));
        }
        self.remaining -= size as u64;
        self.digest.update(&bytes[..size]);
        Ok(size)
    }
}

pub(super) async fn import_attachment(
    root: &Path,
    params: WorkspaceImportAttachmentParams,
    staged: &mut AttachmentDirectories,
) -> Result<WorkspaceImportAttachmentResult> {
    ensure!(
        !params.filename.trim().is_empty()
            && !matches!(params.filename.as_str(), "." | "..")
            && !params
                .filename
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\')),
        "invalid upload filename"
    );
    ensure!(
        params.overwrite == params.expected_revision.is_some(),
        "overwrite requires the confirmed destination revision"
    );
    let source_path = PathBuf::from(&params.attachment_path);
    let file = attachments::open_owned_staged_attachment(&source_path, staged)?;
    let size = file.metadata()?.len();
    workspace_io::validate_name(&params.filename)?;
    let (destination, directory) = workspace_io::parent(root, Path::new(&params.parent_path))?;
    let target_path = destination.join(&params.filename);
    let response =
        tokio::task::spawn_blocking(move || -> Result<WorkspaceImportAttachmentResult> {
            let _lease = workspace_io::writer_lock(&directory)?;
            let prior = existing(&directory, &params.filename)?;
            if let Some(prior) = &prior {
                let current_revision = workspace_revision::revision(prior)?;
                if !params.overwrite
                    || params.expected_revision.as_deref() != Some(current_revision.as_str())
                {
                    return Ok(WorkspaceImportAttachmentResult {
                        status: "conflict".into(),
                        revision: Some(current_revision),
                        path: target_path.to_string_lossy().into(),
                        name: params.filename,
                        size: prior.metadata()?.len(),
                        sha256: String::new(),
                    });
                }
            } else {
                ensure!(
                    !params.overwrite,
                    "destination changed after overwrite confirmation; upload again"
                );
            }
            drop(prior);
            let mut input = ExactReader {
                file,
                remaining: size,
                digest: Sha256::new(),
            };
            directory.atomic_publish_from_reader(
                params.filename.as_ref(),
                &mut input,
                params.overwrite,
                || {
                    if params.overwrite {
                        let current = existing(&directory, &params.filename)?
                            .context("destination changed after overwrite confirmation")?;
                        ensure!(
                            Some(workspace_revision::revision(&current)?.as_str())
                                == params.expected_revision.as_deref(),
                            "destination changed after overwrite confirmation; upload again"
                        );
                        Ok(Some(current.metadata()?.permissions()))
                    } else {
                        Ok(None)
                    }
                },
            )?;
            Ok(WorkspaceImportAttachmentResult {
                status: "uploaded".into(),
                revision: None,
                path: target_path.to_string_lossy().into(),
                name: params.filename,
                size,
                sha256: format!("{:x}", input.digest.finalize()),
            })
        })
        .await
        .context("workspace upload writer failed")??;
    if response.status == "uploaded" {
        // Publication is durable even if removal of an already-consumed staging
        // directory fails. Never report an uncommitted upload after publication.
        if let Err(error) = staged.consume(&source_path) {
            tracing::warn!(%error, "uploaded workspace file staging cleanup failed");
        }
    }
    Ok(response)
}
