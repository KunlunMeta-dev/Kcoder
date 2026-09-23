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
    trust_rules: Vec<SkillTrustRule>,
    project_trust_context: Option<(PathBuf, Option<PathBuf>)>,
    user_directory: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillTrustRule {
    source_root: PathBuf,
    directory: PathBuf,
    config_dir: Option<PathBuf>,
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
        let mut registry =
            Self::load_with_layers(cwd, external_dirs, user_dir.as_deref(), project_trusted)?;
        let config_dir = kcoder_config::user_config_dir().ok();
        registry.project_trust_context = Some((cwd.to_path_buf(), config_dir.clone()));
        for root in project_skill_dirs(cwd, dirs::home_dir().as_deref()) {
            registry.require_folder_trust(&root, cwd, config_dir.clone());
        }
        Ok(registry)
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
        let mut registry = Self {
            user_directory: user_dir.map(Path::to_path_buf),
            ..Self::default()
        };

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

    /// Attach immutable discovery provenance while retaining live authorization.
    pub fn require_folder_trust(
        &mut self,
        source_root: &Path,
        directory: &Path,
        config_dir: Option<PathBuf>,
    ) {
        let rule = SkillTrustRule {
            source_root: source_root.to_path_buf(),
            directory: directory.to_path_buf(),
            config_dir,
        };
        if !self.trust_rules.contains(&rule) {
            self.trust_rules.push(rule);
        }
    }

    /// Preserve provenance when explicit skill maintenance refreshes a snapshot.
    pub fn reload_with_external_dirs<I, P>(&self, cwd: &Path, external_dirs: I) -> Result<Self>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let trusted = self
            .project_trust_context
            .as_ref()
            .is_none_or(|(directory, config_dir)| {
                kcoder_config::FolderTrustStore::trust_all_from_environment()
                    || config_dir.as_ref().is_some_and(|config_dir| {
                        kcoder_config::FolderTrustStore::load(config_dir).check(directory)
                            == kcoder_config::FolderTrust::Trusted
                    })
            });
        let mut refreshed =
            Self::load_with_layers(cwd, external_dirs, self.user_directory.as_deref(), trusted)?;
        refreshed.project_trust_context = self.project_trust_context.clone();
        if let Some((directory, config_dir)) = &self.project_trust_context {
            for root in project_skill_dirs(cwd, dirs::home_dir().as_deref()) {
                refreshed.require_folder_trust(&root, directory, config_dir.clone());
            }
        }
        refreshed.inherit_trust_requirements(self);
        Ok(refreshed)
    }

    pub fn inherit_trust_requirements(&mut self, previous: &Self) {
        for rule in &previous.trust_rules {
            if !self.trust_rules.contains(rule) {
                self.trust_rules.push(rule.clone());
            }
        }
    }

    fn trusted(&self, skill: &Skill) -> bool {
        kcoder_config::FolderTrustStore::trust_all_from_environment()
            || self
                .trust_rules
                .iter()
                .filter(|rule| skill.source.starts_with(&rule.source_root))
                .all(|rule| {
                    rule.config_dir.as_ref().is_some_and(|config_dir| {
                        kcoder_config::FolderTrustStore::load(config_dir).check(&rule.directory)
                            == kcoder_config::FolderTrust::Trusted
                    })
                })
    }

    pub fn is_trust_denied(&self, name: &str) -> bool {
        self.skills
            .get(name)
            .or_else(|| self.conditional.iter().find(|skill| skill.name == name))
            .is_some_and(|skill| !self.trusted(skill))
    }

    pub fn empty() -> Self {
        Self::default()
    }

    fn scan_dir(&mut self, root: &Path) -> Result<()> {
        let started = std::time::Instant::now();
        for (index, entry) in std::fs::read_dir(root)
            .with_context(|| format!("failed to read skills dir {:?}", root))?
            .enumerate()
        {
            if index >= 4096 || started.elapsed() > std::time::Duration::from_secs(5) {
                anyhow::bail!(
                    "skill discovery budget exceeded (4096 entries / 5 seconds) at {:?}",
                    root
                );
            }
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
        self.skills.get(name).filter(|skill| self.trusted(skill))
    }

    pub fn get_active(&self, name: &str) -> Option<&Skill> {
        self.skills
            .get(name)
            .or_else(|| self.conditional.iter().find(|skill| skill.name == name))
            .filter(|skill| self.trusted(skill))
    }

    pub fn list(&self) -> Vec<&Skill> {
        self.skills
            .values()
            .filter(|skill| self.trusted(skill))
            .collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.list().iter().map(|skill| skill.name.clone()).collect()
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
        self.skills
            .values()
            .chain(self.conditional.iter())
            .filter(|skill| self.trusted(skill))
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

#[cfg(test)]
mod live_trust_tests {
    use super::*;

    fn write_skill(root: &Path, name: &str, conditional: bool) {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        let activation = if conditional {
            "user-invocable: false\npaths: [\"**/*.rs\"]\n"
        } else {
            ""
        };
        std::fs::write(path.join("SKILL.md"), format!("---\nname: {name}\ndescription: Trust fixture\n{activation}---\nTRUST_FIXTURE_CONTENT")).unwrap();
    }

    #[test]
    fn revoked_project_and_plugin_skills_are_hidden_from_activation_and_reload() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("project");
        let project_skills = cwd.join(".kcoder/skills");
        let plugin_skills = cwd.join(".kcoder/plugins/demo/skills");
        write_skill(&project_skills, "project-fixture", false);
        write_skill(&project_skills, "conditional-fixture", true);
        write_skill(&plugin_skills, "plugin-fixture", false);
        let config = temp.path().join("profile");
        let mut trust = kcoder_config::FolderTrustStore::load(&config);
        trust.trust(&cwd).unwrap();
        let mut registry =
            SkillRegistry::load_with_layers(&cwd, [&plugin_skills], None, true).unwrap();
        registry.project_trust_context = Some((cwd.clone(), Some(config.clone())));
        registry.require_folder_trust(&project_skills, &cwd, Some(config.clone()));
        registry.require_folder_trust(&plugin_skills, &cwd, Some(config.clone()));
        assert!(registry.get_active("project-fixture").is_some());
        assert!(registry.get_active("plugin-fixture").is_some());
        assert_eq!(registry.active_for_paths(&["src/lib.rs".into()]).len(), 1);
        trust.revoke(&cwd).unwrap();
        assert!(registry.is_trust_denied("project-fixture"));
        assert!(registry.is_trust_denied("plugin-fixture"));
        assert!(registry.get_active("project-fixture").is_none());
        assert!(registry.list().is_empty());
        assert!(registry.names().is_empty());
        assert_eq!(registry.iter_all().count(), 0);
        assert!(registry.active_for_paths(&["src/lib.rs".into()]).is_empty());
        write_skill(&project_skills, "new-after-revoke", false);
        let refreshed = registry
            .reload_with_external_dirs(&cwd, [&plugin_skills])
            .unwrap();
        assert!(refreshed.get_active("new-after-revoke").is_none());
        assert!(refreshed.get_active("plugin-fixture").is_none());
        trust.trust(&cwd).unwrap();
        let restored = refreshed
            .reload_with_external_dirs(&cwd, [&plugin_skills])
            .unwrap();
        assert!(restored.get_active("new-after-revoke").is_some());
        assert!(restored.get_active("plugin-fixture").is_some());
    }
}

#[cfg(test)]
mod discovery_budget_tests {
    use super::*;
    #[test]
    fn wide_root_is_rejected_with_source_instead_of_unbounded_scan() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..4097 {
            std::fs::write(tmp.path().join(format!("entry-{i}")), "").unwrap();
        }
        let error = SkillRegistry::default()
            .scan_dir(tmp.path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("budget exceeded"));
        assert!(error.contains(tmp.path().to_str().unwrap()));
    }
    #[cfg(unix)]
    #[test]
    fn loop_links_are_skipped_and_nested_directories_not_recursed() {
        let tmp = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(tmp.path(), tmp.path().join("loop")).unwrap();
        let deep = tmp.path().join("container/deeper");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("SKILL.md"), "---\nname: hidden\n---\nbody").unwrap();
        let mut registry = SkillRegistry::default();
        registry.scan_dir(tmp.path()).unwrap();
        assert!(registry.names().is_empty());
    }
}
