//! Octop portal experts. The public catalog pins each self-contained package by SHA-256
//! and size; packages are verified against a freshly fetched catalog before use.
use super::*;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

pub(super) const PORTAL_HOST: &str = "octop.cloud";
pub(super) const PACKAGE_HOST: &str = "download.octop.cloud";
const CATALOG_URL: &str = "https://octop.cloud/api/market/experts";
/// Public catalog rows are display data, never authorization; a short reuse window
/// keeps list/detail browsing from refetching the full catalog on every click.
const CATALOG_TTL: Duration = Duration::from_secs(300);
/// Workspace persona files Octop injects as the agent prompt. `BOOTSTRAP.md` (first-run
/// onboarding) and `HEARTBEAT.md` (scheduled checks) depend on Octop runtime features
/// and stay as package files only.
const PERSONA_FILES: [&str; 3] = ["SOUL.md", "IDENTITY.md", "AGENTS.md"];

static CATALOG: Mutex<Option<(Instant, Arc<Vec<Value>>)>> = Mutex::new(None);

impl ExpertMarketClient {
    async fn octop_catalog(
        &self,
        fresh: bool,
        cancel: &CancellationToken,
    ) -> Result<Arc<Vec<Value>>> {
        if !fresh
            && let Some((at, rows)) = CATALOG.lock().unwrap().as_ref()
            && at.elapsed() < CATALOG_TTL
        {
            return Ok(rows.clone());
        }
        // One retry absorbs a transient portal failure so a shared slug does not
        // silently switch to its SkillHub copy; cancellation still ends at once.
        let bytes = match self.fetch(CATALOG_URL, cancel).await {
            Ok(bytes) => bytes,
            Err(error) if cancel.is_cancelled() => return Err(error),
            Err(_) => self.fetch(CATALOG_URL, cancel).await?,
        };
        let value: Value = serde_json::from_slice(&bytes)?;
        let rows = Arc::new(catalog_rows(&value)?);
        *CATALOG.lock().unwrap() = Some((Instant::now(), rows.clone()));
        Ok(rows)
    }

