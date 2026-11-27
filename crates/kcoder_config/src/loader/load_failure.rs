//! Boundary attribution only. Native diagnostic DTOs never contain raw causes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsLoadFailureKind {
    Parse,
    Schema,
    PrivateAccess,
    OverlayUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettingsLoadFailure {
    pub kind: SettingsLoadFailureKind,
}
impl SettingsLoadFailure {
    pub const fn new(kind: SettingsLoadFailureKind) -> Self {
        Self { kind }
    }
    pub const fn code(self) -> &'static str {
        match self.kind {
            SettingsLoadFailureKind::Parse => "settings_parse_failed",
            SettingsLoadFailureKind::Schema => "settings_schema_invalid",
            SettingsLoadFailureKind::PrivateAccess => "config_private_access",
            SettingsLoadFailureKind::OverlayUnavailable => "settings_overlay_unavailable",
        }
    }
}
impl std::fmt::Display for SettingsLoadFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for SettingsLoadFailure {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_is_an_actual_boundary_context_without_guessing_raw_messages() {
        let error = anyhow::anyhow!("owned raw detail")
            .context(SettingsLoadFailure::new(SettingsLoadFailureKind::Parse));
        assert_eq!(
            error.downcast_ref::<SettingsLoadFailure>().unwrap().kind,
            SettingsLoadFailureKind::Parse
        );
        assert!(
            anyhow::anyhow!("settings_parse_failed")
                .downcast_ref::<SettingsLoadFailure>()
                .is_none()
        );
        assert_eq!(
            SettingsLoadFailure::new(SettingsLoadFailureKind::PrivateAccess).code(),
            "config_private_access"
        );
    }
}
