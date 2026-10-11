use serde::{Deserialize, Serialize};

/// Explicit per-deployment transport authentication, independent of stored keys.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderAuthentication {
    #[default]
    ApiKey,
    None,
}

impl ProviderAuthentication {
    pub fn is_api_key(&self) -> bool {
        matches!(self, Self::ApiKey)
    }
}