    pub(super) async fn octop_list(
        &self,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<AgentMarketDefinition>> {
        self.octop_catalog(false, cancel)
            .await?
            .iter()
            .map(|row| item(row, language))
            .collect()
    }

    /// `Ok(None)` lets SkillHub answer when the slug is absent or the portal is unreachable.
    pub(super) async fn octop_detail(
        &self,
        slug: &str,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<AgentMarketDefinitionDetail>> {
        let Some(row) = self.octop_row(slug, false, cancel).await? else {
            return Ok(None);
        };
        let content = text(&row["content"], language);
        ensure!(content.len() <= 256 * 1024, "OFFICE_STORAGE_LIMIT");
        Ok(Some(AgentMarketDefinitionDetail {
            item: item(&row, language)?,
            content,
        }))
    }

    /// A slug the portal lists must install from the portal: a failed or mismatched
    /// package is an error, never a silent fallback to another source.
    pub(super) async fn octop_download(
        &self,
        slug: &str,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<PreparedExpert>> {
        let Some(row) = self.octop_row(slug, true, cancel).await? else {
            return Ok(None);
        };
        let url = reqwest::Url::parse(
            row["download_url"]
                .as_str()
                .context("OFFICE_INVALID_REPLY")?,
        )?;
        ensure!(
            allowed_asset_url(&url) && url.host_str() == Some(PACKAGE_HOST),
            "OFFICE_INVALID_REPLY"
        );
        let archive = self.fetch(url.as_str(), cancel).await?;
        prepare(slug, &row, &archive, language).map(Some)
    }

    async fn octop_row(
        &self,
        slug: &str,
        fresh: bool,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>> {
        match self.octop_catalog(fresh, cancel).await {
            Ok(rows) => Ok(rows.iter().find(|row| row["slug"] == slug).cloned()),
            Err(error) if cancel.is_cancelled() => Err(error),
            Err(_) => Ok(None),
        }
    }
}

fn catalog_rows(value: &Value) -> Result<Vec<Value>> {
    ensure!(value["success"] == true, "OFFICE_INVALID_REPLY");
    let rows = value["data"]["items"]
        .as_array()
        .context("OFFICE_INVALID_REPLY")?;
    ensure!(rows.len() <= 2000, "OFFICE_STORAGE_LIMIT");
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let slug = row["slug"].as_str().context("OFFICE_INVALID_REPLY")?;
        valid_slug(slug)?;
        ensure!(seen.insert(slug), "OFFICE_INVALID_REPLY");
    }
    Ok(rows.clone())
}

fn item(row: &Value, language: &str) -> Result<AgentMarketDefinition> {
    let slug = row["slug"].as_str().context("OFFICE_INVALID_REPLY")?;
    valid_slug(slug)?;
    let title = text(&row["label"], language);
    Ok(AgentMarketDefinition {
        slug: slug.into(),
        title: if title.is_empty() { slug.into() } else { title },
        description: text(&row["description"], language),
        scene: row["scene"].as_str().unwrap_or("").into(),
        skill_slugs: manifest_skills(&serde_json::json!({"skills": row["skill_slugs"]}))?,
    })
}

/// Verify the archive against its catalog row and convert it into an inert expert package.
fn prepare(slug: &str, row: &Value, archive: &[u8], language: &str) -> Result<PreparedExpert> {
    let expected = row["sha256"].as_str().context("OFFICE_INVALID_REPLY")?;
    ensure!(
        expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()),
        "OFFICE_INVALID_REPLY"
    );
    let package_sha256 = hash(archive);
    ensure!(
        package_sha256.eq_ignore_ascii_case(expected)
            && row["size_bytes"]
                .as_u64()
                .is_none_or(|size| size == archive.len() as u64),
        "OFFICE_CONTENT_CORRUPT"
    );
    let files = parse_zip(archive)?;
    let manifest: Value =
        serde_json::from_slice(files.get("manifest.json").context("OFFICE_INVALID_REPLY")?)?;
    ensure!(manifest["id"] == slug, "OFFICE_INVALID_REPLY");
    let listed: Vec<&str> = manifest["prompt_files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut sections = Vec::new();
    for name in listed.iter().filter(|name| PERSONA_FILES.contains(name)) {
        let bytes = files.get(*name).context("OFFICE_INVALID_REPLY")?;
        let section = String::from_utf8(bytes.clone())?;
        if !section.trim().is_empty() {
            sections.push(section.trim_end().to_owned());
        }
    }
    if sections.is_empty()
        && let Some(soul) = files.get("SOUL.md")
    {
        sections.push(String::from_utf8(soul.clone())?.trim_end().to_owned());
    }
    let instructions = sections.join("\n\n");
    ensure!(!instructions.trim().is_empty(), "OFFICE_INVALID_REPLY");
    let allowed_tools = tool_selection::expert_tool_selection(&manifest, &instructions)?;
    let skills: std::collections::BTreeSet<String> = files
        .keys()
        .filter_map(|path| path.strip_prefix("skills/")?.strip_suffix("/SKILL.md"))
        .filter(|name| !name.contains('/'))
        .map(str::to_owned)
        .collect();
    ensure!(skills.len() <= 64, "OFFICE_STORAGE_LIMIT");
    for skill in &skills {
        valid_slug(skill)?;
    }
    let mut item = item(row, language)?;
    item.skill_slugs = skills.iter().cloned().collect();
    let files: Vec<_> = files.into_iter().collect();
    let mut presentation = serde_json::json!({
        "catalogue": "octop",
        "sourceId": slug,
        "welcome": text(&row["welcome_message"], language),
    });
    if let Some(color) = row["color"].as_str().filter(|color| {
        color.len() == 7
            && color.starts_with('#')
            && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        presentation["color"] = color.into();
    }
    Ok(PreparedExpert {
        allowed_tools,
        package: AgentDefinitionPackage {
            source: "octop".into(),
            slug: slug.into(),
            package_sha256,
            skill_slugs: item.skill_slugs.clone(),
            files: files
                .iter()
                .map(|(path, bytes)| AgentResourceFile {
                    path: path.clone(),
                    sha256: hash(bytes),
                    bytes: bytes.len() as u64,
                })
                .collect(),
        },
        item,
        instructions,
        files,
        presentation: Some(presentation),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn row(archive: &[u8]) -> Value {
        serde_json::json!({
            "slug": "sample-expert", "label": {"zh": "示例专家", "en": "Sample"},
            "description": {"zh": "说明", "en": "About"}, "scene": "finance",
            "skill_slugs": ["sample-skill"], "color": "#0F766E",
            "welcome_message": {"zh": "你好", "en": "Hi"},
            "sha256": hash(archive), "size_bytes": archive.len(),
        })
    }

    #[test]
    fn verified_package_composes_persona_files_in_manifest_order() {
        let bytes = archive(&[
            ("manifest.json", br#"{"id":"sample-expert","prompt_files":["IDENTITY.md","SOUL.md","BOOTSTRAP.md","HEARTBEAT.md"]}"#),
            ("SOUL.md", b"# Soul\n"),
            ("IDENTITY.md", b"# Identity\n"),
            ("BOOTSTRAP.md", b"# First run"),
            ("HEARTBEAT.md", b"# Heartbeat"),
            ("skills/sample-skill/SKILL.md", b"Skill"),
            ("skills/sample-skill/scripts/run.py", b"print(1)"),
        ]);
        let prepared = prepare("sample-expert", &row(&bytes), &bytes, "zh-CN").unwrap();
        assert_eq!(prepared.instructions, "# Identity\n\n# Soul");
        assert_eq!(prepared.allowed_tools, None);
        assert_eq!(prepared.item.title, "示例专家");
        assert_eq!(prepared.package.source, "octop");
        assert_eq!(prepared.package.package_sha256, hash(&bytes));
        assert_eq!(prepared.package.skill_slugs, ["sample-skill"]);
        assert!(
            prepared
                .files
                .iter()
                .any(|(path, _)| path == "BOOTSTRAP.md")
        );
        assert_eq!(prepared.presentation.unwrap()["color"], "#0F766E");
    }

    #[test]
    fn package_must_match_catalog_hash_size_and_identity() {
        let bytes = archive(&[
            (
                "manifest.json",
                br#"{"id":"sample-expert","prompt_files":["SOUL.md"]}"#,
            ),
            ("SOUL.md", b"Soul"),
        ]);
        let mut tampered = row(&bytes);
        tampered["sha256"] = "0".repeat(64).into();
        assert!(prepare("sample-expert", &tampered, &bytes, "en").is_err());
        let mut resized = row(&bytes);
        resized["size_bytes"] = (bytes.len() + 1).into();
        assert!(prepare("sample-expert", &resized, &bytes, "en").is_err());
        let other = archive(&[
            (
                "manifest.json",
                br#"{"id":"other","prompt_files":["SOUL.md"]}"#,
            ),
            ("SOUL.md", b"Soul"),
        ]);
        assert!(prepare("sample-expert", &row(&other), &other, "en").is_err());
        let empty = archive(&[
            (
                "manifest.json",
                br#"{"id":"sample-expert","prompt_files":["SOUL.md"]}"#,
            ),
            ("SOUL.md", b"  "),
        ]);
        assert!(prepare("sample-expert", &row(&empty), &empty, "en").is_err());
    }

    #[test]
    fn catalog_requires_success_and_unique_valid_slugs() {
        assert!(
            catalog_rows(&serde_json::json!({"success": false, "data": {"items": []}})).is_err()
        );
        assert!(
            catalog_rows(
                &serde_json::json!({"success": true, "data": {"items": [{"slug": "../x"}]}})
            )
            .is_err()
        );
        assert!(catalog_rows(&serde_json::json!({"success": true, "data": {"items": [{"slug": "a"}, {"slug": "a"}]}})).is_err());
        assert_eq!(
            catalog_rows(&serde_json::json!({"success": true, "data": {"items": [{"slug": "a"}]}}))
                .unwrap()
                .len(),
            1
        );
    }
}
