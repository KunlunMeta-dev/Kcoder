use super::*;
use kcoder_tools::expert_market::ExpertMarketClient;

impl OfficeService {
    pub async fn skill_market_catalog(
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        request.validate(false)?;
        let params: OfficeSkillMarketListParams = payload(request)?;
        let items = ExpertMarketClient::new()?
            .list_skills(&params, cancel)
            .await?;
        Ok(json!({"items":items}))
    }
    pub(super) async fn install_expert_skill(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let params: OfficeSkillInstallParams = payload(request)?;
        ensure!(
            params.id.starts_with("personal.")
                && matches!(params.language.as_str(), "zh-CN" | "en"),
            "OFFICE_INVALID_INPUT"
        );
        let expected = Self::expected(request)?.context("OFFICE_REVISION_REQUIRED")?;
        let original = self
            .store
            .read_draft(&params.id)?
            .context("OFFICE_DRAFT_NOT_FOUND")?;
        ensure!(original.revision == expected, "OFFICE_REVISION_CONFLICT");
        self.policy(
            request,
            "office.assistant.write",
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        let download = ExpertMarketClient::new()?
            .download_skill(&params.slug, cancel)
            .await?;
        let content = String::from_utf8(
            download
                .files
                .iter()
                .find(|(path, _)| path == "SKILL.md")
                .context("OFFICE_INVALID_REPLY")?
                .1
                .clone(),
        )?;
        let skill = OfficeAssistantSkill {
            slug: params.slug.clone(),
            title: params.slug,
            description: String::new(),
            content,
            enabled: false,
            allowed_tools: download.allowed_tools,
        };
        self.check(request, cancel)?;
        let draft = self.store.install_expert_skill(
            operation(request)?,
            &params.id,
            expected,
            kcoder_state::integrations::office::OfficeExpertSkillInstallation {
                skill,
                archive_sha256: &download.archive_sha256,
                files: &download.files,
            },
            now()?,
        )?;
        Ok(json!({"draft":draft,"executionEnabled":false,"requiresReview":true}))
    }
}
