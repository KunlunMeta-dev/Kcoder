//! Native profile selection and configuration provenance remain explicit outside Agent bootstrap.
use super::*;
use kcoder_config::{ConfigScope, FolderTrust, FolderTrustStore, LoadedSettings, SettingsLoader};
use kcoder_migration::batch::BatchPlanPolicy;

pub(super) struct Context {
    pub profile: PathBuf,
    pub cwd: PathBuf,
    pub loaded: LoadedSettings,
}
impl Context {
    pub fn open(profile: &Path, cwd: Option<&Path>, overlays: &[PathBuf]) -> Result<Self> {
        let profile = absolute(profile, cwd)?
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("migration_target_unavailable"))?;
        kcoder_config::PrivateDirectory::open_existing(&profile)?
            .verify_trusted_config_directory()?;
        let cwd = absolute(Path::new("."), cwd)?.canonicalize()?;
        let overlays = overlays
            .iter()
            .map(|path| absolute(path, Some(&cwd)))
            .collect::<Result<Vec<_>>>()?;
        let loaded = SettingsLoader::new(&cwd)
            .with_config_dir(&profile)
            .with_overlay_files(overlays)
            .load()
            .map_err(|_| anyhow::anyhow!("migration_invalid_target_settings"))?;
        Ok(Self {
            profile,
            cwd,
            loaded,
        })
    }
    pub fn require_writable(&self, fields: &[&str]) -> Result<()> {
        let covered = |field: &str| {
            fields
                .iter()
                .any(|name| field == *name || field.starts_with(&format!("{name}.")))
        };
        ensure!(
            !self
                .loaded
                .overlay_fields
                .iter()
                .any(|field| covered(field))
                && !self
                    .loaded
                    .field_sources
                    .iter()
                    .any(|(field, scope)| covered(field)
                        && matches!(
                            scope,
                            ConfigScope::Executable | ConfigScope::Project | ConfigScope::Local
                        )),
            "migration_target_controlled_by_overlay"
        );
        Ok(())
    }
    pub fn trusted(&self, project: &Path) -> bool {
        FolderTrustStore::trust_all_from_environment()
            || FolderTrustStore::load(&self.profile).check(project) == FolderTrust::Trusted
    }
    pub fn catalog(
        &self,
        choices: &[kcoder_migration::batch::BatchResolution],
    ) -> Result<BatchPlanPolicy> {
        if choices.iter().all(|choice| {
            matches!(
                choice,
                kcoder_migration::batch::BatchResolution::Provider(_)
            )
        }) {
            return Ok(Default::default());
        }
        let settings = &self.loaded.settings;
        let plugins = kcoder_plugins::PluginManager::open_for_profile(
            &self.cwd,
            &self.profile,
            settings.plugins.clone(),
        )?
        .effective_snapshot(&self.cwd, self.trusted(&self.cwd))?;
        let mut roots = settings.skills.external_dirs.clone();
        roots.extend(plugins.skill_roots);
        let skills = kcoder_skills::SkillRegistry::load_for_profile(
            &self.cwd,
            roots,
            &self.profile,
            self.trusted(&self.cwd),
        )?;
        let reserved_skills = skills
            .list_catalog()
            .into_iter()
            .map(|skill| skill.name.clone())
            .chain(kcoder_skills::builtin::skill_names().map(str::to_owned))
            .collect();
        let reserved_mcp = settings
            .mcp_servers
            .iter()
            .chain(plugins.mcp_configs.iter())
            .map(|config| {
                kcoder_mcp_policy::mcp_tool_name(&config.name, "migration_namespace_probe")
            })
            .collect();
        Ok(BatchPlanPolicy {
            reserved_skills,
            reserved_mcp,
            ..Default::default()
        })
    }
}
