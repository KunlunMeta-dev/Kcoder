//! Tui configuration types and their defaults.

use crate::*;

/// Controls whether the interactive TUI uses the terminal's alternate screen
/// buffer or draws in the legacy inline terminal mode.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TuiAltScreenMode {
    /// Select alternate screen mode automatically.
    #[default]
    Auto,
    /// Always use alternate screen mode.
    Always,
    /// Never use alternate screen; use the legacy inline terminal mode.
    Never,
}

/// Interactive terminal UI settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TuiSettings {
    /// Ephemeral path hints while tool arguments are streamed.
    #[serde(default)]
    pub path_preview: TuiPathPreviewSettings,
    /// Codex-compatible alternate screen setting.
    #[serde(default)]
    pub alternate_screen: TuiAltScreenMode,
    /// Session-only CLI override for `--no-alt-screen`.
    #[serde(skip)]
    pub no_alt_screen: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TuiPathPreviewSettings {
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioContextSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(default)]
    pub personality: StudioPersonality,
    /// Preserve a configured tombstone even when instructions are explicitly cleared, preventing older clients from migrating them again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub instructions_configured: bool,
    /// Record whether the user has made a choice independently of the personality default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub personality_configured: bool,
}

impl StudioContextSettings {
    pub(crate) fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for StudioContextSettings {
    fn default() -> Self {
        Self {
            instructions: String::new(),
            personality: StudioPersonality::Pragmatic,
            instructions_configured: false,
            personality_configured: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudioPersonality {
    Friendly,
    #[default]
    Pragmatic,
}
