use crate::sources::{
    PluginSkillRoot, SkillCandidate, SkillCandidateInfo, SkillFamilyOverlap, SkillLayer,
};
use crate::{Skill, SkillStore, builtin, parse_skill_file};
use anyhow::{Context, Result};
use kcoder_config::SkillSourcePreferenceSettings;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{debug, warn};

#[derive(Debug, Default, Clone)]
pub struct SkillRegistry {
    /// Effective invocable winner per name; see [`crate::sources`] for precedence.
    skills: HashMap<String, Arc<Skill>>,
    /// Skill that users cannot invoke directly and that activates from touched paths.
    conditional: Vec<Arc<Skill>>,
    /// Every discovered copy, including shadowed ones kept only for inventory.
    candidates: Vec<SkillCandidate>,
    plugin_roots: Vec<PluginSkillRoot>,
    source_preference: SkillSourcePreferenceSettings,
    /// Names removed by host policy, such as training isolation.
    removed_names: BTreeSet<String>,
    trust_rules: Vec<SkillTrustRule>,
    project_trust_context: Option<(PathBuf, Option<PathBuf>)>,
    user_directory: Option<PathBuf>,
    disabled_names: BTreeSet<String>,
    enabled_imports: std::collections::BTreeMap<String, String>,
    scope_workspace: Option<(PathBuf, bool)>,
    runtime_names: BTreeSet<String>,
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

    /// Resolve a selected native profile; do not consult another profile's ambient user layer.
    pub fn load_for_profile<I, P>(
        cwd: &Path,
        external_dirs: I,
        config_dir: &Path,
        project_trusted: bool,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let user_dir = config_dir.join("skills");
        let mut registry =
            Self::load_with_layers(cwd, external_dirs, Some(&user_dir), project_trusted)?;
        registry.project_trust_context = Some((cwd.to_path_buf(), Some(config_dir.to_path_buf())));
        for root in project_skill_dirs(cwd, dirs::home_dir().as_deref()) {
            registry.require_folder_trust(&root, cwd, Some(config_dir.to_path_buf()));
        }
        Ok(registry)
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
            scope_workspace: Some((cwd.to_path_buf(), project_trusted)),
            enabled_imports: user_dir
                .and_then(Path::parent)
                .map(crate::activation::enabled_imports)
                .transpose()?
                .unwrap_or_default(),
            user_directory: user_dir.map(Path::to_path_buf),
            disabled_names: user_dir
                .and_then(Path::parent)
                .map(crate::activation::disabled)
                .transpose()?
                .unwrap_or_default(),
            ..Self::default()
        };

        // Load built-in skills first so later project, external, and user layers can override them by name.
        if let Some(user_dir) = user_dir {
            let builtin_dir = user_dir.join(builtin::BUILTIN_SKILLS_DIR_NAME);
            if builtin_dir.is_dir() {
                registry.scan_managed_dir(&builtin_dir, SkillLayer::Bundled)?;
            }
        }

        if project_trusted {
            let home_dir = dirs::home_dir();
            for dir in project_skill_dirs(cwd, home_dir.as_deref()) {
                registry.scan_managed_dir(&dir, SkillLayer::Project)?;
            }
        }

        for dir in external_dirs {
            let dir = dir.as_ref();
            if dir.is_dir() || dir.is_file() {
                registry.scan_dir(dir, SkillLayer::External)?;
            }
        }

