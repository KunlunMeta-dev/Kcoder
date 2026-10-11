//! Materialize only declared plugin dependencies; never run `git submodule update`.
use super::*;
use anyhow::ensure;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const NOTE: &str = ".kcoder-git-dependencies.json";

fn config_fields(bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    let text = std::str::from_utf8(bytes).context("Git submodule metadata is not UTF-8")?;
    let mut fields = BTreeMap::new();
    for item in text.split('\0').filter(|item| !item.is_empty()) {
        let (key, value) = item.split_once('\n').context("Invalid Git config record")?;
        if key.starts_with("submodule.") && (key.ends_with(".path") || key.ends_with(".url")) {
            ensure!(
                fields.insert(key.into(), value.into()).is_none(),
                "Ambiguous Git submodule metadata"
            );
        }
    }
    Ok(fields)
}

fn module_path(value: &str) -> Result<&Path> {
    ensure!(
        !value.chars().any(char::is_control),
        "Git submodule path contains control characters"
    );
    let path = crate::hosted::safe_relative(value)?;
    ensure!(
        !path.components().any(|part| part
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")),
        "Git submodule may not overwrite Git control files"
    );
    Ok(path)
}

fn module_url(value: &str, parent: &str) -> Result<String> {
    let url = url::Url::parse(value).context("Git submodules require an absolute HTTPS URL")?;
    let parent = url::Url::parse(parent).ok();
    ensure!(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.port().is_none(),
        "Git submodules require credential-free HTTPS"
    );
    ensure!(
        url.host_str().is_some()
            && (url.host_str() == parent.as_ref().and_then(url::Url::host_str)
                || matches!(
                    url.host_str(),
                    Some("github.com" | "gitlab.com" | "gitee.com" | "cnb.cool")
                )),
        "Git submodule host must match its parent or a supported public Git host"
    );
    Ok(url.to_string())
}

fn paths(root: &Path) -> Result<Vec<PathBuf>> {
    let Some(loaded) = crate::load_plugin_manifest(root)? else {
        return Ok(Vec::new());
    };
    let c = loaded.manifest.contributions;
    let mut paths: Vec<_> = c
        .skills
        .into_iter()
        .chain(c.commands)
        .chain(c.agents)
        .map(|p| p.absolute_path)
        .collect();
    if let Some(p) = c.apps {
        paths.push(p.absolute_path);
    }
    let mut documents = Vec::new();
    if let Some(crate::PluginMcpDeclaration::Path(p)) = c.mcp_servers {
        documents.push(p.absolute_path);
    }
    for h in c.hooks {
        if let crate::PluginHookDeclaration::Path(p) = h {
            documents.push(p.absolute_path);
        }
    }
    paths.extend(documents);
    Ok(paths)
}

pub(super) fn hydrate(
    checkout: &Path,
    request: &GitMaterializeRequest<'_>,
    context: &CommandContext<'_>,
    depth: usize,
    budget: &mut usize,
) -> Result<()> {
    let file = checkout.join(".gitmodules");
    if !file.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(&file)?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_COMMAND_OUTPUT_BYTES,
        "Invalid Git submodule metadata file"
    );
    let args: Vec<OsString> = [
        "-C",
        "checkout",
        "config",
        "--file",
        ".gitmodules",
        "--null",
        "--list",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let fields = config_fields(&run_isolated_command(
        "git",
        &args,
        &[],
        "submodules-config",
        context,
    )?)?;
    ensure!(
        fields.keys().filter(|key| key.ends_with(".path")).count() <= 64,
        "Git submodule declaration limit exceeded"
    );
    let selected = request
        .path
        .map(|p| normalized_relative_path(p, "Git plugin path").map(|p| checkout.join(p)))
        .transpose()?
        .unwrap_or_else(|| checkout.to_path_buf());
    let declared = if selected.is_dir() {
        paths(&selected)?
    } else {
        Vec::new()
    };
    let mut seen = BTreeSet::new();
    let mut copied = Vec::new();
    let mut skipped = Vec::new();
    for (key, value) in &fields {
        if !key.ends_with(".path") {
            continue;
        }
        request.cancellation.check()?;
        let relative = module_path(value)?;
        ensure!(
            seen.insert(relative.to_path_buf()),
            "Duplicate Git submodule path"
        );
        let destination = checkout.join(relative);
        if !destination.starts_with(&selected) && !selected.starts_with(&destination) {
            continue;
        }
        let needed = selected.starts_with(&destination)
            || declared
                .iter()
                .any(|p| p.starts_with(&destination) || destination.starts_with(p))
            || (depth > 0 && declared.is_empty());
        if !needed {
            skipped.push(value.clone());
            continue;
        }
        ensure!(
            depth < 2 && *budget < 16,
            "Plugin Git submodule dependency limit exceeded"
        );
        *budget += 1;
        let url = module_url(
            fields
                .get(&format!("{}.url", key.trim_end_matches(".path")))
                .context("Git submodule is missing URL")?,
            request.url,
        )?;
        let args: Vec<OsString> = ["-C", "checkout", "ls-tree", "-z", "HEAD", "--"]
            .into_iter()
            .map(Into::into)
            .chain([format!(
                ":(literal){}",
                relative.to_string_lossy().replace('\\', "/")
            )
            .into()])
            .collect();
        let tree = run_isolated_command("git", &args, &[], "submodule-revision", context)?;
        let tree = std::str::from_utf8(&tree)?;
        let rows: Vec<_> = tree.split('\0').filter(|row| !row.is_empty()).collect();
        ensure!(
            rows.len() == 1,
            "Git submodule has no unique pinned tree entry"
        );
        let (header, _) = rows[0].split_once('\t').context("Invalid Git tree entry")?;
        let sha = header
            .strip_prefix("160000 commit ")
            .context("Dependency path is not a pinned Git submodule")?;
        validate_git_sha(Some(sha))?;
        let nested = selected
            .strip_prefix(&destination)
            .ok()
            .filter(|p| !p.as_os_str().is_empty());
        let nested = nested.map(|p| p.to_string_lossy().replace('\\', "/"));
        let child = materialize_git_inner(
            GitMaterializeRequest {
                limits: request.limits,
                proxy_url: request.proxy_url,
                url: &url,
                path: nested.as_deref(),
                ref_name: None,
                sha: Some(sha),
                deadline: request.deadline,
                cancellation: request.cancellation,
            },
            depth + 1,
            budget,
        )?;
        let target = if nested.is_some() {
            &selected
        } else {
            &destination
        };
        if let Ok(meta) = fs::symlink_metadata(target) {
            ensure!(
                meta.is_dir()
                    && !meta.file_type().is_symlink()
                    && fs::read_dir(target)?.next().is_none(),
                "Git submodule target must be an empty directory"
            );
        }
        kcoder_config::PrivateDirectory::open_or_create(target)?;
        crate::store::copy_local_tree(
            &child.root,
            target,
            request.limits,
            request.deadline,
            request.cancellation,
        )?;
        command_disk_budget(context)?;
        copied.push(json!({"path":value,"url":url,"sha":sha}));
    }
    if selected.is_dir() && (!copied.is_empty() || !skipped.is_empty()) {
        kcoder_config::PrivateDirectory::open_existing(&selected)?.atomic_replace(
            OsStr::new(NOTE),
            &serde_json::to_vec(&json!({"version":1,"hydrated":copied,"skipped":skipped}))?,
        )?;
    }
    Ok(())
}

pub(crate) fn skipped_note(root: &Path) -> Result<Option<String>> {
    let path = root.join(NOTE);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path)?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_COMMAND_OUTPUT_BYTES,
        "Invalid Git dependency provenance"
    );
    let directory = kcoder_config::PrivateDirectory::open_existing(root)?;
    let mut bytes = Vec::new();
    directory
        .open_regular_file(OsStr::new(NOTE))?
        .take(MAX_COMMAND_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_COMMAND_OUTPUT_BYTES,
        "Git dependency provenance exceeds limit"
    );
    let value: Value = serde_json::from_slice(&bytes)?;
    let skipped = value["skipped"]
        .as_array()
        .context("Invalid Git dependency provenance")?;
    if skipped.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Repository submodules not referenced by plugin declarations were not fetched: {}. Components requiring those extra dependencies need separate setup",
        skipped
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_and_dependency_sources_are_bounded_and_non_executable() {
        assert!(config_fields(b"submodule.a.path\na\0submodule.a.path\nb\0").is_err());
        assert_eq!(
            config_fields(b"submodule.a.path\nskills/a\0").unwrap()["submodule.a.path"],
            "skills/a"
        );
        for path in ["../escape", ".git/config", "C:/outside", "a\\b", "a\nfile"] {
            assert!(module_path(path).is_err(), "{path}");
        }
        for url in [
            "file:///secret",
            "ext::touch marker",
            "http://github.com/a/b",
            "https://user:secret@github.com/a/b",
            "https://127.0.0.1/private",
        ] {
            assert!(
                module_url(url, "https://github.com/a/parent").is_err(),
                "{url}"
            );
        }
        assert!(
            module_url(
                "https://github.com/a/child.git",
                "https://github.com/a/parent.git"
            )
            .is_ok()
        );
    }
}
