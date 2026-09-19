use crate::{Skill, SkillStore, builtin, parse_skill_file};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

#[derive(Debug, Default, Clone)]
pub struct SkillRegistry {
    skills: HashMap<String, Skill>,
    /// Skill that users cannot invoke directly and that activates from touched paths.
    conditional: Vec<Skill>,
}

impl SkillRegistry {
    pub fn load(cwd: &Path) -> Result<Self> {
        Self::load_with_external_dirs(cwd, std::iter::empty::<PathBuf>())
    }

    pub fn load_with_external_dirs<I, P>(cwd: &Path, external_dirs: I) -> Result<Self>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let user_dir = user_skills_dir().ok();
        Self::load_with_layers(cwd, external_dirs, user_dir.as_deref(), true)
    }

    /// Load project-layer skills only, excluding skills from the current OS user; used for isolated runtimes and deterministic tests.
    pub fn load_project_only(cwd: &Path) -> Result<Self> {
        Self::load_with_layers(cwd, std::iter::empty::<PathBuf>(), None, true)
    }

    /// Skip project skills discovered upward from cwd when the project is untrusted; external and user layers retain their normal loading rules.
    pub fn load_with_external_dirs_and_trust<I, P>(
        cwd: &Path,
        external_dirs: I,
        project_trusted: bool,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let user_dir = user_skills_dir().ok();
        Self::load_with_layers(cwd, external_dirs, user_dir.as_deref(), project_trusted)
    }

    pub(crate) fn load_with_layers<I, P>(
        cwd: &Path,
        external_dirs: I,
        user_dir: Option<&Path>,
        project_trusted: bool,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut registry = Self::default();

        // Load built-in skills first so later project, external, and user layers can override them by name.
        if let Some(user_dir) = user_dir {
            let builtin_dir = user_dir.join(builtin::BUILTIN_SKILLS_DIR_NAME);
            if builtin_dir.is_dir() {
                registry.scan_managed_dir(&builtin_dir)?;
            }
        }

        if project_trusted {
            let home_dir = dirs::home_dir();
            for dir in project_skill_dirs(cwd, home_dir.as_deref()) {
                registry.scan_managed_dir(&dir)?;
            }
        }

        for dir in external_dirs {
            let dir = dir.as_ref();
            if dir.is_dir() {
                registry.scan_dir(dir)?;
            }
        }

        if let Some(user_dir) = user_dir
            && user_dir.is_dir()
        {
            registry.scan_managed_dir(user_dir)?;
        }
        Ok(registry)
    }

    pub fn empty() -> Self {
        Self::default()
    }

    fn scan_dir(&mut self, root: &Path) -> Result<()> {
        for entry in std::fs::read_dir(root)
            .with_context(|| format!("failed to read skills dir {:?}", root))?
        {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                warn!("ignoring symlinked skill directory {:?}", entry.path());
                continue;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if !skill_file.is_file() {
                continue;
            }
            match parse_skill_file(&skill_file) {
                Ok(skill) => {
                    debug!("loaded skill {} from {:?}", skill.name, skill_file);
                    if skill.user_invocable {
                        self.conditional
                            .retain(|existing| existing.name != skill.name);
                        self.skills.insert(skill.name.clone(), skill);
                    } else {
                        self.skills.remove(&skill.name);
                        self.conditional
                            .retain(|existing| existing.name != skill.name);
                        self.conditional.push(skill);
                    }
                }
                Err(error) => warn!("failed to parse skill {:?}: {}", skill_file, error),
            }
        }
        Ok(())
    }

    fn scan_managed_dir(&mut self, root: &Path) -> Result<()> {
        let store = SkillStore::open(root)
            .with_context(|| format!("failed to open managed skill root {:?}", root))?;
        let snapshot = store
            .snapshot()
            .with_context(|| format!("failed to recover managed skill root {:?}", root))?;
        self.scan_dir(snapshot.root())
    }

    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    pub fn get_active(&self, name: &str) -> Option<&Skill> {
        self.skills
            .get(name)
            .or_else(|| self.conditional.iter().find(|skill| skill.name == name))
    }

    pub fn list(&self) -> Vec<&Skill> {
        self.skills.values().collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.skills.keys().cloned().collect()
    }

    pub fn remove_named(&mut self, name: &str) -> bool {
        let removed_invocable = self.skills.remove(name).is_some();
        let conditional_len = self.conditional.len();
        self.conditional.retain(|skill| skill.name != name);
        removed_invocable || self.conditional.len() != conditional_len
    }

    pub fn active_for_paths(&self, paths: &[String]) -> Vec<&Skill> {
        self.iter_all()
            .filter(|skill| skill.matches_paths(paths))
            .collect()
    }

    pub fn iter_all(&self) -> impl Iterator<Item = &Skill> {
        self.skills.values().chain(self.conditional.iter())
    }
}

pub(crate) fn project_skill_dirs(cwd: &Path, home_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut levels = Vec::new();
    let mut current = Some(cwd);
    while let Some(dir) = current {
        if home_dir == Some(dir) {
            break;
        }
        levels.push(dir.join(".kcoder").join("skills"));
        current = dir.parent();
    }
    levels.reverse();
    levels
        .into_iter()
        .filter(|directory| directory.is_dir())
        .collect()
}

fn user_skills_dir() -> Result<PathBuf> {
    Ok(kcoder_config::user_config_dir()?.join("skills"))
}

#[cfg(test)]
pub(crate) fn user_skills_dir_with_override(
    override_dir: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    let dir = override_dir
        .filter(|dir| !dir.is_empty())
        .context("config directory override was empty")?;
    Ok(PathBuf::from(dir).join("skills"))
}