        if let Some(user_dir) = user_dir
            && user_dir.is_dir()
        {
            registry.scan_managed_dir(user_dir, SkillLayer::User)?;
        }
        registry.resolve();
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
        refreshed.disabled_names = self.disabled_names.clone();
        refreshed.enabled_imports = self.enabled_imports.clone();
        refreshed.removed_names = self.removed_names.clone();
        refreshed.apply_source_policy(&self.plugin_roots, &self.source_preference);
        if let Some((directory, config_dir)) = &self.project_trust_context {
            for root in project_skill_dirs(cwd, dirs::home_dir().as_deref()) {
                refreshed.require_folder_trust(&root, directory, config_dir.clone());
            }
        }
        refreshed.inherit_trust_requirements(self);
        for name in &self.runtime_names {
            if let Some(skill) = self.skills.get(name) {
                refreshed.insert_runtime_skill(Skill::clone(skill))?;
            }
        }
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
        if let Some(root) = skill
            .activation
            .as_ref()
            .and_then(|activation| activation.workspace.as_ref())
        {
            let Some((cwd, trusted)) = &self.scope_workspace else {
                return false;
            };
            let Some(root) = root.canonicalize().ok() else {
                return false;
            };
            if !cwd
                .canonicalize()
                .ok()
                .is_some_and(|cwd| cwd.starts_with(&root))
            {
                return false;
            }
            let profile = self.user_directory.as_ref().and_then(|root| root.parent());
            if !kcoder_config::FolderTrustStore::trust_all_from_environment()
                && (!trusted
                    || !profile.is_some_and(|profile| {
                        kcoder_config::FolderTrustStore::load(profile).check(&root)
                            == kcoder_config::FolderTrust::Trusted
                    }))
            {
                return false;
            }
        }
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
        self.lookup(name).is_some_and(|skill| !self.trusted(skill))
    }

    pub fn empty() -> Self {
        Self::default()
    }

    /// A caller-owned immutable snapshot supplies the source; normal activation guards still apply.
    pub fn insert_runtime_skill(&mut self, skill: Skill) -> Result<()> {
        anyhow::ensure!(
            skill.name.starts_with("expert:"),
            "runtime skill namespace required"
        );
        anyhow::ensure!(
            !self.skills.contains_key(&skill.name)
                && !self
                    .conditional
                    .iter()
                    .any(|existing| existing.name == skill.name),
            "runtime skill name collision"
        );
        self.runtime_names.insert(skill.name.clone());
        self.skills.insert(skill.name.clone(), Arc::new(skill));
        Ok(())
    }

    pub fn clear_runtime_expert_skills(&mut self) {
        self.skills
            .retain(|name, _| !self.runtime_names.contains(name));
        self.runtime_names.clear();
    }

    pub fn runtime_skill_names(&self) -> &BTreeSet<String> {
        &self.runtime_names
    }

    fn scan_dir(&mut self, root: &Path, layer: SkillLayer) -> Result<()> {
        for skill_file in crate::skill_entry_paths(root)? {
            match parse_skill_file(&skill_file) {
                Ok(skill) => {
                    debug!("loaded skill {} from {:?}", skill.name, skill_file);
                    let layer = if layer == SkillLayer::Bundled
                        && builtin::skill_names().any(|name| name == skill.name)
                    {
                        SkillLayer::Builtin
                    } else {
                        layer
                    };
                    let order = self.candidates.len();
                    self.candidates.push(SkillCandidate {
                        skill: Arc::new(skill),
                        layer,
                        plugin_id: None,
                        marketplace_id: None,
                        order,
                    });
                }
                Err(error) => warn!("failed to parse skill {:?}: {}", skill_file, error),
            }
        }
        Ok(())
    }

    fn scan_managed_dir(&mut self, root: &Path, layer: SkillLayer) -> Result<()> {
        let store = SkillStore::open(root)
            .with_context(|| format!("failed to open managed skill root {:?}", root))?;
        let snapshot = store
            .snapshot()
            .with_context(|| format!("failed to recover managed skill root {:?}", root))?;
        self.scan_dir(snapshot.root(), layer)
    }

    /// Rebuild the effective projection from all candidates.
    fn resolve(&mut self) {
        let runtime: Vec<Arc<Skill>> = self
            .runtime_names
            .iter()
            .filter_map(|name| self.skills.get(name).cloned())
            .collect();
        self.skills.clear();
        self.conditional.clear();
        for (_, index) in crate::sources::effective_winners(
            &self.candidates,
            &self.source_preference,
            &self.removed_names,
        ) {
            let skill = Arc::clone(&self.candidates[index].skill);
            if skill.user_invocable {
                self.skills.insert(skill.name.clone(), skill);
            } else {
                self.conditional.push(skill);
            }
        }
        for skill in runtime {
            self.skills.insert(skill.name.clone(), skill);
        }
    }

    /// Attribute plugin-root candidates to their plugin and apply the user's
    /// same-name source preference. Later reloads keep this policy.
    pub fn apply_source_policy(
        &mut self,
        plugin_roots: &[PluginSkillRoot],
        preference: &SkillSourcePreferenceSettings,
    ) {
        self.plugin_roots = plugin_roots.to_vec();
        self.source_preference = preference.clone();
        crate::sources::tag_plugin_candidates(&mut self.candidates, &self.plugin_roots);
        self.resolve();
    }

    pub fn source_preference(&self) -> &SkillSourcePreferenceSettings {
        &self.source_preference
    }

    /// Every discovered copy with its layer and effective/shadowed state.
    /// Shadowed bodies never reach prompts; this is metadata only.
    pub fn source_candidates(&self) -> Vec<SkillCandidateInfo> {
        let winners = crate::sources::effective_winners(
            &self.candidates,
            &self.source_preference,
            &self.removed_names,
        );
        let mut items: Vec<SkillCandidateInfo> = self
            .candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| SkillCandidateInfo {
                name: candidate.skill.name.clone(),
                description: candidate.skill.description.clone(),
                path: candidate.skill.source.clone(),
                layer: candidate.layer,
                plugin_id: candidate.plugin_id.clone(),
                marketplace_id: candidate.marketplace_id.clone(),
                version: candidate.skill.version.clone(),
                user_invocable: candidate.skill.user_invocable,
                effective: winners.get(&candidate.skill.name) == Some(&index),
                preferred: candidate.preferred(&self.source_preference),
                removed: self.removed_names.contains(&candidate.skill.name),
                trusted: self.trusted(&candidate.skill),
            })
            .collect();
        items.extend(self.runtime_names.iter().filter_map(|name| {
            self.skills.get(name).map(|skill| SkillCandidateInfo {
                name: skill.name.clone(),
                description: skill.description.clone(),
                path: skill.source.clone(),
                layer: SkillLayer::Runtime,
                plugin_id: None,
                marketplace_id: None,
                version: skill.version.clone(),
                user_invocable: skill.user_invocable,
                effective: true,
                preferred: false,
                removed: false,
                trusted: self.trusted(skill),
            })
        }));
        items
    }

    /// Simulate one plugin's copy of `name` against every other current copy,
    /// for install previews. The plugin's existing copies are excluded.
    pub fn preview_plugin_copy(
        &self,
        name: &str,
        plugin_id: &str,
    ) -> crate::sources::PluginCopyPreview {
        let others: Vec<(usize, &SkillCandidate)> = self
            .candidates
            .iter()
            .enumerate()
            .filter(|(_, candidate)| {
                candidate.skill.name == name && candidate.plugin_id.as_deref() != Some(plugin_id)
            })
            .collect();
        let mut simulated: Vec<SkillCandidate> = others
            .iter()
            .map(|(_, candidate)| (*candidate).clone())
            .collect();
        let existing = crate::sources::effective_winners(
            &simulated,
            &self.source_preference,
            &self.removed_names,
        )
        .get(name)
        .copied();
        let existing_info = existing.map(|index| {
            let original = others[index].0;
            self.source_candidates().swap_remove(original)
        });
        simulated.push(SkillCandidate {
            skill: Arc::new(crate::sources::placeholder_skill(name, PathBuf::new())),
            layer: SkillLayer::Plugin,
            plugin_id: Some(plugin_id.to_owned()),
            marketplace_id: None,
            order: self.candidates.len(),
        });
        let winner = crate::sources::effective_winners(
            &simulated,
            &self.source_preference,
            &self.removed_names,
        )
        .get(name)
        .copied();
        crate::sources::PluginCopyPreview {
            existing: existing_info,
            plugin_wins: winner == Some(simulated.len() - 1),
        }
    }

    /// Plugins providing only part of a bundled skill family, or mixing versions.
    pub fn family_overlaps(&self) -> Vec<SkillFamilyOverlap> {
        let winners = crate::sources::effective_winners(
            &self.candidates,
            &self.source_preference,
            &self.removed_names,
        );
        crate::sources::family_overlaps(&self.candidates, &winners)
    }

    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills
            .get(name)
            .map(Arc::as_ref)
            .filter(|skill| self.is_enabled(&skill.name) && self.trusted(skill))
    }

    pub fn get_active(&self, name: &str) -> Option<&Skill> {
        self.lookup(name)
            .filter(|skill| self.is_enabled(&skill.name) && self.trusted(skill))
    }

    /// Resolve a renamed bundled skill's former name to its current name when no
    /// skill (enabled or not) is registered under the former name.
    pub fn resolve_renamed(&self, name: &str) -> String {
        if self.lookup(name).is_some() {
            return name.to_owned();
        }
        crate::builtin::renamed_builtin_skill(name)
            .filter(|current| self.lookup(current).is_some())
            .unwrap_or(name)
            .to_owned()
    }

    fn lookup(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name).map(Arc::as_ref).or_else(|| {
            self.conditional
                .iter()
                .find(|skill| skill.name == name)
                .map(Arc::as_ref)
        })
    }

    fn effective(&self) -> impl Iterator<Item = &Skill> {
        self.skills
            .values()
            .chain(self.conditional.iter())
            .map(Arc::as_ref)
    }

    pub fn list(&self) -> Vec<&Skill> {
        self.skills
            .values()
            .map(Arc::as_ref)
            .filter(|skill| self.is_enabled(&skill.name) && self.trusted(skill))
            .collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.list().iter().map(|skill| skill.name.clone()).collect()
    }

    pub fn is_enabled(&self, name: &str) -> bool {
        if self.disabled_names.contains(name) {
            return false;
        }
        self.lookup(name)
            .and_then(|skill| skill.activation.as_ref())
            .is_none_or(|activation| {
                activation.default_enabled
                    || self.enabled_imports.get(name) == Some(&activation.token)
            })
    }

    /// Management can display installed, trusted entries even when disabled.
    /// Invocation and automatic activation continue to use the filtered APIs.
    pub fn list_catalog(&self) -> Vec<&Skill> {
        self.effective()
            .filter(|skill| self.trusted(skill))
            .collect()
    }

    pub fn remove_named(&mut self, name: &str) -> bool {
        // Runtime names are caller-owned snapshots and may be inserted again;
        // discovered names stay removed across source-policy reloads.
        if !self.runtime_names.remove(name) {
            self.removed_names.insert(name.to_owned());
        }
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
        self.effective()
            .filter(|skill| self.is_enabled(&skill.name) && self.trusted(skill))
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

    #[test]
    fn disabled_entries_remain_installed_but_new_snapshots_cannot_invoke_or_auto_activate() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let user = profile.join("skills");
        let project = root.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        write_skill(&user, "invocable", false);
        write_skill(&user, "conditional", true);
        let before = SkillRegistry::load_with_layers(
            &project,
            std::iter::empty::<PathBuf>(),
            Some(&user),
            true,
        )
        .unwrap();
        crate::activation::set_enabled(&profile, "invocable", false).unwrap();
        crate::activation::set_enabled(&profile, "conditional", false).unwrap();
        assert!(before.get("invocable").is_some());
        assert_eq!(before.active_for_paths(&["src/lib.rs".into()]).len(), 1);
        let after = SkillRegistry::load_with_layers(
            &project,
            std::iter::empty::<PathBuf>(),
            Some(&user),
            true,
        )
        .unwrap();
        assert!(after.get("invocable").is_none());
        assert!(after.get_active("conditional").is_none());
        assert!(after.list().is_empty());
        assert_eq!(after.iter_all().count(), 0);
        assert!(after.active_for_paths(&["src/lib.rs".into()]).is_empty());
        assert_eq!(after.list_catalog().len(), 2);
        assert!(user.join("invocable/SKILL.md").is_file());
        assert!(
            before
                .reload_with_external_dirs(&project, std::iter::empty::<PathBuf>())
                .unwrap()
                .get("invocable")
                .is_some()
        );
        crate::activation::set_enabled(&profile, "invocable", true).unwrap();
        let restored = SkillRegistry::load_with_layers(
            &project,
            std::iter::empty::<PathBuf>(),
            Some(&user),
            true,
        )
        .unwrap();
        assert!(restored.get("invocable").is_some());
        assert!(restored.get_active("conditional").is_none());
    }

    #[test]
    fn imported_skill_tokens_do_not_reenable_replacements_and_project_scope_survives_user_installation()
     {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let user = profile.join("skills");
        let project = root.path().join("project");
        let other = root.path().join("other");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        write_skill(&user, "imported", false);
        let path = user.join("imported/SKILL.md");
        let write = |token: &str| {
            let activation = crate::SkillActivation {
                token: token.into(),
                default_enabled: false,
                workspace: Some(project.clone()),
            };
            std::fs::write(&path,format!("---\nname: imported\ndescription: Fixture\nactivation:\n{}---\nIMPORTED_SCOPE_FIXTURE",serde_yaml::to_string(&activation).unwrap().lines().map(|line|format!("  {line}\n")).collect::<String>())).unwrap();
        };
        write("first-import");
        let mut trust = kcoder_config::FolderTrustStore::load(&profile);
        trust.trust(&project).unwrap();
        let load = |cwd: &Path| {
            SkillRegistry::load_with_layers(cwd, std::iter::empty::<PathBuf>(), Some(&user), true)
                .unwrap()
        };
        assert!(load(&project).get_active("imported").is_none());
        crate::activation::set_enabled_for_import(&profile, "imported", true, Some("first-import"))
            .unwrap();
        let first = load(&project);
        assert!(first.get_active("imported").is_some());
        assert!(load(&other).list_catalog().is_empty());
        write("second-import");
        assert!(load(&project).get_active("imported").is_none());
        crate::activation::set_enabled_for_import(
            &profile,
            "imported",
            true,
            Some("second-import"),
        )
        .unwrap();
        let second = load(&project);
        assert!(second.get_active("imported").is_some());
        trust.revoke(&project).unwrap();
        assert!(second.get_active("imported").is_none());
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
        let root = tmp.path().canonicalize().unwrap();
        let error = SkillRegistry::default()
            .scan_dir(&root, SkillLayer::External)
            .unwrap_err()
            .to_string();
        assert!(error.contains("budget exceeded"));
        assert!(error.contains(&format!("{root:?}")), "{error}");
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
        registry.scan_dir(tmp.path(), SkillLayer::External).unwrap();
        registry.resolve();
        assert!(registry.names().is_empty());
    }
}
