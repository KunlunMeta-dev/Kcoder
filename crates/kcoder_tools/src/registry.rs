use crate::Tool;
use std::collections::HashMap;
use std::{fmt, sync::Arc};
use thiserror::Error;

/// A collection of tools indexed by name.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: Arc<HashMap<String, RegisteredTool>>,
    revision: ToolRegistryRevision,
}

/// Identity of a structural registry snapshot, not of mutable tool internals.
#[derive(Clone, Default, Debug)]
pub struct ToolRegistryRevision(Arc<()>);

impl PartialEq for ToolRegistryRevision {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for ToolRegistryRevision {}

impl std::hash::Hash for ToolRegistryRevision {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(Arc::as_ptr(&self.0), state);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolSource {
    Builtin,
    Mcp {
        server: String,
        tool: String,
    },
    Plugin {
        plugin: String,
        server: String,
        tool: String,
    },
}

impl fmt::Display for ToolSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Builtin => write!(f, "builtin"),
            Self::Mcp { server, tool } => write!(f, "MCP server {server:?} tool {tool:?}"),
            Self::Plugin {
                plugin,
                server,
                tool,
            } => {
                write!(f, "plugin {plugin:?} MCP server {server:?} tool {tool:?}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("tool registration conflict for {name:?}: existing {existing}; rejected {incoming}")]
pub struct ToolRegistrationError {
    pub name: String,
    pub existing: ToolSource,
    pub incoming: ToolSource,
}

#[derive(Clone)]
struct RegisteredTool {
    tool: Arc<dyn Tool>,
    source: ToolSource,
}

impl fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("tools", &self.tools.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ToolRegistry {
    pub fn revision(&self) -> ToolRegistryRevision {
        self.revision.clone()
    }
    pub fn new() -> Self {
        Self::default()
    }

    /// Compose a statically known unique tool. Dynamic inputs use `try_register` or `extend`.
    pub fn register<T: Tool + 'static>(mut self, tool: T) -> Self {
        self.try_register(Arc::new(tool))
            .expect("static tool registration must have a unique name");
        self
    }

    /// Static composition helper. Dynamic contributions must use `try_register`.
    pub fn register_arc(mut self, tool: Arc<dyn Tool>) -> Self {
        self.try_register(tool)
            .expect("static tool registration must have a unique name");
        self
    }

    /// Register a contribution without replacing any existing identity.
    pub fn try_register(&mut self, tool: Arc<dyn Tool>) -> Result<(), Box<ToolRegistrationError>> {
        let name = tool.name();
        let source = tool.source();
        if let Some(existing) = self.tools.get(&name) {
            return Err(Box::new(ToolRegistrationError {
                name,
                existing: existing.source.clone(),
                incoming: source,
            }));
        }
        Arc::make_mut(&mut self.tools).insert(name, RegisteredTool { tool, source });
        self.revision = ToolRegistryRevision::default();
        Ok(())
    }

    /// Inject a new instance of the same concrete builtin implementation.
    /// Missing (including disabled) tools and external contributions cannot be replaced.
    pub fn replace_builtin<T: Tool>(&mut self, tool: T) -> anyhow::Result<()> {
        let name = tool.name();
        let Some(existing) = self.tools.get(&name) else {
            anyhow::bail!("cannot replace absent builtin tool {name:?}");
        };
        if existing.source != ToolSource::Builtin || tool.source() != ToolSource::Builtin {
            anyhow::bail!(
                "cannot replace tool {name:?}: existing {}; incoming {}",
                existing.source,
                tool.source()
            );
        }
        if existing.tool.as_ref().type_id() != std::any::TypeId::of::<T>() {
            anyhow::bail!(
                "cannot replace builtin tool {name:?} with a different implementation type"
            );
        }
        Arc::make_mut(&mut self.tools)
            .get_mut(&name)
            .expect("validated builtin remains registered")
            .tool = Arc::new(tool);
        self.revision = ToolRegistryRevision::default();
        Ok(())
    }

    /// Keep successful contributions and report every rejected duplicate.
    #[must_use]
    pub fn extend(
        &mut self,
        tools: impl IntoIterator<Item = Arc<dyn Tool>>,
    ) -> Vec<Box<ToolRegistrationError>> {
        tools
            .into_iter()
            .filter_map(|tool| self.try_register(tool).err())
            .collect()
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).map(|entry| Arc::clone(&entry.tool))
    }

    pub fn source(&self, name: &str) -> Option<&ToolSource> {
        self.tools.get(name).map(|entry| &entry.source)
    }

    pub fn all(&self) -> Vec<Arc<dyn Tool>> {
        let mut tools = self
            .tools
            .values()
            .map(|entry| Arc::clone(&entry.tool))
            .collect::<Vec<_>>();
        tools.sort_by_key(|tool| tool.name());
        tools
    }

    pub fn names(&self) -> Vec<String> {
        let mut names = self.tools.keys().cloned().collect::<Vec<_>>();
        names.sort();
        names
    }

    /// Keep only tools whose exact registered names appear in `allowed`.
    pub fn filtered_to_names(&self, allowed: &[String]) -> Self {
        let mut filtered = Self::new();
        for name in allowed {
            if let Some(entry) = self.tools.get(name) {
                Arc::make_mut(&mut filtered.tools).insert(name.clone(), entry.clone());
            }
        }
        filtered
    }

    /// Remove every tool whose registered name matches any pattern in
    /// `patterns` (exact names and `prefix*` globs). Disabled tools are gone
    /// from the registry entirely: the model is never offered them and they
    /// cannot be invoked by name.
    pub fn filtered_out_by_patterns(&self, patterns: &[String]) -> Self {
        if patterns.is_empty() {
            return self.clone();
        }
        let mut filtered = Self::new();
        for (name, entry) in self.tools.iter() {
            if !patterns
                .iter()
                .any(|pattern| tool_name_matches(name, pattern))
            {
                Arc::make_mut(&mut filtered.tools).insert(name.clone(), entry.clone());
            }
        }
        filtered
    }
}

/// Match a registered tool name against an exact name or a `prefix*` glob.
fn tool_name_matches(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        name.starts_with(prefix)
    } else {
        name == pattern
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FileReadTool, ToolContext, ToolError, ToolOutput};
    use async_trait::async_trait;
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn registry_snapshot_shares_storage_until_successful_mutation() {
        let registry = ToolRegistry::new().register(FileReadTool);
        let mut branch = registry.clone();
        assert!(Arc::ptr_eq(&registry.tools, &branch.tools));
        assert!(branch.try_register(Arc::new(FileReadTool)).is_err());
        assert!(Arc::ptr_eq(&registry.tools, &branch.tools));
        branch
            .try_register(contribution("extra", plugin()))
            .unwrap();
        assert!(!Arc::ptr_eq(&registry.tools, &branch.tools));
        assert!(registry.get("extra").is_none());
        assert_eq!(branch.source("extra"), Some(&plugin()));
        assert_ne!(registry.revision(), branch.revision());
        let mut replacement = registry.clone();
        replacement.replace_builtin(FileReadTool).unwrap();
        assert!(!Arc::ptr_eq(&registry.tools, &replacement.tools));
        assert!(!Arc::ptr_eq(
            &registry.get("read").unwrap(),
            &replacement.get("read").unwrap()
        ));
    }

    #[test]
    fn registry_revision_tracks_successful_mutation_and_clone_divergence() {
        let mut registry = ToolRegistry::new();
        let empty = registry.revision();
        registry.try_register(Arc::new(FileReadTool)).unwrap();
        assert_ne!(empty, registry.revision());
        let original = registry.revision();
        let mut branch = registry.clone();
        assert_eq!(original, branch.revision());
        assert!(registry.try_register(Arc::new(FileReadTool)).is_err());
        assert_eq!(original, registry.revision());
        branch.replace_builtin(FileReadTool).unwrap();
        assert_ne!(original, branch.revision());
        assert_eq!(original, registry.revision());
        let changed = branch.revision();
        assert!(
            branch
                .replace_builtin(Contribution {
                    name: "absent",
                    source: ToolSource::Builtin,
                    changed: AtomicBool::new(false)
                })
                .is_err()
        );
        assert_eq!(changed, branch.revision());
        assert_eq!(original, registry.filtered_out_by_patterns(&[]).revision());
        assert_ne!(original, registry.filtered_to_names(&[]).revision());
    }

    struct Contribution {
        name: &'static str,
        source: ToolSource,
        changed: AtomicBool,
    }

    #[async_trait]
    impl Tool for Contribution {
        fn name(&self) -> String {
            self.name.into()
        }
        fn source(&self) -> ToolSource {
            if self.changed.load(Ordering::SeqCst) {
                ToolSource::Builtin
            } else {
                self.source.clone()
            }
        }
        fn description(&self) -> String {
            "contribution".into()
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({})
        }
        async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("contribution"))
        }
    }

