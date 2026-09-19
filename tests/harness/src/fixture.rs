use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const FIXTURE_METADATA_FILE: &str = "fixture.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureMetadata {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceFixture {
    root: PathBuf,
    metadata: FixtureMetadata,
    digest: String,
}

#[derive(Debug)]
pub struct MaterializedFixture {
    pub root: PathBuf,
    pub metadata: FixtureMetadata,
    pub digest: String,
}

impl WorkspaceFixture {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        anyhow::ensure!(root.is_dir(), "fixture 不是目录: {}", root.display());
        reject_symlinks(root)?;
        let metadata_path = root.join(FIXTURE_METADATA_FILE);
        let metadata: FixtureMetadata =
            serde_json::from_slice(&fs::read(&metadata_path).with_context(|| {
                format!("读取 fixture metadata 失败: {}", metadata_path.display())
            })?)
            .with_context(|| format!("解析 fixture metadata 失败: {}", metadata_path.display()))?;
        anyhow::ensure!(metadata.schema_version == 1, "不支持的 fixture schema");
        anyhow::ensure!(!metadata.name.trim().is_empty(), "fixture name 不能为空");
        anyhow::ensure!(
            !metadata.version.trim().is_empty(),
            "fixture version 不能为空"
        );
        let digest = fixture_digest(root)?;
        Ok(Self {
            root: root.to_path_buf(),
            metadata,
            digest,
        })
    }

    pub fn metadata(&self) -> &FixtureMetadata {
        &self.metadata
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn file_path(&self, relative: impl AsRef<Path>) -> Result<PathBuf> {
        let relative = validate_relative_path(relative.as_ref())?;
        let path = self.root.join(relative);
        anyhow::ensure!(path.starts_with(&self.root), "fixture 路径逃逸");
        Ok(path)
    }

    pub fn materialize(&self, destination: impl AsRef<Path>) -> Result<MaterializedFixture> {
        let destination = destination.as_ref();
        anyhow::ensure!(
            !destination.exists(),
            "拒绝覆盖现有 fixture 目标: {}",
            destination.display()
        );
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)
            .with_context(|| format!("创建 fixture 目标父目录失败: {}", parent.display()))?;
        let canonical_source = self
            .root
            .canonicalize()
            .with_context(|| format!("规范化 fixture 源目录失败: {}", self.root.display()))?;
        let destination_name = destination.file_name().context("fixture 目标缺少目录名")?;
        let canonical_destination = parent
            .canonicalize()
            .with_context(|| format!("规范化 fixture 目标父目录失败: {}", parent.display()))?
            .join(destination_name);
        anyhow::ensure!(
            !canonical_destination.starts_with(&canonical_source),
            "fixture 目标不能位于只读模板内部"
        );
        fs::create_dir(destination)
            .with_context(|| format!("创建 fixture 目标失败: {}", destination.display()))?;
        if let Err(error) = copy_tree(&self.root, destination) {
            let _ = fs::remove_dir_all(destination);
            return Err(error);
        }
        Ok(MaterializedFixture {
            root: destination.to_path_buf(),
            metadata: self.metadata.clone(),
            digest: self.digest.clone(),
        })
    }
}

fn validate_relative_path(path: &Path) -> Result<&Path> {
    anyhow::ensure!(!path.as_os_str().is_empty(), "fixture 相对路径不能为空");
    anyhow::ensure!(!path.is_absolute(), "fixture 路径不能是绝对路径");
    for component in path.components() {
        anyhow::ensure!(
            matches!(component, Component::Normal(_)),
            "fixture 路径包含非法分量: {}",
            path.display()
        );
    }
    Ok(path)
}

fn reject_symlinks(root: &Path) -> Result<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("读取 fixture 目录失败: {}", directory.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            anyhow::ensure!(
                !file_type.is_symlink(),
                "fixture 禁止符号链接: {}",
                path.display()
            );
            if file_type.is_dir() {
                reject_generated_fixture_entry(&entry.file_name(), &path)?;
                pending.push(path);
            } else {
                anyhow::ensure!(
                    file_type.is_file(),
                    "fixture 含有不支持的节点: {}",
                    path.display()
                );
            }
        }
    }
    Ok(())
}

fn reject_generated_fixture_entry(name: &std::ffi::OsStr, path: &Path) -> Result<()> {
    let name = name.to_string_lossy();
    anyhow::ensure!(
        !matches!(
            name.as_ref(),
            "target" | "node_modules" | ".git" | ".cache" | "test-results" | "playwright-report"
        ),
        "fixture 禁止包含生成或运行时目录: {}",
        path.display()
    );
    Ok(())
}

fn fixture_digest(root: &Path) -> Result<String> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, path) in files {
        let relative = relative.to_string_lossy();
        let bytes = fs::read(&path)
            .with_context(|| format!("读取 fixture 文件失败: {}", path.display()))?;
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<(PathBuf, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("读取 fixture 目录失败: {}", directory.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        anyhow::ensure!(
            !file_type.is_symlink(),
            "fixture 禁止符号链接: {}",
            path.display()
        );
        if file_type.is_dir() {
            collect_files(root, &path, files)?;
        } else if file_type.is_file() {
            files.push((path.strip_prefix(root)?.to_path_buf(), path));
        } else {
            anyhow::bail!("fixture 含有不支持的节点: {}", path.display());
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    for entry in fs::read_dir(source)
        .with_context(|| format!("读取 fixture 目录失败: {}", source.display()))?
    {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        anyhow::ensure!(
            !file_type.is_symlink(),
            "fixture 禁止符号链接: {}",
            source_path.display()
        );
        if file_type.is_dir() {
            fs::create_dir(&destination_path)?;
            copy_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).with_context(|| {
                format!(
                    "复制 fixture 文件失败: {} -> {}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        } else {
            anyhow::bail!("fixture 含有不支持的节点: {}", source_path.display());
        }
    }
    Ok(())
}
