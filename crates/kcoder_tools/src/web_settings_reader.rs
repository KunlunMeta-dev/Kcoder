//! A host-bound public Web policy source; no model input or credential discovery.
use crate::{ToolContext, ToolError};
use kcoder_config::{Settings, WebSettings};
use std::sync::{Arc, RwLock};

/// A public-policy reader bound by the owning host to this session configuration scope.
pub type WebSettingsReader = Arc<dyn Fn() -> Result<WebSettings, ToolError> + Send + Sync>;

pub(crate) fn read(
    reader: Option<&WebSettingsReader>,
    runtime: Option<&Arc<RwLock<Settings>>>,
) -> Result<WebSettings, ToolError> {
    let web = match reader {
        Some(reader) => reader()?,
        None => match runtime {
            Some(runtime) => runtime
                .read()
                .map_err(|_| ToolError::Execution("Target web policy is unavailable".into()))?
                .web
                .clone(),
            None => WebSettings::default(),
        },
    };
    web.validate()
        .map_err(|_| ToolError::Execution("Target web policy is invalid".into()))?;
    Ok(web)
}

impl ToolContext {
    /// Only the owning host supplies this source. It cannot refresh model/tool snapshots.
    pub fn with_web_settings_reader(mut self, reader: Option<WebSettingsReader>) -> Self {
        self.web_settings_reader = reader;
        self
    }

    /// Read current host policy, preserving the legacy Arc only when no reader was bound.
    pub fn effective_web_settings(&self) -> Result<WebSettings, ToolError> {
        read(
            self.web_settings_reader.as_ref(),
            self.runtime_settings.as_ref(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_reader_is_authoritative_and_failure_does_not_restore_old_or_default_policy() {
        let runtime = Arc::new(RwLock::new(Settings::default()));
        let mut fresh = WebSettings::default();
        fresh.search.providers.clear();
        let reader: WebSettingsReader = Arc::new(move || Ok(fresh.clone()));
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_runtime_settings(runtime.clone())
            .with_web_settings_reader(Some(reader));
        assert!(
            context
                .effective_web_settings()
                .unwrap()
                .search
                .providers
                .is_empty()
        );
        assert!(!runtime.read().unwrap().web.search.providers.is_empty());
        let reader: WebSettingsReader =
            Arc::new(|| Err(ToolError::Execution("Bound web source unavailable".into())));
        assert!(
            context
                .with_web_settings_reader(Some(reader))
                .effective_web_settings()
                .is_err()
        );
    }
    #[test]
    fn older_hosts_keep_the_existing_arc_or_factory_defaults() {
        let runtime = Arc::new(RwLock::new(Settings::default()));
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_runtime_settings(runtime.clone());
        runtime.write().unwrap().web.search.providers.clear();
        assert!(
            context
                .effective_web_settings()
                .unwrap()
                .search
                .providers
                .is_empty()
        );
        assert_eq!(
            ToolContext::new(kcoder_state::AppState::new("."))
                .effective_web_settings()
                .unwrap(),
            WebSettings::default()
        );
    }
}
