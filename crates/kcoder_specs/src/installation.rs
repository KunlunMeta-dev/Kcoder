//! Spec installation domain implementation.

use super::*;

/// Initialize the spec subsystem for a project.
///
/// Creates the default directory layout, a starter spec, and the auto-triggered
/// `using-specs` skill. Existing skill files are left untouched.
pub fn init(cwd: &Path) -> Result<PathBuf> {
    init_with_force(cwd, false)
}

/// Initialize the spec subsystem, optionally overwriting existing skill files.
///
/// When `force_update` is true, bundled Superpowers skills are reinstalled even
/// if they already exist on disk. Project-owned configuration and authoritative
/// specs are always preserved. This is useful after upgrading KCoder.
pub fn init_with_force(cwd: &Path, force_update: bool) -> Result<PathBuf> {
    init_with_force_report(cwd, force_update).map(|(path, _)| path)
}

/// Same as init_with_force, while also returning the skill transaction receipt produced by this run.
pub fn init_with_force_report(
    cwd: &Path,
    force_update: bool,
) -> Result<(PathBuf, Vec<kcoder_skills::SkillCommitReceipt>)> {
    let specs_dir = specs_dir_for(cwd);
    let domain_dir = specs_dir.join("specs").join("core");
    let changes_dir = specs_dir.join("changes");
    let archive_dir = changes_dir.join("archive");
    let skills_root = cwd.join(".kcoder").join("skills");

    fs::create_dir_all(&domain_dir)
        .with_context(|| format!("failed to create {:?}", domain_dir))?;
    fs::create_dir_all(&changes_dir)
        .with_context(|| format!("failed to create {:?}", changes_dir))?;
    fs::create_dir_all(&archive_dir)
        .with_context(|| format!("failed to create {:?}", archive_dir))?;

    let spec_path = domain_dir.join("spec.md");
    if !spec_path.exists() {
        fs::write(&spec_path, DEFAULT_SPEC)
            .with_context(|| format!("failed to write {:?}", spec_path))?;
    }

    let config_path = specs_dir.join(config::CONFIG_FILE);
    if !config_path.exists() {
        fs::write(&config_path, config::DEFAULT_CONFIG)
            .with_context(|| format!("failed to write {:?}", config_path))?;
    }
    let config = read_validated_project_config(&specs_dir)?;

    let store = SkillStore::open(&skills_root).context("failed to open spec skill store")?;
    let mut mutations = Vec::new();
    let mut metadata = SkillMetadataDelta::default();

    let using_specs = SkillPackage {
        name: "using-specs".to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: render_using_specs_skill(Some(&config)).into_bytes(),
            executable: false,
        }],
    };
    plan_spec_package(
        &store,
        using_specs,
        force_update,
        false,
        &mut mutations,
        &mut metadata,
    )?;

    // Stage and publish each built-in skill body and all companion files as one complete package.
    for (name, content) in SUPERPOWER_SKILLS {
        let mut files = vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: content.as_bytes().to_vec(),
            executable: false,
        }];
        for asset in SUPERPOWER_SKILL_ASSETS
            .iter()
            .filter(|asset| asset.skill == *name)
        {
            files.push(SkillPackageFile {
                relative_path: PathBuf::from(asset.relative_path),
                content: asset.content.as_bytes().to_vec(),
                executable: bundled_skill_asset_is_executable(name, asset.relative_path),
            });
        }
        plan_spec_package(
            &store,
            SkillPackage {
                name: (*name).to_string(),
                files,
            },
            force_update,
            true,
            &mut mutations,
            &mut metadata,
        )?;
    }

    let mut receipts = Vec::new();
    if !mutations.is_empty() || metadata != SkillMetadataDelta::default() {
        let operation_id = spec_operation_id("init", force_update, &store, &mutations)?;
        let receipt = store
            .commit(SkillCommitRequest {
                operation_id,
                actor: SkillMutationActor::SpecInit {
                    session_id: None,
                    force_update,
                },
                operation: SkillOperationKind::SpecSync,
                preconditions: Vec::new(),
                mutations,
                metadata,
            })
            .context("failed to publish spec skills")?;
        receipts.push(receipt);
    }

    debug!("initialized spec subsystem at {:?}", specs_dir);
    Ok((specs_dir, receipts))
}

/// Regenerate the auto-triggered `using-specs` skill from config.yaml.
pub fn sync_using_specs_skill(cwd: &Path) -> Result<PathBuf> {
    sync_using_specs_skill_report(cwd).map(|(path, _)| path)
}

/// Same as sync_using_specs_skill, while also returning the on-disk commit receipt.
pub fn sync_using_specs_skill_report(
    cwd: &Path,
) -> Result<(PathBuf, kcoder_skills::SkillCommitReceipt)> {
    let specs_dir = specs_dir_for(cwd);
    let skills_root = cwd.join(".kcoder").join("skills");
    let skill_dir = skills_root.join("using-specs");
    let config = read_validated_project_config(&specs_dir)?;
    let skill_path = skill_dir.join("SKILL.md");
    let store = SkillStore::open(&skills_root).context("failed to open spec skill store")?;
    let desired = SkillPackage {
        name: "using-specs".to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: render_using_specs_skill(Some(&config)).into_bytes(),
            executable: false,
        }],
    };
    let expected = store
        .current_revision("using-specs")
        .context("failed to read using-specs revision")?
        .map(ExpectedSkillRevision::Exact)
        .unwrap_or(ExpectedSkillRevision::Absent);
    let mut metadata = SkillMetadataDelta::default();
    record_spec_metadata(&mut metadata, &desired, false)?;
    let mutations = vec![SkillMutation::PutPackage {
        package: desired,
        expected,
    }];
    let receipt = store
        .commit(SkillCommitRequest {
            operation_id: spec_operation_id("sync", false, &store, &mutations)?,
            actor: SkillMutationActor::SpecInit {
                session_id: None,
                force_update: false,
            },
            operation: SkillOperationKind::SpecSync,
            preconditions: Vec::new(),
            mutations,
            metadata,
        })
        .context("failed to publish using-specs skill")?;
    Ok((skill_path, receipt))
}

