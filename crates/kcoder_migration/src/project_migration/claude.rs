//! Parse only the authorized Claude registry's project keys. No key grants filesystem access.
use super::{ProjectReadLimits, ProjectRecord};
use anyhow::{Result, ensure};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};

pub struct ClaudeProjectDocument {
    pub projects: Vec<ProjectRecord>,
    pub actual_bytes: u64,
    pub actual_sha256: String,
}
struct Registry(ProjectReadLimits);
struct Projects(ProjectReadLimits);
impl<'de> DeserializeSeed<'de> for Registry {
    type Value = Vec<ProjectRecord>;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        input: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        struct Root(ProjectReadLimits);
        impl<'de> Visitor<'de> for Root {
            type Value = Vec<ProjectRecord>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a project registry object")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut projects = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "projects" {
                        if projects.is_some() {
                            return Err(de::Error::custom("duplicate project registry"));
                        }
                        projects = Some(map.next_value_seed(Projects(self.0))?);
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(projects.unwrap_or_default())
            }
        }
        input.deserialize_map(Root(self.0))
    }
}
impl<'de> DeserializeSeed<'de> for Projects {
    type Value = Vec<ProjectRecord>;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        input: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        struct Entries(ProjectReadLimits);
        impl<'de> Visitor<'de> for Entries {
            type Value = Vec<ProjectRecord>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("project entries")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut projects = Vec::new();
                let mut paths = BTreeSet::new();
                let mut bytes = 0usize;
                while let Some(path) = map.next_key::<String>()? {
                    if projects.len() >= self.0.projects
                        || path.is_empty()
                        || path.len() > 4096
                        || !super::is_absolute_source_root(&path)
                        || path.chars().any(char::is_control)
                        || !paths.insert(path.clone())
                    {
                        return Err(de::Error::custom("unsupported project entry"));
                    }
                    // Claude stores per-project MCP, trust and usage beside the key. None of
                    // those values become target configuration, authority, telemetry or report text.
                    map.next_value::<IgnoredAny>()?;
                    let name = path
                        .trim_end_matches(['/', '\\'])
                        .rsplit(['/', '\\'])
                        .next()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&path)
                        .to_owned();
                    let record = ProjectRecord {
                        id: format!("claude-project-{:x}", Sha256::digest(path.as_bytes())),
                        name,
                        roots: vec![path],
                        position: projects.len() as i64,
                        created_at_ms: None,
                        updated_at_ms: None,
                    };
                    bytes = bytes
                        .checked_add(
                            serde_json::to_vec(&record)
                                .map_err(|_| de::Error::custom("project metadata unavailable"))?
                                .len(),
                        )
                        .ok_or_else(|| de::Error::custom("project metadata budget"))?;
                    if bytes > self.0.metadata_bytes {
                        return Err(de::Error::custom("project metadata budget"));
                    }
                    projects.push(record);
                }
                Ok(projects)
            }
        }
        input.deserialize_map(Entries(self.0))
    }
}
/// Callers bind the exact authorized document bytes before parsing; this function never opens a path.
/// The derived basename and object order are presentation metadata, not a copied native label/order.
pub fn parse_claude_registry(
    bytes: &[u8],
    limits: ProjectReadLimits,
) -> Result<ClaudeProjectDocument> {
    ensure!(
        bytes.len() <= 8 * 1024 * 1024
            && limits.projects > 0
            && limits.projects <= 4096
            && limits.metadata_bytes > 0
            && limits.metadata_bytes <= 4 * 1024 * 1024,
        "migration_project_source_budget_exceeded"
    );
    let mut input = serde_json::Deserializer::from_slice(bytes);
    let projects = Registry(limits)
        .deserialize(&mut input)
        .map_err(|_| anyhow::anyhow!("migration_project_source_invalid_registry"))?;
    input
        .end()
        .map_err(|_| anyhow::anyhow!("migration_project_source_invalid_registry"))?;
    Ok(ClaudeProjectDocument {
        projects,
        actual_bytes: bytes.len() as u64,
        actual_sha256: format!("{:x}", Sha256::digest(bytes)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_project_paths_enter_the_projection_without_opening_foreign_or_missing_roots() {
        let input = br#"{"oauthAccount":{"secret":"PRIVATE_CREDENTIAL"},"projects":{"/missing/source-only":{"mcpServers":{"x":{"env":{"key":"PRIVATE_VALUE"}}},"hasTrustDialogAccepted":true},"D:\\foreign\\workspace":{"allowedTools":["never-execute"]}}}"#;
        let output = parse_claude_registry(input, ProjectReadLimits::default()).unwrap();
        assert_eq!(output.projects.len(), 2);
        assert_eq!(output.projects[0].name, "source-only");
        assert_eq!(output.projects[1].roots, [r"D:\foreign\workspace"]);
        let projected = serde_json::to_string(&output.projects).unwrap();
        for private in [
            "PRIVATE_CREDENTIAL",
            "PRIVATE_VALUE",
            "hasTrustDialogAccepted",
            "mcpServers",
            "never-execute",
        ] {
            assert!(!projected.contains(private));
        }
        assert!(
            output
                .projects
                .iter()
                .all(|project| project.created_at_ms.is_none() && project.updated_at_ms.is_none())
        );
        assert_eq!(output.actual_bytes, input.len() as u64);
        assert_eq!(output.actual_sha256, format!("{:x}", Sha256::digest(input)));
    }
    #[test]
    fn duplicate_paths_duplicate_projects_and_excessive_or_malformed_documents_are_rejected() {
        for input in [
            r#"{"projects":{},"projects":{}}"#,
            r#"{"projects":{"/same":{},"/same":{}}}"#,
            r#"{"projects":{"\u0000":{}}}"#,
            r#"{"projects":[]}"#,
            r#"{"projects":{}} trailing"#,
        ] {
            assert!(parse_claude_registry(input.as_bytes(), ProjectReadLimits::default()).is_err());
        }
        assert!(
            parse_claude_registry(
                br#"{"projects":{"/a":{},"/b":{}}}"#,
                ProjectReadLimits {
                    projects: 1,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            parse_claude_registry(
                br#"{"projects":{"/a":{}}}"#,
                ProjectReadLimits {
                    metadata_bytes: 8,
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
}
