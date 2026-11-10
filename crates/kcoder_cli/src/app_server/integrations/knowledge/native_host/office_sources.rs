//! Existing Wiki bytes under the same native knowledge authorization.
use super::*;
use anyhow::ensure;

impl NativeKnowledgeHost {
    pub(in crate::app_server::integrations::knowledge) fn office_wiki_material(
        &self,
        request: &IntegrationRequest,
        settings_path: &std::path::Path,
        source: &PublicationSource,
        cancel: &CancellationToken,
    ) -> Result<kcoder_knowledge::StoredPage> {
        self.native.validate_scope(&request.scope)?;
        let policy = self.policy_for(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms: u64::try_from(chrono::Utc::now().timestamp_millis())?,
            explicit_user_action: false,
            policy: &policy,
        };
        let resource = KnowledgeResource {
            kind: "wiki_page",
            id: serde_json::to_string(source)?,
            owner: self.scope().into(),
        };
        context.check(request, false, "knowledge.read", &resource)?;
        if self.scope().organization_id.is_some() {
            context.check(request, false, "knowledge.adopt", &resource)?;
        }
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let mut pages = ExistingProfileWikiResolver::new(&self.native, settings_path)?
            .resolve_fixed_material(&self.native, std::slice::from_ref(source), cancel)?;
        ensure!(pages.len() == 1, "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE");
        let page = pages.pop().unwrap();
        ensure!(
            page.revision_id == source.page_revision && page.draft.page_id == source.page_id,
            "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE"
        );
        context.check(request, false, "knowledge.read", &resource)?;
        if self.scope().organization_id.is_some() {
            context.check(request, false, "knowledge.adopt", &resource)?;
        }
        self.native.validate_scope(&request.scope)?;
        Ok(page)
    }
}
