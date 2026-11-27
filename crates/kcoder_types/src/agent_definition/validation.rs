//! Shared resource validation, preserving the existing public error codes.
use std::fmt;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefinitionValidationError {
    pub field: &'static str,
    pub code: &'static str,
}
impl fmt::Display for DefinitionValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.field)
    }
}
impl std::error::Error for DefinitionValidationError {}

pub(crate) fn invalid(field: &'static str) -> DefinitionValidationError {
    DefinitionValidationError {
        field,
        code: "OFFICE_INVALID_INPUT",
    }
}
pub(crate) fn bounded(
    value: &str,
    maximum: usize,
    allow_empty: bool,
    field: &'static str,
) -> Result<(), DefinitionValidationError> {
    if value.chars().count() > maximum
        || (!allow_empty && value.trim().is_empty())
        || value
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
    {
        return Err(invalid(field));
    }
    Ok(())
}
pub(crate) fn identifier(
    value: &str,
    field: &'static str,
) -> Result<(), DefinitionValidationError> {
    bounded(value, 256, false, field)
}
pub(crate) fn encoded_limit(
    value: &impl serde::Serialize,
    maximum: usize,
    field: &'static str,
) -> Result<(), DefinitionValidationError> {
    if serde_json::to_vec(value).map_err(|_| invalid(field))?.len() > maximum {
        return Err(invalid(field));
    }
    Ok(())
}
