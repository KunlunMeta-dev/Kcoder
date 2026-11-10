//! Bounded public SkillHub downloads. Downloading never installs executable tools.
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::office::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const HOST: &str = "https://api.skillhub.cn";
const MAX_HTTP: usize = 32 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;

mod tool_selection;

pub struct PreparedExpert {
    pub allowed_tools: Option<Vec<String>>,
    pub item: OfficeMarketExpert,
    pub instructions: String,
    pub package: OfficeExpertPackage,
    pub files: Vec<(String, Vec<u8>)>,
}

pub struct ExpertMarketClient {
    client: reqwest::Client,
}
mod skills;
pub use skills::ExpertSkillDownload;
impl ExpertMarketClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    async fn get(&self, path: &str, cancel: &CancellationToken) -> Result<Vec<u8>> {
        let request = async {
            let mut url = reqwest::Url::parse(&format!("{HOST}{path}"))?;
            let mut redirects = 0;
            let mut response = loop {
                let response = self.client.get(url.clone()).send().await?;
                if !response.status().is_redirection() {
                    ensure!(
                        response.status().is_success(),
                        "OFFICE_MARKET_DOWNLOAD_FAILED"
                    );
                    break response;
                }
                ensure!(redirects < 2, "OFFICE_MARKET_DOWNLOAD_FAILED");
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .context("OFFICE_MARKET_DOWNLOAD_FAILED")?
                    .to_str()?;
                let next = url.join(location)?;
                ensure!(allowed_asset_url(&next), "OFFICE_MARKET_DOWNLOAD_FAILED");
                url = next;
                redirects += 1;
            };
            ensure!(
                response
                    .content_length()
                    .is_none_or(|size| size <= MAX_HTTP as u64),
                "OFFICE_STORAGE_LIMIT"
            );
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                ensure!(
                    bytes.len() + chunk.len() <= MAX_HTTP,
                    "OFFICE_STORAGE_LIMIT"
                );
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        };
        tokio::select! { _ = cancel.cancelled() => anyhow::bail!("OFFICE_CANCELLED"), result = request => result }
    }
    pub async fn list(
        &self,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeMarketExpert>> {
        let mut items = BTreeMap::new();
        for page in 1..=20 {
            let bytes = self
                .get(
                    &format!("/api/v1/skillsets?page={page}&pageSize=100"),
                    cancel,
                )
                .await?;
            let value: Value = serde_json::from_slice(&bytes)?;
            let rows = value["skillSets"]
                .as_array()
                .context("OFFICE_INVALID_REPLY")?;
            for row in rows {
                let item = market_item(row, language)?;
                items.insert(item.slug.clone(), item);
            }
            if rows.len() < 100
                || value["total"]
                    .as_u64()
                    .is_some_and(|total| items.len() as u64 >= total)
            {
                return Ok(items.into_values().collect());
            }
        }
        anyhow::bail!("OFFICE_STORAGE_LIMIT")
    }
    /// Public preview content is bounded and grants no installation or execution authority.
    pub async fn detail(
        &self,
        slug: &str,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<OfficeMarketExpertDetail> {
        valid_slug(slug)?;
        let bytes = self
            .get(&format!("/api/v1/skillsets/{slug}"), cancel)
            .await?;
        let value: Value = serde_json::from_slice(&bytes)?;
        let item = market_item(&value, language)?;
        ensure!(item.slug == slug, "OFFICE_INVALID_REPLY");
        let english = value["contentEn"]
            .as_str()
            .filter(|text| !text.trim().is_empty());
        let content = if language == "en" {
            english.or_else(|| value["content"].as_str())
        } else {
            value["content"].as_str().or(english)
        }
        .unwrap_or("");
        ensure!(content.len() <= 256 * 1024, "OFFICE_STORAGE_LIMIT");
        Ok(OfficeMarketExpertDetail {
            item,
            content: content.to_owned(),
        })
    }

    pub async fn download(
        &self,
        slug: &str,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<PreparedExpert> {
        valid_slug(slug)?;
        let value: Value = serde_json::from_slice(
            &self
                .get(&format!("/api/v1/skillsets/{slug}"), cancel)
                .await?,
        )?;
        let mut item = market_item(&value, language)?;
        ensure!(item.slug == slug, "OFFICE_INVALID_REPLY");
        let archive = self
            .get(&format!("/api/v1/skillsets/{slug}/download"), cancel)
            .await?;
        let package_sha256 = hash(&archive);
        let original = parse_zip(&archive)?;
        let manifest: Value = serde_json::from_slice(
            original
                .get("manifest.json")
                .context("OFFICE_INVALID_REPLY")?,
        )?;
        let skills = manifest_skills(&manifest)?;
        ensure!(
            !skills.is_empty() && skills.len() <= 64,
            "OFFICE_INVALID_REPLY"
        );
        item.skill_slugs = skills.clone();
        let prompt = original
            .get(&format!("skillsets/{slug}.md"))
            .or_else(|| original.get("identify.md"))
            .or_else(|| {
                original
                    .iter()
                    .find(|(name, _)| name.starts_with("skillsets/") && name.ends_with(".md"))
                    .map(|(_, bytes)| bytes)
            })
            .context("OFFICE_INVALID_REPLY")?;
        let instructions = String::from_utf8(prompt.clone())?;
        let allowed_tools = tool_selection::expert_tool_selection(&manifest, &instructions)?;
        ensure!(!instructions.trim().is_empty(), "OFFICE_INVALID_REPLY");
        let mut files = BTreeMap::new();
        files.insert(
            "source/manifest.json".into(),
            serde_json::to_vec(&manifest)?,
        );
        files.insert("SOUL.md".into(), instructions.as_bytes().to_vec());
        files.insert(
            format!("skills/{slug}/SKILL.md"),
            instructions.as_bytes().to_vec(),
        );
        for skill in &skills {
            valid_slug(skill)?;
            let payload = self
                .get(&format!("/api/v1/download?slug={skill}"), cancel)
                .await?;
            let mut content = parse_zip(&payload)?;
            if !content.contains_key("SKILL.md") {
                let roots: std::collections::HashSet<_> = content
                    .keys()
                    .filter_map(|name| name.split('/').next())
                    .collect();
                ensure!(roots.len() == 1, "OFFICE_INVALID_REPLY");
                let prefix = format!("{}/", roots.into_iter().next().unwrap());
                content = content
                    .into_iter()
                    .map(|(name, bytes)| {
                        Ok((
                            name.strip_prefix(&prefix)
                                .context("OFFICE_INVALID_REPLY")?
                                .to_owned(),
                            bytes,
                        ))
                    })
                    .collect::<Result<_>>()?;
            }
            ensure!(content.contains_key("SKILL.md"), "OFFICE_INVALID_REPLY");
            for (path, bytes) in content {
                ensure!(
                    files
                        .insert(format!("skills/{skill}/{path}"), bytes)
                        .is_none(),
                    "OFFICE_INVALID_REPLY"
                );
            }
            ensure!(
                files.len() <= 2000 && files.values().map(Vec::len).sum::<usize>() <= MAX_TOTAL,
                "OFFICE_STORAGE_LIMIT"
            );
        }
        let files: Vec<_> = files.into_iter().collect();
        let package = OfficeExpertPackage {
            source: "skillhub".into(),
            slug: slug.into(),
            package_sha256,
            skill_slugs: skills,
            files: files
                .iter()
                .map(|(path, bytes)| OfficeExpertFile {
                    path: path.clone(),
                    sha256: hash(bytes),
                    bytes: bytes.len() as u64,
                })
                .collect(),
        };
        Ok(PreparedExpert {
            allowed_tools,
            item,
            instructions,
            package,
            files,
        })
    }
}

fn allowed_asset_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some("api.skillhub.cn" | "skillhub-1388575217.cos.accelerate.myqcloud.com")
        )
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_slug(slug: &str) -> Result<()> {
    ensure!(
        !slug.is_empty()
            && slug.len() <= 200
            && slug != "."
            && slug != ".."
            && slug
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)),
        "OFFICE_INVALID_INPUT"
    );
    Ok(())
}
fn text(value: &Value, language: &str) -> String {
    value
        .as_str()
        .or_else(|| {
            value[if language.starts_with("zh") {
                "zh"
            } else {
                "en"
            }]
            .as_str()
        })
        .or_else(|| value["zh"].as_str())
        .or_else(|| value["en"].as_str())
        .unwrap_or("")
        .to_owned()
}
fn manifest_skills(value: &Value) -> Result<Vec<String>> {
    let list = value
        .get("skillSlugs")
        .or_else(|| value.get("skills"))
        .and_then(Value::as_array);
    let mut out = Vec::new();
    for entry in list.into_iter().flatten() {
        let slug = entry
            .as_str()
            .or_else(|| entry["slug"].as_str())
            .context("OFFICE_INVALID_REPLY")?;
        valid_slug(slug)?;
        if !out.iter().any(|item| item == slug) {
            out.push(slug.to_owned());
        }
    }
    Ok(out)
}
fn market_item(value: &Value, language: &str) -> Result<OfficeMarketExpert> {
    let slug = value["slug"].as_str().context("OFFICE_INVALID_REPLY")?;
    valid_slug(slug)?;
    let title = text(&value["displayName"], language);
    Ok(OfficeMarketExpert {
        slug: slug.into(),
        title: if title.is_empty() { slug.into() } else { title },
        description: text(&value["summary"], language),
        scene: value["scene"].as_str().unwrap_or("").into(),
        skill_slugs: manifest_skills(value)?,
    })
}

