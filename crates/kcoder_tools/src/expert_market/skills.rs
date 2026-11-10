//! Original Octop SkillHub HTTP endpoints; shared bounded transport and ZIP validation.
use super::*;

pub struct ExpertSkillDownload {
    pub allowed_tools: Option<Vec<String>>,
    pub archive_sha256: String,
    pub files: Vec<(String, Vec<u8>)>,
}

impl ExpertMarketClient {
    pub async fn list_skills(
        &self,
        params: &OfficeSkillMarketListParams,
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeMarketSkill>> {
        ensure!(
            params.query.len() <= 200
                && (1..=100).contains(&params.limit)
                && matches!(
                    params.ranking.as_str(),
                    "recommended" | "trending" | "hot" | "newest"
                )
                && matches!(params.language.as_str(), "zh-CN" | "en"),
            "OFFICE_INVALID_INPUT"
        );
        let path = if params.query.trim().is_empty() {
            format!("/api/v1/showcase/{}", params.ranking)
        } else {
            let query: String = reqwest::Url::parse_with_params(
                "https://api.skillhub.cn/api/v1/search",
                [
                    ("q", params.query.as_str()),
                    ("limit", &params.limit.to_string()),
                ],
            )?
            .query()
            .unwrap_or_default()
            .into();
            format!("/api/v1/search?{query}")
        };
        let value: Value = serde_json::from_slice(&self.get(&path, cancel).await?)?;
        let rows = value
            .get(if params.query.trim().is_empty() {
                "skills"
            } else {
                "results"
            })
            .and_then(Value::as_array)
            .context("OFFICE_INVALID_REPLY")?;
        rows.iter()
            .take(params.limit)
            .map(|row| {
                let text = |keys: &[&str]| {
                    keys.iter()
                        .find_map(|key| {
                            row.get(*key)
                                .and_then(Value::as_str)
                                .filter(|value| !value.trim().is_empty())
                        })
                        .unwrap_or_default()
                        .to_owned()
                };
                let slug = text(&["slug"]);
                valid_slug(&slug)?;
                let title = if params.language == "zh-CN" {
                    text(&["display_name_zh", "displayName", "name"])
                } else {
                    text(&["display_name_en", "displayNameEn", "displayName", "name"])
                };
                let description = if params.language == "zh-CN" {
                    text(&["description_zh", "summary", "description"])
                } else {
                    text(&["description_en", "summary", "description"])
                };
                ensure!(
                    title.len() <= 2000 && description.len() <= 16000,
                    "OFFICE_INVALID_REPLY"
                );
                Ok(OfficeMarketSkill {
                    title: if title.is_empty() {
                        slug.clone()
                    } else {
                        title
                    },
                    slug,
                    description,
                })
            })
            .collect()
    }

    pub async fn download_skill(
        &self,
        slug: &str,
        cancel: &CancellationToken,
    ) -> Result<ExpertSkillDownload> {
        valid_slug(slug)?;
        let archive = self
            .get(&format!("/api/v1/download?slug={slug}"), cancel)
            .await?;
        let mut files = parse_zip(&archive)?;
        if !files.contains_key("SKILL.md") {
            let roots: std::collections::HashSet<_> = files
                .keys()
                .filter_map(|name| name.split('/').next())
                .collect();
            ensure!(roots.len() == 1, "OFFICE_INVALID_REPLY");
            let prefix = format!("{}/", roots.into_iter().next().unwrap());
            files = files
                .into_iter()
                .map(|(name, bytes)| {
                    Ok((
                        name.strip_prefix(&prefix)
                            .context("OFFICE_INVALID_REPLY")?
                            .into(),
                        bytes,
                    ))
                })
                .collect::<Result<_>>()?;
        }
        ensure!(files.contains_key("SKILL.md"), "OFFICE_INVALID_REPLY");
        let allowed_tools =
            kcoder_skills::skill_tool_selection(std::str::from_utf8(&files["SKILL.md"])?)?;
        Ok(ExpertSkillDownload {
            allowed_tools,
            archive_sha256: hash(&archive),
            files: files.into_iter().collect(),
        })
    }
}
