//! Adapt declarative Markdown commands/agents; discovery never executes their text.
use crate::model::LoadedPluginManifest;
use anyhow::{Context, Result, bail, ensure};
use kcoder_types::plugin_prompt::PluginPromptProfile;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq)]
pub struct PromptEntry {
    pub kind: String,
    pub name: String,
    pub description: String,
    pub source: PathBuf,
    pub profile: PluginPromptProfile,
    pub inherited_model: bool,
    pub inherited_permissions: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSummary {
    pub name: String,
    pub description: String,
    pub source: PathBuf,
    pub kind: String,
}
impl PromptEntry {
    pub fn invocation_name(&self, plugin_id: &str) -> String {
        format!(
            "plugin:{}:{}:{}",
            plugin_id.replace('@', ":"),
            self.kind,
            self.name
        )
    }
    pub fn summary(&self, plugin_id: &str) -> PromptSummary {
        PromptSummary {
            name: self.invocation_name(plugin_id),
            description: self.description.clone(),
            source: self.source.clone(),
            kind: self.kind.clone(),
        }
    }
}
fn files(path: &Path, depth: usize, output: &mut Vec<PathBuf>, visited: &mut usize) -> Result<()> {
    *visited += 1;
    ensure!(*visited <= 4096, "plugin prompt scan exceeds 4096 entries");
    ensure!(
        depth <= 8 && output.len() < 256,
        "plugin prompt directory exceeds scan limits"
    );
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "plugin prompt paths cannot be symbolic links"
    );
    if metadata.is_file() {
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            output.push(path.to_path_buf());
        }
        return Ok(());
    }
    ensure!(
        metadata.is_dir(),
        "plugin prompt path is not a regular file or directory"
    );
    let mut entries = fs::read_dir(path)?
        .take(257)
        .collect::<std::io::Result<Vec<_>>>()?;
    ensure!(
        entries.len() <= 256,
        "plugin prompt directory exceeds scan limits"
    );
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        files(&entry.path(), depth + 1, output, visited)?;
    }
    Ok(())
}
fn string_list(value: &serde_yaml::Value) -> Result<Vec<String>> {
    match value {
        serde_yaml::Value::String(text) => Ok(text
            .split(|c: char| c == ',' || c.is_ascii_whitespace())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()),
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .context("tool entries must be strings")
            })
            .collect(),
        _ => bail!("tools must be a comma-separated string or array"),
    }
}
fn parse(root: &Path, source: &Path, kind: &str) -> Result<PromptEntry> {
    let directory = kcoder_config::PrivateDirectory::open_existing(
        source.parent().context("missing prompt parent")?,
    )?;
    let file = directory.open_regular_file(source.file_name().context("missing prompt file")?)?;
    let mut content = String::new();
    file.take(128 * 1024 + 1).read_to_string(&mut content)?;
    ensure!(content.len() <= 128 * 1024, "plugin prompt exceeds 128 KiB");
    let content = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (front, body) = if let Some(rest) = content.strip_prefix("---\n") {
        let (front, body) = rest
            .split_once("\n---")
            .context("unterminated prompt frontmatter")?;
        (
            serde_yaml::from_str::<serde_yaml::Value>(front)?,
            body.trim(),
        )
    } else {
        (serde_yaml::Value::Null, content.trim())
    };
    ensure!(!body.is_empty(), "plugin prompt is empty");
    for remainder in body.split("${CLAUDE_").skip(1) {
        if let Some((variable, _)) = remainder.split_once('}') {
            ensure!(
                matches!(
                    variable,
                    "PLUGIN_ROOT" | "SKILL_DIR" | "PROJECT_DIR" | "SESSION_ID"
                ),
                "unsupported host variable CLAUDE_{variable}"
            );
        }
    }

    ensure!(
        !body.contains("!`"),
        "inline shell expansion is not supported; execute explicit tools instead"
    );
    for key in [
        "hooks",
        "skills",
        "permissionMode",
        "disallowedTools",
        "memory",
        "isolation",
        "background",
        "disable-model-invocation",
    ] {
        ensure!(
            front.get(key).is_none_or(|value| value.is_null()
                || value.as_bool() == Some(false)
                || value.as_sequence().is_some_and(Vec::is_empty)
                || value.as_mapping().is_some_and(|map| map.is_empty())
                || value.as_str().is_some_and(
                    |text| text.is_empty() || matches!(text, "inherit" | "default" | "none")
                )),
            "plugin prompt field {key} is not supported"
        );
    }
    // tools restricts a sub-agent; allowed-tools is a vendor pre-approval,
    // not an allowlist. Do not import privilege grants from plugin content.
    let allowed_tools = front.get("tools").map(string_list).transpose()?;
    let argument_names = front
        .get("arguments")
        .map(string_list)
        .transpose()?
        .unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    ensure!(
        argument_names.len() <= 32
            && argument_names.iter().all(|name| {
                !name.is_empty()
                    && name != "ARGUMENTS"
                    && !name.as_bytes()[0].is_ascii_digit()
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && seen.insert(name.clone())
            }),
        "argument names must be distinct identifiers"
    );
    if let Some(tools) = &allowed_tools {
        ensure!(
            tools.len() <= 64
                && tools.iter().all(|s| !s.is_empty()
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))),
            "tool patterns/argument-specific permissions require an adapter; plain tool names are supported"
        );
    }
    let max_turns = front
        .get("maxTurns")
        .or_else(|| front.get("max_turns"))
        .map(|v| {
            v.as_u64()
                .filter(|n| (1..=100).contains(n))
                .map(|n| n as usize)
                .context("maxTurns must be 1..100")
        })
        .transpose()?;
    let relative = source.strip_prefix(root)?.to_string_lossy();
    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = format!("{:x}", Sha256::digest(relative.as_bytes()));
    let name = format!(
        "{}-{}",
        if stem.trim_matches('-').is_empty() {
            "prompt"
        } else {
            stem.trim_matches('-')
        },
        &hash[..8]
    );
    let description = front
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or(&stem)
        .to_owned();
    Ok(PromptEntry {
        kind: kind.into(),
        name,
        description,
        source: source.to_path_buf(),
        inherited_permissions: front.get("allowed-tools").is_some(),
        inherited_model: front
            .get("model")
            .and_then(|v| v.as_str())
            .is_some_and(|m| m != "inherit"),
        profile: PluginPromptProfile {
            instructions: body.into(),
            argument_names,
            plugin_root: root.to_string_lossy().into_owned(),
            source: source.to_string_lossy().into_owned(),
            kind: kind.into(),
            allowed_tools,
            max_turns,
        },
    })
}
pub(crate) fn inspect(root: &Path, loaded: &mut LoadedPluginManifest) {
    for (kind, resources) in [
        ("command", loaded.manifest.contributions.commands.clone()),
        ("agent", loaded.manifest.contributions.agents.clone()),
    ] {
        if resources.is_empty() {
            continue;
        }
        let capability = format!("{kind}s");
        let mut paths = Vec::new();
        let mut visited = 0;
        let mut failures = Vec::new();
        for resource in resources {
            if let Err(error) = files(&resource.absolute_path, 0, &mut paths, &mut visited) {
                failures.push(error.to_string());
            }
        }
        paths.sort();
        paths.dedup();
        let before = loaded.prompt_entries.len();
        for path in paths {
            match parse(root, &path, kind) {
                Ok(entry) => loaded.prompt_entries.push(entry),
                Err(error) => failures.push(format!(
                    "{}: {error}",
                    path.strip_prefix(root).unwrap_or(&path).display()
                )),
            }
        }
        if loaded.prompt_entries.len() > before {
            loaded.compatibility.activate_capability(&capability);
            if loaded.prompt_entries[before..]
                .iter()
                .any(|entry| entry.inherited_model)
            {
                loaded.compatibility.add_issue("model_inherited", Some(&capability), "Plugin prompt model aliases use the current KCoder provider/model, not the vendor's model alias");
            }
        }
        if loaded.prompt_entries[before..]
            .iter()
            .any(|entry| entry.inherited_permissions)
        {
            loaded.compatibility.add_issue(
                "permissions_inherited",
                Some(&capability),
                "Plugin tool pre-approvals are not imported; normal parent permissions apply",
            );
        }
        for failure in failures {
            loaded.compatibility.add_issue(
                "prompt_adapter_unsupported",
                Some(&capability),
                failure,
            );
        }
    }
}
pub(crate) fn materialize(
    plugin_id: &str,
    entries: &[PromptEntry],
) -> Result<std::sync::Arc<kcoder_config::PrivateTempDir>> {
    type Cache = std::collections::BTreeMap<String, std::sync::Weak<kcoder_config::PrivateTempDir>>;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let mut digest = Sha256::new();
    digest.update(plugin_id.as_bytes());
    for entry in entries {
        digest.update(entry.name.as_bytes());
        digest.update(entry.description.as_bytes());
        digest.update(serde_json::to_vec(&entry.profile)?);
    }
    let key = format!("{:x}", digest.finalize());
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    cache.retain(|_, lease| lease.strong_count() > 0);
    if let Some(lease) = cache
        .get(&key)
        .and_then(std::sync::Weak::upgrade)
        .filter(|lease| lease.path().is_dir())
    {
        return Ok(lease);
    }
    let temp = kcoder_config::create_private_temp_dir("kcoder-plugin-prompts")?;
    for (index, entry) in entries.iter().enumerate() {
        let root = temp.path().join(format!("entry-{index}"));
        fs::create_dir(&root)?;
        let name = entry.invocation_name(plugin_id);
        let description = format!(
            "{} (plugin {}; runs as an isolated delegated task)",
            entry.description, entry.kind
        );
        let content = format!(
            "---\nname: {}\ndescription: {}\nrequires_tools: [spawn_agent]\nmetadata:\n  kcoder:\n    category: plugin-prompt\n---\nUse spawn_agent with plugin_agent={}, message containing the user's task/arguments, and context_mode=recent. Do not execute this profile inline. The child inherits the current provider and parent permissions; declared tool restrictions are enforced.\n\nOriginal plugin instructions (for inspection only):\n{}\n",
            json!(name),
            json!(description),
            json!(name),
            entry.profile.instructions
        );
        fs::write(root.join("SKILL.md"), content)?;
        fs::write(
            root.join("plugin-agent.json"),
            serde_json::to_vec(&entry.profile)?,
        )?;
    }
    let lease = std::sync::Arc::new(temp);
    cache.insert(key, std::sync::Arc::downgrade(&lease));
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_prompt_entries_become_callable_namespaced_skills_without_executing() {
        let root = tempfile::tempdir().unwrap();
        for dir in [".claude-plugin", "commands", "agents"] {
            fs::create_dir(root.path().join(dir)).unwrap();
        }
        fs::write(
            root.path().join(".claude-plugin/plugin.json"),
            r#"{"name":"demo"}"#,
        )
        .unwrap();
        fs::write(root.path().join("commands/check.md"), "---\ndescription: Check a task\nallowed-tools: Read, Grep\n---\nCheck $ARGUMENTS and $1").unwrap();
        fs::write(root.path().join("agents/reviewer.md"), "---\ndescription: Review code\ntools: [Read, Grep]\nmodel: sonnet\nmaxTurns: 3\n---\nInspect files and report issues.").unwrap();
        fs::write(
            root.path().join("commands/shell.md"),
            "---\ndescription: Dynamic shell\n---\n!`touch forbidden`",
        )
        .unwrap();
        let loaded = crate::load_plugin_manifest(root.path()).unwrap().unwrap();
        assert_eq!(loaded.prompt_entries.len(), 2);
        for capability in ["commands", "agents"] {
            assert!(
                loaded
                    .compatibility
                    .supported_capabilities
                    .iter()
                    .any(|v| v == capability)
            );
        }
        assert!(
            loaded
                .compatibility
                .issues
                .iter()
                .any(|v| v.code == "prompt_adapter_unsupported")
        );
        assert!(!root.path().join("forbidden").exists());
        let lease = materialize("demo@market", &loaded.prompt_entries).unwrap();
        for (index, entry) in loaded.prompt_entries.iter().enumerate() {
            let path = lease.path().join(format!("entry-{index}"));
            let skill = kcoder_skills::parse_skill_file(&path.join("SKILL.md")).unwrap();
            assert_eq!(skill.name, entry.invocation_name("demo@market"));
            assert_eq!(skill.category.as_deref(), Some("plugin-prompt"));
            assert!(skill.content.contains("spawn_agent"));
            let profile: PluginPromptProfile =
                serde_json::from_slice(&fs::read(path.join("plugin-agent.json")).unwrap()).unwrap();
            assert_eq!(
                profile.allowed_tools,
                if entry.kind == "agent" {
                    Some(vec!["Read".into(), "Grep".into()])
                } else {
                    None
                }
            );
        }
    }

    #[test]
    fn plugin_prompt_snapshot_owns_generated_resources_and_preserves_trust_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".kcoder/plugins/leased/.claude-plugin");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("plugin.json"), r#"{"name":"leased"}"#).unwrap();
        fs::create_dir(root.parent().unwrap().join("commands")).unwrap();
        fs::write(
            root.parent().unwrap().join("commands/test.md"),
            "Run the requested review.",
        )
        .unwrap();
        let store = crate::PluginStore::open(&temp.path().join("store")).unwrap();
        let registry =
            crate::PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
        let snapshot = registry.effective_snapshot();
        let generated = snapshot.prompt_leases.first().unwrap().path().to_path_buf();
        assert!(
            snapshot
                .skill_trust_roots
                .iter()
                .any(|(path, _)| path == &generated)
        );
        let retained = snapshot.clone();
        drop(snapshot);
        assert!(generated.exists());
        drop(retained);
        assert!(!generated.exists());
        let untrusted = crate::PluginRegistry::discover_with_store(temp.path(), false, &store)
            .unwrap()
            .effective_snapshot();
        assert!(untrusted.prompt_leases.is_empty());
    }
}