fn parse_zip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    ensure!(archive.len() <= 2000, "OFFICE_STORAGE_LIMIT");
    let mut total = 0u64;
    let mut files = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let name = file.name().trim_end_matches('/').to_owned();
        ensure!(
            !name.is_empty()
                && name.len() <= 1024
                && !name.starts_with('/')
                && !name.contains('\\')
                && !name.contains(':')
                && !name.chars().any(char::is_control)
                && name
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && file
                    .unix_mode()
                    .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "OFFICE_INVALID_INPUT"
        );
        total = total
            .checked_add(file.size())
            .context("OFFICE_STORAGE_LIMIT")?;
        ensure!(
            total <= MAX_TOTAL as u64
                && file.size() <= file.compressed_size().max(1).saturating_mul(100),
            "OFFICE_STORAGE_LIMIT"
        );
        if file.is_dir() {
            continue;
        }
        let mut content = Vec::new();
        (&mut file)
            .take(MAX_TOTAL as u64 + 1)
            .read_to_end(&mut content)?;
        ensure!(
            content.len() as u64 == file.size(),
            "OFFICE_CONTENT_CORRUPT"
        );
        ensure!(
            files.insert(name, content).is_none(),
            "OFFICE_INVALID_INPUT"
        );
    }
    Ok(files)
}

#[cfg(test)]
mod tests;
