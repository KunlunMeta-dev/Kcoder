//! Closed pre-initialize diagnostics on stderr; no raw paths, values or grants.
use serde::{Deserialize, Serialize};

pub const NATIVE_STARTUP_DIAGNOSTIC_PREFIX_V1: &str = "KCODER_STARTUP_DIAGNOSTIC_V1:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeStartupDiagnosticCodeV1 {
    SettingsParseFailed,
    SettingsSchemaInvalid,
    SettingsOverlayUnavailable,
    ConfigPrivateAccess,
    ModelLimitsMissing,
    ProviderUnconfigured,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeStartupDiagnosticPhaseV1 {
    Launch,
    Initialize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct NativeStartupDiagnosticV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u32,
    pub code: NativeStartupDiagnosticCodeV1,
    pub phase: NativeStartupDiagnosticPhaseV1,
}

impl NativeStartupDiagnosticV1 {
    pub const fn new(
        code: NativeStartupDiagnosticCodeV1,
        phase: NativeStartupDiagnosticPhaseV1,
    ) -> Self {
        Self {
            version: 1,
            code,
            phase,
        }
    }

    /// This value reports an observation only. It grants no retry, permission,
    /// credential, configuration overwrite or execution authority.
    pub fn stderr_record(&self) -> Result<String, serde_json::Error> {
        if self.version != 1 {
            return Err(serde::ser::Error::custom(
                "unsupported startup diagnostic version",
            ));
        }
        Ok(format!(
            "{NATIVE_STARTUP_DIAGNOSTIC_PREFIX_V1}{}\n",
            serde_json::to_string(self)?
        ))
    }
}

fn version_one<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
    let version = u32::deserialize(decoder)?;
    if version == 1 {
        Ok(version)
    } else {
        Err(serde::de::Error::custom(
            "unsupported startup diagnostic version",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_stderr_record_is_exactly_the_closed_three_field_contract() {
        let diagnostic = NativeStartupDiagnosticV1::new(
            NativeStartupDiagnosticCodeV1::ModelLimitsMissing,
            NativeStartupDiagnosticPhaseV1::Initialize,
        );
        let line = diagnostic.stderr_record().unwrap();
        assert!(line.starts_with(NATIVE_STARTUP_DIAGNOSTIC_PREFIX_V1));
        assert_eq!(line.lines().count(), 1);
        let decoded: NativeStartupDiagnosticV1 = serde_json::from_str(
            line.trim_end()
                .strip_prefix(NATIVE_STARTUP_DIAGNOSTIC_PREFIX_V1)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decoded, diagnostic);
        assert_eq!(
            serde_json::to_value(diagnostic).unwrap(),
            serde_json::json!({"version":1,"code":"model_limits_missing","phase":"initialize"})
        );
    }
    #[test]
    fn raw_errors_unknown_codes_extra_fields_and_wrong_versions_are_rejected() {
        for input in [
            r#"{"version":1,"code":"settings_parse_failed","phase":"initialize","raw":"secret"}"#,
            r#"{"version":2,"code":"settings_parse_failed","phase":"initialize"}"#,
            r#"{"version":1,"code":"private/path/credential","phase":"initialize"}"#,
            r#"{"version":1,"code":"model_limits_missing","phase":"running"}"#,
        ] {
            assert!(serde_json::from_str::<NativeStartupDiagnosticV1>(input).is_err());
        }
    }
    #[cfg(feature = "json-schema")]
    #[test]
    fn schema_keeps_the_closed_version_code_phase_shape() {
        let schema =
            serde_json::to_value(schemars::schema_for!(NativeStartupDiagnosticV1)).unwrap();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["version"]["minimum"], 1.0);
        assert_eq!(schema["properties"]["version"]["maximum"], 1.0);
        assert_eq!(schema["required"].as_array().unwrap().len(), 3);
    }
}
