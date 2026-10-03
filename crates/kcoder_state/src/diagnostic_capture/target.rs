use super::*;
use kcoder_config::PrivateDirectory;
use std::ffi::OsString;
use std::path::Component;

pub(crate) struct FrozenTarget {
    anchor: PathBuf,
    children: Vec<OsString>,
    pub session_id: String,
    owner: Option<Arc<PrivateTempDir>>,
}

impl FrozenTarget {
    pub(crate) fn snapshot_recovery(
        state: &AppState,
        owner: Option<Arc<PrivateTempDir>>,
    ) -> Option<Self> {
        let inner = state.read_inner();
        let anchor = if let Some(location) = &inner.llm_request_history_override {
            std::path::absolute(&location.dir).ok()?
        } else {
            let (project, id) = AppState::session_artifact_project_dir_and_id(&inner)?;
            std::path::absolute(crate::session_dir_path(project, &id)).ok()?
        };
        Some(Self {
            anchor,
            children: vec![OsString::from("recovery")],
            session_id: String::new(),
            owner,
        })
    }
    pub fn snapshot(
        state: &AppState,
        memory: bool,
        owner: Option<Arc<PrivateTempDir>>,
    ) -> Option<Self> {
        let inner = state.read_inner();
        // Preserve the borrowed filesystem APIs' process-cwd semantics, frozen before queuing.
        let absolute = |path: &Path| std::path::absolute(path).ok();
        let root = AppState::session_artifact_project_dir_and_id(&inner)
            .and_then(|(project, id)| absolute(&crate::session_dir_path(project, &id)));
        let (mut dir, session_id) = if let Some(location) = &inner.llm_request_history_override {
            (absolute(&location.dir)?, location.session_id.clone())
        } else {
            let (project, id) = AppState::session_artifact_project_dir_and_id(&inner)?;
            (
                absolute(&crate::llm_request_history_dir_path(project, &id))?,
                id,
            )
        };
        let anchor = root
            .filter(|root| dir.starts_with(root))
            .unwrap_or_else(|| dir.clone());
        if memory {
            dir.push("session-memory");
        }
        let children = dir
            .strip_prefix(&anchor)
            .ok()?
            .components()
            .map(|component| match component {
                Component::Normal(name) => Some(name.to_owned()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            anchor,
            children,
            session_id,
            owner,
        })
    }

    pub fn retained_bytes(&self) -> usize {
        self.anchor
            .capacity()
            .saturating_mul(2)
            .saturating_add(self.session_id.capacity())
            .saturating_add(self.children.iter().fold(0usize, |sum, child| {
                sum.saturating_add(child.capacity().saturating_mul(2))
            }))
            .saturating_add(
                self.children
                    .capacity()
                    .saturating_mul(std::mem::size_of::<OsString>()),
            )
            .saturating_add(1024)
    }

    pub fn open(self) -> anyhow::Result<Target> {
        Ok(Target {
            directory: PrivateDirectory::open_existing(&self.anchor)?,
            children: self.children,
            session_id: self.session_id,
            _owner: self.owner,
        })
    }

    pub(crate) fn open_recovery(self) -> anyhow::Result<Target> {
        let mut target = self.open()?;
        // Bind the final recovery directory identity before collection, not just its parent.
        for child in target.children.drain(..) {
            target.directory = target.directory.open_child(&child, true)?;
        }
        Ok(target)
    }
}

pub(crate) struct Target {
    directory: PrivateDirectory,
    children: Vec<OsString>,
    pub session_id: String,
    _owner: Option<Arc<PrivateTempDir>>,
}

impl Target {
    pub fn write(&self, content: &[u8], timestamp: u64) -> anyhow::Result<()> {
        self.write_named(
            content,
            &crate::llm_history::llm_exchange_file_name(timestamp),
            crate::llm_history::LLM_EXCHANGE_HISTORY_LIMIT,
            |name| Path::new(name).extension().is_some_and(|ext| ext == "json"),
        )
    }

    pub(crate) fn write_named(
        &self,
        content: &[u8],
        name: &str,
        limit: usize,
        owns_file: fn(&std::ffi::OsStr) -> bool,
    ) -> anyhow::Result<()> {
        let mut child = None;
        for name in &self.children {
            child = Some(
                child
                    .as_ref()
                    .unwrap_or(&self.directory)
                    .open_child(name, true)?,
            );
        }
        let directory = child.as_ref().unwrap_or(&self.directory);
        directory.atomic_replace(std::ffi::OsStr::new(name), content)?;
        let mut files = directory.open_regular_files(owns_file)?;
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let remove = files.len().saturating_sub(limit);
        for (name, file) in files.into_iter().take(remove) {
            drop(file);
            directory.remove_regular_file(&name)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_budget_includes_spare_path_capacity() {
        let mut anchor = PathBuf::with_capacity(4096);
        anchor.push("anchor");
        let mut child = OsString::with_capacity(8192);
        child.push("child");
        let frozen = FrozenTarget {
            anchor,
            children: vec![child],
            session_id: "session".into(),
            owner: None,
        };
        assert!(frozen.retained_bytes() >= 4096 + 8192);
    }
}
