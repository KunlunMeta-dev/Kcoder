//! Pinned Octop templates are inert text; copying never installs executable skills.
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock};

const REVISION: &str = "dd9dce470844c25d59effb50615bb3c667ea25cd";
#[derive(Deserialize)]
struct Snapshot {
    revision: String,
    items: Vec<Preset>,
}
#[derive(Deserialize)]
struct Preset {
    id: String,
    label: BTreeMap<String, String>,
    description: BTreeMap<String, String>,
    welcome_message: BTreeMap<String, String>,
    icon_url: String,
    color: String,
    file_contents: Vec<PresetFile>,
}
#[derive(Deserialize)]
struct PresetFile {
    name: String,
    content: String,
}
static SNAPSHOT: LazyLock<Snapshot> = LazyLock::new(|| {
    let value: Snapshot =
        serde_json::from_str(include_str!("../../../../../resources/octop/experts.json"))
            .expect("versioned Octop template JSON must decode");
    assert_eq!(value.revision, REVISION);
    value
});

fn localized(values: &BTreeMap<String, String>, language: &str) -> String {
    values
        .get(if language.starts_with("zh") {
            "zh"
        } else {
            "en"
        })
        .or_else(|| values.get("zh"))
        .cloned()
        .unwrap_or_default()
}

pub fn builtin_octop_assistants(language: &str) -> Vec<OfficeAssistantDefinition> {
    SNAPSHOT.items.iter().enumerate().map(|(rank, item)| {
        let instructions = item.file_contents.iter()
            .find(|file| file.name == "SOUL.md")
            .or_else(|| item.file_contents.iter().find(|file| file.name == "AGENTS.md"))
            .map(|file| file.content.clone())
            .unwrap_or_else(|| localized(&item.description, language));
        OfficeAssistantDefinition {
            schema_version: 1,
            id: format!("builtin.octop.{}", item.id),
            scope: OfficeAssistantScope::Personal,
            title: localized(&item.label, language),
            description: localized(&item.description, language),
            language: language.into(),
            input_schema: json!({"type":"object", "x-kcoder-expert":{
                "catalogue":"octop", "sourceId":item.id, "rank":rank,
                "avatarPreset":format!("octop:{}",item.icon_url.rsplit('/').next().unwrap_or_default()),
                "color":item.color, "welcome":localized(&item.welcome_message, language)
            }}),
            instructions,
            skills: vec![],
            capabilities: vec![],
            resources: vec![],
            workflow_ref: None,
            model_selection: OfficeModelSelection::InheritCurrent,
            allowed_tools: None,
            output_kinds: vec![OfficeArtifactKind::Document],
            acceptance_criteria: vec![if language.starts_with("zh") {
                "根据任务要求核对结果".into()
            } else { "Review the result against the request".into() }],
            external_send: OfficeExternalSend::Deny,
        }
    }).collect()
}

/// The trusted versioned snapshot supplies every file, including bundled licenses.
/// Callers still validate each path/hash and commit via the normal OfficeStore lock.
pub fn builtin_octop_package(id: &str) -> Option<(OfficeExpertPackage, BuiltinExpertFiles)> {
    let slug = id.strip_prefix("builtin.octop.")?;
    let item = SNAPSHOT.items.iter().find(|item| item.id == slug)?;
    let files: Vec<_> = item
        .file_contents
        .iter()
        .map(|file| (file.name.clone(), file.content.as_bytes().to_vec()))
        .collect();
    let entries: Vec<_> = files
        .iter()
        .map(|(path, bytes)| OfficeExpertFile {
            path: path.clone(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
        .collect();
    let skills = entries
        .iter()
        .filter_map(|file| file.path.strip_prefix("skills/"))
        .filter_map(|path| path.strip_suffix("/SKILL.md"))
        .map(str::to_owned)
        .collect();
    Some((
        OfficeExpertPackage {
            source: "octop-builtin".into(),
            slug: slug.into(),
            package_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&entries).ok()?)),
            skill_slugs: skills,
            files: entries,
        },
        files,
    ))
}

type BuiltinExpertFiles = Vec<(String, Vec<u8>)>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_templates_keep_files_and_licenses_without_execution_authority() {
        for language in ["zh-CN", "en"] {
            let definitions = builtin_octop_assistants(language);
            assert_eq!(definitions.len(), 22);
            for definition in definitions {
                definition.validate().unwrap();
                assert_eq!(definition.allowed_tools, None);
                assert_eq!(definition.external_send, OfficeExternalSend::Deny);
                assert!(definition.capabilities.is_empty());
                let (package, files) = builtin_octop_package(&definition.id).unwrap();
                assert!(!files.is_empty());
                assert_eq!(package.files.len(), files.len());
                for (entry, (name, bytes)) in package.files.iter().zip(&files) {
                    assert_eq!(&entry.path, name);
                    assert_eq!(entry.sha256, format!("{:x}", Sha256::digest(bytes)));
                }
            }
        }
        let (office, _) = builtin_octop_package("builtin.octop.office-automation").unwrap();
        assert!(
            office
                .files
                .iter()
                .any(|file| file.path == "skills/docx/LICENSE.txt")
        );
        assert!(builtin_octop_package("personal.untrusted").is_none());
    }
}
