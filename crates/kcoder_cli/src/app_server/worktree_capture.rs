//! A bounded, no-follow input view for the existing private snapshot backend.

use super::*;
use crate::{
    git::{self, run_git_command, run_git_command_with_private_repository},
    workspace_io, workspace_revision,
};
use kcoder_config::PrivateDirectory;
use std::{collections::BTreeSet, ffi::OsStr, fs::File, path::Component};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct ObservedFile {
    path: String,
    revision: Option<String>,
}

pub struct CaptureView {
    pub path: PathBuf,
    pub has_exclusions: bool,
    pub excluded_paths: Vec<String>,
    root_identity: String,
    inventory: Vec<String>,
    observed: Vec<ObservedFile>,
    _cleanup: RemovePrivateDirectoryOnDrop,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn parent(root: &Path, relative: &Path, create: bool) -> Result<PrivateDirectory> {
    let mut opened = PrivateDirectory::open_existing(root)?;
    for component in relative.parent().into_iter().flat_map(Path::components) {
        match component {
            Component::Normal(name) => opened = opened.open_child(name, create)?,
            _ => anyhow::bail!("unsupported snapshot path component"),
        }
    }
    Ok(opened)
}

fn open_source(root: &Path, path: &str) -> Result<Option<File>> {
    let relative = Path::new(path);
    let result = parent(root, relative, false).and_then(|directory| {
        directory.open_single_link_regular_file(relative.file_name().context("missing filename")?)
    });
    match result {
        Ok(file) => Ok(Some(file)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn inventory(workspace: &Path, repository: &Path) -> Result<Vec<String>> {
    // ls-files reads the actual index, including tracked ignored paths and index
    // flags. Optional locks are disabled by the process owner; no index is written.
    let probe = run_git_command(
        workspace,
        &["rev-parse", "--is-inside-work-tree"],
        4096,
        Duration::from_secs(10),
    )
    .await?;
    let hooks = format!("core.hooksPath={}", git::NULL_DEVICE_PATH);
    let args = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        &hooks,
        "-c",
        "submodule.recurse=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ];
    let source_repository = probe.success && probe.stdout.as_str().map(str::trim) == Some("true");
    let listing = if source_repository {
        run_git_command(
            workspace,
            &args,
            SNAPSHOT_PATH_LISTING_BYTES,
            Duration::from_secs(15),
        )
        .await?
    } else {
        run_git_command_with_private_repository(
            workspace,
            &args,
            repository,
            Some(workspace),
            None,
            None,
            SNAPSHOT_PATH_LISTING_BYTES,
            Duration::from_secs(15),
        )
        .await?
    };
    ensure!(listing.success, "cannot enumerate snapshot inputs");
    let mut listings = vec![listing];
    if source_repository {
        let mut check = args[..8].to_vec();
        check.extend(["check-ignore", "--quiet", "--", "."]);
        if run_git_command(workspace, &check, 4096, Duration::from_secs(10))
            .await?
            .success
        {
            // A parent repository can ignore the entire selected workspace.
            // Its tracked paths still come from the actual index; local others
            // are enumerated at the workspace root with its own ignore rules.
            listings.push(
                run_git_command_with_private_repository(
                    workspace,
                    &args,
                    repository,
                    Some(workspace),
                    None,
                    None,
                    SNAPSHOT_PATH_LISTING_BYTES,
                    Duration::from_secs(15),
                )
                .await?,
            );
        }
    }
    let mut unique = BTreeSet::new();
    let mut inventory_bytes = 0;
    for listing in listings {
        ensure!(listing.success, "cannot enumerate snapshot inputs");
        let paths = listing
            .stdout
            .as_str()
            .context("invalid snapshot inventory")?;
        ensure!(
            paths.len() < SNAPSHOT_PATH_LISTING_BYTES
                && (paths.is_empty() || paths.ends_with('\0')),
            "snapshot inventory is incomplete"
        );
        inventory_bytes += paths.len();
        ensure!(
            inventory_bytes < SNAPSHOT_PATH_LISTING_BYTES,
            "snapshot inventory budget exceeded"
        );
        for path in paths.split_terminator('\0') {
            ensure!(
                !path.is_empty()
                    && !path.contains('\u{fffd}')
                    && Path::new(path).components().all(|part| {
                        matches!(part, Component::Normal(name) if name != OsStr::new(".git"))
                    }),
                "unsupported snapshot input path"
            );
            unique.insert(path.to_owned());
            ensure!(unique.len() <= 100_000, "snapshot path budget exceeded");
        }
    }
    Ok(unique.into_iter().collect())
}

impl CaptureView {
    pub async fn create(
        workspace: &Path,
        repository: &Path,
        policy: &kcoder_config::TurnFileChangesSettings,
    ) -> Result<Self> {
        let root_identity = PrivateDirectory::open_existing(workspace)?.directory_identity()?;
        let inputs = inventory(workspace, repository).await?;
        // This view is inside the owned repository, so cancellation and crash GC
        // have the same owner as the existing before/after Git object storage.
        let path = repository.join(format!("capture-view-{}", uuid::Uuid::new_v4()));
        let cleanup = RemovePrivateDirectoryOnDrop::armed(path.clone())?;
        PrivateDirectory::open_or_create(&path)?;
        let ignore = policy.compile_ignore_globs()?;
        let mut view = Self {
            path,
            root_identity,
            inventory: inputs,
            observed: Vec::new(),
            has_exclusions: false,
            excluded_paths: Vec::new(),
            _cleanup: cleanup,
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut total = 0_u64;
        for input in &view.inventory {
            ensure!(
                tokio::time::Instant::now() < deadline,
                "snapshot input capture timed out"
            );
            let relative = Path::new(input);
            if relative.components().any(|part| {
                part.as_os_str()
                    .to_str()
                    .is_some_and(workspace_io::internal_name)
            }) || policy.excludes(relative, &ignore)
            {
                view.has_exclusions = true;
                view.excluded_paths.push(input.clone());
                continue;
            }
            let source_parent = match parent(workspace, relative, false) {
                Ok(parent) => parent,
                Err(error) if missing(&error) => {
                    view.observed.push(ObservedFile {
                        path: input.clone(),
                        revision: None,
                    });
                    continue;
                }
                Err(error) => return Err(error),
            };
            let leaf = relative.file_name().context("missing snapshot filename")?;
            let metadata = match source_parent.entry_metadata(leaf) {
                Ok(metadata) => metadata,
                Err(error) if missing(&error) => {
                    view.observed.push(ObservedFile {
                        path: input.clone(),
                        revision: None,
                    });
                    continue;
                }
                Err(error) => return Err(error),
            };
            // Links, gitlinks and other special files are explicitly partial;
            // none are followed to acquire bytes outside this workspace.
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                view.has_exclusions = true;
                view.excluded_paths.push(input.clone());
                continue;
            }
            let opened = source_parent.open_single_link_regular_file(leaf)?;
            let (metadata, revision) = workspace_revision::snapshot(&opened)?;
            if policy.file_exceeds_limit(metadata.len()) {
                view.has_exclusions = true;
                view.excluded_paths.push(input.clone());
                continue;
            }
            total = total
                .checked_add(metadata.len())
                .context("snapshot byte budget overflow")?;
            ensure!(
                policy.max_total_bytes == 0 || total <= policy.max_total_bytes,
                "snapshot inputs exceed the configured storage budget"
            );
            let destination =
                parent(&view.path, relative, true)?.open_read_write_file(leaf, true)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = if metadata.permissions().mode() & 0o111 != 0 {
                    0o700
                } else {
                    0o600
                };
                destination.set_permissions(std::fs::Permissions::from_mode(mode))?;
            }
            let mut source = tokio::fs::File::from_std(opened);
            let mut destination = tokio::fs::File::from_std(destination);
            // The size is obtained from the opened handle. Growth cannot cause
            // an unbounded read or exceed the admitted size in the Git input view.
            let length = metadata.len();
            let copied = tokio::time::timeout_at(deadline, async {
                let count =
                    tokio::io::copy(&mut (&mut source).take(length), &mut destination).await?;
                let mut extra = [0];
                ensure!(
                    source.read(&mut extra).await? == 0,
                    "snapshot input grew while reading"
                );
                destination.flush().await?;
                Ok::<_, anyhow::Error>(count)
            })
            .await
            .context("snapshot input capture timed out")??;
            let source = source.into_std().await;
            ensure!(
                copied == length && workspace_revision::revision(&source)? == revision,
                "snapshot input changed while reading"
            );
            view.observed.push(ObservedFile {
                path: input.clone(),
                revision: Some(revision),
            });
        }
        view.verify(workspace, repository).await?;
        Ok(view)
    }

    pub async fn verify(&self, workspace: &Path, repository: &Path) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(workspace)?.directory_identity()? == self.root_identity,
            "snapshot workspace identity changed"
        );
        ensure!(
            inventory(workspace, repository).await? == self.inventory,
            "snapshot input inventory changed"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        for observed in &self.observed {
            ensure!(
                std::time::Instant::now() < deadline,
                "snapshot verification timed out"
            );
            let actual = open_source(workspace, &observed.path)?
                .as_ref()
                .map(workspace_revision::revision)
                .transpose()?;
            ensure!(
                actual == observed.revision,
                "snapshot input changed during capture"
            );
        }
        Ok(())
    }
}

/// A read-only revision fence for tracked and nonignored regular files. This
/// reuses capture inventory and handle-based revisions without running filters
/// or writing Git objects. It is an observation token, not a content hash.
pub async fn observe_workspace_revision(workspace: &Path) -> Result<String> {
    let root = PrivateDirectory::open_existing(workspace)?.directory_identity()?;
    let paths = inventory(workspace, workspace).await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut observed = Vec::with_capacity(paths.len());
    for path in &paths {
        ensure!(
            std::time::Instant::now() < deadline,
            "workspace revision observation timed out"
        );
        let revision = open_source(workspace, path)?
            .as_ref()
            .map(workspace_revision::revision)
            .transpose()?;
        observed.push((path.clone(), revision));
    }
    ensure!(
        PrivateDirectory::open_existing(workspace)?.directory_identity()? == root
            && inventory(workspace, workspace).await? == paths,
        "workspace changed during revision observation"
    );
    for (path, revision) in &observed {
        ensure!(
            std::time::Instant::now() < deadline,
            "workspace revision verification timed out"
        );
        let actual = open_source(workspace, path)?
            .as_ref()
            .map(workspace_revision::revision)
            .transpose()?;
        ensure!(
            &actual == revision,
            "workspace changed during revision observation"
        );
    }
    Ok(hex_sha256(&serde_json::to_vec(&(root, observed))?))
}