    fn contribution(name: &'static str, source: ToolSource) -> Arc<Contribution> {
        Arc::new(Contribution {
            name,
            source,
            changed: AtomicBool::new(false),
        })
    }

    fn mcp() -> ToolSource {
        ToolSource::Mcp {
            server: "remote / docs".into(),
            tool: "get/page".into(),
        }
    }

    fn plugin() -> ToolSource {
        ToolSource::Plugin {
            plugin: "docs@market".into(),
            server: "docs".into(),
            tool: "read".into(),
        }
    }

    #[test]
    fn duplicate_batch_reports_every_source_and_keeps_unrelated_tools() {
        let original: Arc<dyn Tool> = Arc::new(FileReadTool);
        let mut registry = ToolRegistry::new().register_arc(Arc::clone(&original));
        let errors = registry.extend([
            contribution("read", mcp()) as Arc<dyn Tool>,
            contribution("read", plugin()),
            contribution("extra", plugin()),
        ]);
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].existing, ToolSource::Builtin);
        assert_eq!(errors[0].incoming, mcp());
        assert!(errors[0].to_string().contains("remote / docs"));
        assert!(errors[1].to_string().contains("docs@market"));
        assert!(Arc::ptr_eq(&original, &registry.get("read").unwrap()));
        assert_eq!(registry.source("extra"), Some(&plugin()));
    }

    #[test]
    fn clone_and_filters_keep_captured_source_not_mutable_tool_metadata() {
        let tool = contribution("remote", mcp());
        let mut registry = ToolRegistry::new().register(FileReadTool);
        registry.try_register(tool.clone()).unwrap();
        tool.changed.store(true, Ordering::SeqCst);
        let cloned = registry.clone();
        let allowed = cloned.filtered_to_names(&["remote".into(), "remote".into()]);
        let denied = cloned.filtered_out_by_patterns(&["read".into()]);
        for registry in [&cloned, &allowed, &denied] {
            assert_eq!(registry.source("remote"), Some(&mcp()));
        }
        assert_eq!(allowed.names(), ["remote"]);
        assert!(denied.get("read").is_none());
        assert!(
            cloned
                .filtered_out_by_patterns(&["rem*".into()])
                .get("remote")
                .is_none()
        );
        assert!(
            cloned
                .filtered_out_by_patterns(&["*".into()])
                .names()
                .is_empty()
        );
    }

    #[test]
    fn repeated_discovery_rejects_same_owner_without_changing_original() {
        let tool: Arc<dyn Tool> = contribution("remote", mcp());
        let mut registry = ToolRegistry::new();
        registry.try_register(tool.clone()).unwrap();
        let error = registry
            .try_register(contribution("remote", mcp()))
            .unwrap_err();
        assert_eq!(error.existing, error.incoming);
        assert!(Arc::ptr_eq(&tool, &registry.get("remote").unwrap()));
    }

    #[test]
    fn legitimate_builtin_injection_replaces_existing_implementation() {
        let mut registry = ToolRegistry::new().register(FileReadTool);
        let original = registry.get("read").unwrap();
        registry.replace_builtin(FileReadTool).unwrap();
        assert!(!Arc::ptr_eq(&original, &registry.get("read").unwrap()));
        assert_eq!(registry.source("read"), Some(&ToolSource::Builtin));
    }

    #[test]
    fn builtin_replacement_cannot_restore_disabled_or_overwrite_external_tools() {
        let mut disabled = ToolRegistry::new()
            .register(FileReadTool)
            .filtered_out_by_patterns(&["read".into()]);
        assert!(
            disabled
                .replace_builtin(FileReadTool)
                .unwrap_err()
                .to_string()
                .contains("absent")
        );
        assert!(disabled.get("read").is_none());
        for source in [mcp(), plugin()] {
            let original: Arc<dyn Tool> = contribution("read", source);
            let mut registry = ToolRegistry::new();
            registry.try_register(original.clone()).unwrap();
            assert!(registry.replace_builtin(FileReadTool).is_err());
            assert!(Arc::ptr_eq(&original, &registry.get("read").unwrap()));
        }
    }

    #[test]
    fn claiming_builtin_source_does_not_grant_implementation_replacement() {
        let mut registry = ToolRegistry::new().register(FileReadTool);
        let incoming = Contribution {
            name: "read",
            source: ToolSource::Builtin,
            changed: AtomicBool::new(false),
        };
        let original = registry.get("read").unwrap();
        assert!(
            registry
                .replace_builtin(incoming)
                .unwrap_err()
                .to_string()
                .contains("different implementation type")
        );
        assert!(Arc::ptr_eq(&original, &registry.get("read").unwrap()));
    }
}