pub(super) fn plan_spec_package(
    store: &SkillStore,
    desired: SkillPackage,
    force_update: bool,
    manage_bundled_assets: bool,
    mutations: &mut Vec<SkillMutation>,
    metadata: &mut SkillMetadataDelta,
) -> Result<()> {
    let live = store.root().join(&desired.name);
    if force_update {
        record_spec_metadata(metadata, &desired, true)?;
        mutations.push(SkillMutation::PutPackage {
            package: desired,
            expected: ExpectedSkillRevision::Unconditional,
        });
        return Ok(());
    }

    if !live.join("SKILL.md").is_file() {
        record_spec_metadata(metadata, &desired, false)?;
        mutations.push(SkillMutation::PutPackage {
            package: desired,
            expected: ExpectedSkillRevision::Absent,
        });
        return Ok(());
    }
    if !manage_bundled_assets {
        return Ok(());
    }

    // Fill in missing assets only when the body still exactly matches the embedded version; do not inject files into user-modified skills.
    let desired_main = desired
        .files
        .iter()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .expect("spec package always has SKILL.md");
    let current_main = fs::read(live.join("SKILL.md"))
        .with_context(|| format!("failed to read bundled skill '{}'", desired.name))?;
    if current_main != desired_main.content {
        return Ok(());
    }
    let mut current = store
        .read_package(&desired.name)
        .with_context(|| format!("failed to read bundled skill '{}'", desired.name))?
        .context("bundled skill disappeared while planning")?;
    let current_revision = canonical_package_revision(&current)?;
    let missing = desired
        .files
        .iter()
        .filter(|file| {
            file.relative_path != Path::new("SKILL.md")
                && !current
                    .files
                    .iter()
                    .any(|current_file| current_file.relative_path == file.relative_path)
        })
        .cloned()
        .collect::<Vec<_>>();
    let changed = !missing.is_empty();
    current.files.extend(missing);
    if changed {
        record_spec_metadata(metadata, &current, false)?;
        mutations.push(SkillMutation::PutPackage {
            package: current,
            expected: ExpectedSkillRevision::Exact(current_revision),
        });
    }
    Ok(())
}

pub(super) fn record_spec_metadata(
    metadata: &mut SkillMetadataDelta,
    package: &SkillPackage,
    force_update: bool,
) -> Result<()> {
    let revision = canonical_package_revision(package)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut provenance = SkillMetadataPatch::default();
    provenance
        .create
        .insert("created_at".to_string(), Value::String(now.clone()));
    provenance.create.insert(
        "created_by".to_string(),
        Value::String("kcoder".to_string()),
    );
    provenance
        .update
        .insert("origin".to_string(), Value::String("bundled".to_string()));
    provenance.update.insert(
        "write_origin".to_string(),
        Value::String(if force_update {
            "spec_init_force".to_string()
        } else {
            "spec_init".to_string()
        }),
    );
    provenance
        .update
        .insert("bundled_hash".to_string(), Value::String(revision.0));
    metadata.provenance.insert(package.name.clone(), provenance);

    let mut usage = SkillMetadataPatch::default();
    usage
        .create
        .insert("created_at".to_string(), Value::String(now));
    usage
        .create
        .insert("state".to_string(), Value::String("active".to_string()));
    usage
        .create
        .insert("pinned".to_string(), Value::Bool(false));
    metadata.usage.insert(package.name.clone(), usage);
    Ok(())
}

pub(super) fn spec_operation_id(
    kind: &str,
    force_update: bool,
    store: &SkillStore,
    mutations: &[SkillMutation],
) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([u8::from(force_update)]);
    hasher.update(serde_json::to_vec(mutations).context("failed to hash spec mutation plan")?);
    for name in mutation_skill_names(mutations) {
        hasher.update(name.as_bytes());
        match store.current_revision(&name) {
            Ok(Some(revision)) => hasher.update(revision.0.as_bytes()),
            Ok(None) => hasher.update(b"absent"),
            Err(_) => hasher.update(b"invalid"),
        }
    }
    Ok(format!("spec-{kind}-{:x}", hasher.finalize()))
}

pub(super) fn mutation_skill_names(mutations: &[SkillMutation]) -> Vec<String> {
    let mut names = mutations
        .iter()
        .flat_map(|mutation| match mutation {
            SkillMutation::PutPackage { package, .. } => vec![package.name.clone()],
            SkillMutation::PatchFile { name, .. }
            | SkillMutation::PatchText { name, .. }
            | SkillMutation::RemoveFile { name, .. }
            | SkillMutation::Archive { name, .. }
            | SkillMutation::Restore { name, .. } => vec![name.clone()],
            SkillMutation::Consolidate {
                sources,
                destination,
                ..
            } => sources
                .iter()
                .map(|(name, _)| name.clone())
                .chain(std::iter::once(destination.name.clone()))
                .collect(),
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}
