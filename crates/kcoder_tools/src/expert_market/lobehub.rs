//! Pinned, reviewed LobeHub assistants. Entries are inert text bundled with the binary,
//! so listing and installing them needs no network and grants no execution authority.
use super::*;
use serde::Deserialize;
use std::sync::LazyLock;

/// Market slugs are namespaced so they never collide with Octop or SkillHub slugs.
pub(super) const SLUG_PREFIX: &str = "lobehub-";
const REVISION: &str = "ba090ca25a0981107589568210b056f427c1c843";
const LICENSE: &str = include_str!("../../resources/lobehub/LICENSE");

#[derive(Deserialize)]
struct Snapshot {
    source: String,
    revision: String,
    items: Vec<Entry>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    author: String,
    homepage: String,
    created_at: String,
    scene: String,
    avatar: Option<String>,
    color: Option<String>,
    title: Localized,
    description: Localized,
    system_role: Localized,
    opening_message: Localized,
    opening_questions: LocalizedList,
    changes: Vec<String>,
}

#[derive(Deserialize, serde::Serialize)]
struct Localized {
    zh: String,
    en: String,
}

#[derive(Deserialize, serde::Serialize)]
struct LocalizedList {
    zh: Vec<String>,
    en: Vec<String>,
}

impl Localized {
    fn get(&self, language: &str) -> &str {
        let (first, second) = if language.starts_with("zh") {
            (&self.zh, &self.en)
        } else {
            (&self.en, &self.zh)
        };
        if first.trim().is_empty() {
            second
        } else {
            first
        }
    }
}

static SNAPSHOT: LazyLock<Snapshot> = LazyLock::new(|| {
    let value: Snapshot =
        serde_json::from_str(include_str!("../../resources/lobehub/experts.json"))
            .expect("versioned LobeHub expert JSON must decode");
    assert_eq!(value.revision, REVISION);
    value
});

fn entry(slug: &str) -> Option<&'static Entry> {
    let id = slug.strip_prefix(SLUG_PREFIX)?;
    SNAPSHOT.items.iter().find(|item| item.id == id)
}

fn item(entry: &Entry, language: &str) -> AgentMarketDefinition {
    AgentMarketDefinition {
        slug: format!("{SLUG_PREFIX}{}", entry.id),
        title: entry.title.get(language).to_owned(),
        description: entry.description.get(language).to_owned(),
        scene: entry.scene.clone(),
        skill_slugs: Vec::new(),
    }
}

pub(super) fn list(language: &str) -> Vec<AgentMarketDefinition> {
    SNAPSHOT
        .items
        .iter()
        .map(|entry| item(entry, language))
        .collect()
}

pub(super) fn detail(slug: &str, language: &str) -> Option<AgentMarketDefinitionDetail> {
    let entry = entry(slug)?;
    Some(AgentMarketDefinitionDetail {
        item: item(entry, language),
        content: entry.system_role.get(language).to_owned(),
    })
}

/// `Ok(None)` means the slug is not a LobeHub entry and another source should answer.
pub(super) fn download(slug: &str, language: &str) -> Result<Option<PreparedExpert>> {
    if !slug.starts_with(SLUG_PREFIX) {
        return Ok(None);
    }
    let entry = entry(slug).context("OFFICE_PACKAGE_NOT_FOUND")?;
    let instructions = entry.system_role.get(language).to_owned();
    ensure!(!instructions.trim().is_empty(), "OFFICE_INVALID_REPLY");
    let upstream = upstream_note(entry);
    let files: Vec<(String, Vec<u8>)> = vec![
        ("LICENSE".into(), LICENSE.as_bytes().to_vec()),
        ("SOUL.md".into(), instructions.as_bytes().to_vec()),
        ("UPSTREAM.md".into(), upstream.into_bytes()),
        (
            "source/lobehub.json".into(),
            serde_json::to_vec_pretty(entry)?,
        ),
    ];
    let entries: Vec<_> = files
        .iter()
        .map(|(path, bytes)| AgentResourceFile {
            path: path.clone(),
            sha256: hash(bytes),
            bytes: bytes.len() as u64,
        })
        .collect();
    let mut presentation = serde_json::json!({
        "catalogue": "lobehub",
        "sourceId": entry.id,
        "welcome": entry.opening_message.get(language),
    });
    if let Some(color) = &entry.color {
        presentation["color"] = color.clone().into();
    }
    Ok(Some(PreparedExpert {
        allowed_tools: None,
        item: item(entry, language),
        instructions,
        package: AgentDefinitionPackage {
            source: "lobehub".into(),
            slug: slug.into(),
            package_sha256: hash(&serde_json::to_vec(&entries)?),
            skill_slugs: Vec::new(),
            files: entries,
        },
        files,
        presentation: Some(presentation),
    }))
}

fn upstream_note(entry: &Entry) -> String {
    let mut text = format!(
        "# Upstream\n\n- Project: {}\n- Revision: `{}`\n- Assistant: `{}` by {} ({})\n- Created: {}\n- License: MIT (see LICENSE)\n",
        SNAPSHOT.source,
        SNAPSHOT.revision,
        entry.id,
        entry.author,
        entry.homepage,
        entry.created_at
    );
    if !entry.changes.is_empty() {
        text.push_str("\n## Changes for KCoder\n\n");
        for change in &entry.changes {
            text.push_str(&format!("- {change}\n"));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_selection_installs_as_attributed_inert_text() {
        let mut slugs = std::collections::BTreeSet::new();
        for language in ["zh-CN", "en"] {
            let items = list(language);
            assert_eq!(items.len(), 43);
            for item in items {
                valid_slug(&item.slug).unwrap();
                assert!(!item.title.trim().is_empty() && !item.description.trim().is_empty());
                slugs.insert(item.slug.clone());
                let detail = detail(&item.slug, language).unwrap();
                let prepared = download(&item.slug, language).unwrap().unwrap();
                assert_eq!(prepared.instructions, detail.content);
                assert!(prepared.instructions.chars().count() <= 24_000);
                assert_eq!(prepared.allowed_tools, None);
                assert_eq!(prepared.package.source, "lobehub");
                assert_eq!(prepared.package.files.len(), prepared.files.len());
                for (entry, (path, bytes)) in prepared.package.files.iter().zip(&prepared.files) {
                    assert_eq!(&entry.path, path);
                    assert_eq!(entry.sha256, hash(bytes));
                }
                let upstream = &prepared
                    .files
                    .iter()
                    .find(|(path, _)| path == "UPSTREAM.md")
                    .unwrap()
                    .1;
                assert!(String::from_utf8_lossy(upstream).contains(REVISION));
                assert!(prepared.files.iter().any(|(path, bytes)| path == "LICENSE" && bytes.starts_with(b"MIT License")));
            }
        }
        assert_eq!(slugs.len(), 43);
        assert!(
            download("business-data-analysis", "zh-CN")
                .unwrap()
                .is_none()
        );
        assert!(download("lobehub-missing", "zh-CN").is_err());
        assert!(detail("lobehub-missing", "zh-CN").is_none());
    }
}
