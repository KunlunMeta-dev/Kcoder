//! A management projection never supplies execution limits or creates a Provider.
use super::*;

pub(super) struct ManagedProfileConfiguration {
    pub summary: Option<kcoder_types::ModelConfigurationSummary>,
    pub ready: bool,
    pub error: Option<String>,
}

pub(super) fn project_profile_configuration(
    baseline: &Settings,
    id: &str,
    effective: &ProviderConfig,
    summarize: fn(
        &Settings,
        kcoder_types::ModelConfigurationBoundary,
    ) -> Result<kcoder_types::ModelConfigurationSummary>,
) -> Result<ManagedProfileConfiguration> {
    let mut selected = baseline.clone();
    selected.providers = BTreeMap::from([(id.to_owned(), effective.clone())]);
    selected.apply_provider_for_management(Some(id))?;
    match selected.model_execution_readiness() {
        Ok(_) => Ok(ManagedProfileConfiguration {
            summary: Some(summarize(
                &selected,
                kcoder_types::ModelConfigurationBoundary::NextTurn,
            )?),
            ready: true,
            error: None,
        }),
        Err(error) => Ok(ManagedProfileConfiguration {
            summary: None,
            ready: false,
            error: Some(error.code().to_owned()),
        }),
    }
}

pub(super) fn known_context(value: usize) -> Option<usize> {
    (value > 0).then_some(value)
}
pub(super) fn known_output(value: u32) -> Option<u32> {
    (value > 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_drafts_remain_visible_without_borrowed_defaults_or_summaries() -> Result<()> {
        let settings = crate::test_fixtures::settings_with_default_provider();
        let (id, original) = settings
            .providers
            .iter()
            .next()
            .context("owned explicit fixture provider")?;
        let mut draft = original.clone();
        draft.models.clear();
        draft.context_window_tokens = 0;
        draft.output_headroom_tokens = 0;
        draft.max_output_tokens = 0;
        let projected = project_profile_configuration(
            &settings,
            id,
            &draft,
            kcoder_api::model_configuration_summary,
        )?;
        assert!(!projected.ready);
        assert!(projected.summary.is_none());
        assert_eq!(projected.error.as_deref(), Some("model_limits_missing"));
        assert_eq!(known_context(draft.context_window_tokens), None);
        assert_eq!(known_output(draft.max_output_tokens), None);
        draft.default_model.clear();
        draft.models.clear();
        let projected = project_profile_configuration(
            &settings,
            id,
            &draft,
            kcoder_api::model_configuration_summary,
        )?;
        assert!(!projected.ready);
        assert!(projected.summary.is_none());
        assert_eq!(draft.default_model, "");
        assert_eq!(known_context(32000), Some(32000));
        assert_eq!(known_output(4096), Some(4096));
        Ok(())
    }
}
