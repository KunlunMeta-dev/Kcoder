//! Refresh only public Web policy through the session's existing bound configuration source.
use super::*;

impl QueryEngine {
    pub(super) fn bound_web_settings_reader(&self) -> Option<kcoder_tools::WebSettingsReader> {
        let source = self.client_model_configuration.clone()?;
        let runtime = self.settings.clone();
        Some(Arc::new(move || {
            match source.web_settings().map_err(|_| {
                ToolError::Execution("The bound target web policy is unavailable".into())
            })? {
                Some(web) => Ok(web),
                None => runtime
                    .read()
                    .map(|settings| settings.web.clone())
                    .map_err(|_| ToolError::Execution("Target web policy is unavailable".into())),
            }
        }))
    }
}

#[cfg(test)]
mod tests;
