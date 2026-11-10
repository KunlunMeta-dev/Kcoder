//! Task-local external-source choices. These references never grant authorization.
use super::{IntegrationNullable, IntegrationRevisionRef, IntegrationValidationError, id, invalid};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_TASK_CAPABILITY_SOURCES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilityScopeMode {
    InheritCurrent,
    Selected,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilitySourceChoice {
    pub source_ref: IntegrationRevisionRef,
    /// Null means no separately configured third-party account, never an inferred identity.
    pub account_ref: IntegrationNullable<IntegrationRevisionRef>,
}
impl IntegrationTaskCapabilitySourceChoice {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.source_ref.validate()?;
        if let Some(account) = self.account_ref.as_ref() {
            account.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeSelection {
    pub mode: IntegrationTaskCapabilityScopeMode,
    pub sources: Vec<IntegrationTaskCapabilitySourceChoice>,
}
impl IntegrationTaskCapabilityScopeSelection {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        if self.sources.len() > MAX_TASK_CAPABILITY_SOURCES {
            return Err(invalid(
                "sources",
                "at most 64 external sources may be selected",
            ));
        }
        if self.mode != IntegrationTaskCapabilityScopeMode::Selected && !self.sources.is_empty() {
            return Err(invalid(
                "sources",
                "inherit_current and none require an empty choice list",
            ));
        }
        if self.mode == IntegrationTaskCapabilityScopeMode::Selected && self.sources.is_empty() {
            return Err(invalid(
                "sources",
                "selected requires at least one explicit source/account choice",
            ));
        }
        let mut identities = BTreeSet::new();
        for source in &self.sources {
            source.validate()?;
            let identity = (
                source.source_ref.id.clone(),
                source
                    .account_ref
                    .as_ref()
                    .map(|account| account.id.clone()),
            );
            if !identities.insert(identity) {
                return Err(invalid(
                    "sources",
                    "duplicate or conflicting versions of a source/account",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilitySourceKind {
    Mcp,
    PluginMcp,
    Application,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilitySourceState {
    Ready,
    Unavailable,
    Unauthorized,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilitySourceCapability {
    Tools,
    Resources,
    AppViews,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilitySourceDescriptor {
    pub source_ref: IntegrationRevisionRef,
    pub account_ref: IntegrationNullable<IntegrationRevisionRef>,
    pub kind: IntegrationTaskCapabilitySourceKind,
    pub display_name: String,
    pub account_display_name: IntegrationNullable<String>,
    pub state: IntegrationTaskCapabilitySourceState,
    pub reason_code: IntegrationNullable<String>,
    pub capabilities: BTreeSet<IntegrationTaskCapabilitySourceCapability>,
}
impl IntegrationTaskCapabilitySourceDescriptor {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.source_ref.validate()?;
        if let Some(account) = self.account_ref.as_ref() {
            account.validate()?;
        }
        id(&self.display_name, "displayName")?;
        if let Some(name) = self.account_display_name.as_ref() {
            id(name, "accountDisplayName")?;
        }
        if let Some(code) = self.reason_code.as_ref() {
            id(code, "reasonCode")?;
        }
        if self.state == IntegrationTaskCapabilitySourceState::Ready && self.capabilities.is_empty()
        {
            return Err(invalid(
                "capabilities",
                "a ready source requires an observed capability",
            ));
        }
        if self.state != IntegrationTaskCapabilitySourceState::Ready
            && self.reason_code.as_ref().is_none()
        {
            return Err(invalid(
                "reasonCode",
                "unavailable or unknown sources require a public explanation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeReadParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeSetParams {
    pub thread_id: String,
    pub selection: IntegrationTaskCapabilityScopeSelection,
    /// Independent resource locators. None preserves the prior resource policy;
    /// Some(empty) explicitly permits no external resource access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_bindings: Option<Vec<IntegrationTaskResourceBinding>>,
}

/// Selection metadata only. The native owner resolves current granted resources
/// and their URI/epoch from the existing owned application source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskResourceBinding {
    pub source: IntegrationTaskCapabilitySourceChoice,
    pub connection_ref: IntegrationRevisionRef,
    pub resource_refs: Vec<IntegrationTaskResourceRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskResourceRef {
    pub id: String,
    pub revision: String,
    pub kind: String,
}
impl IntegrationTaskResourceBinding {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.source.validate()?;
        self.connection_ref.validate()?;
        if self.resource_refs.is_empty() || self.resource_refs.len() > 100 {
            return Err(invalid(
                "resourceRefs",
                "requires 1..100 actual resource references",
            ));
        }
        let mut seen = BTreeSet::new();
        for reference in &self.resource_refs {
            id(&reference.id, "resourceRefs.id")?;
            id(&reference.revision, "resourceRefs.revision")?;
            if !matches!(
                reference.kind.as_str(),
                "document" | "spreadsheet" | "mailbox" | "base" | "table"
            ) {
                return Err(invalid(
                    "resourceRefs.kind",
                    "unsupported original resource kind",
                ));
            }
            if !seen.insert((reference.kind.clone(), reference.id.clone())) {
                return Err(invalid("resourceRefs", "duplicate resource identity"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilityScopeBoundary {
    CurrentSnapshot,
    NextToolBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeSnapshot {
    pub thread_id: String,
    pub revision: u64,
    pub selection: IntegrationTaskCapabilityScopeSelection,
    pub effective_sources: Vec<IntegrationTaskCapabilitySourceChoice>,
    pub effective_from: IntegrationTaskCapabilityScopeBoundary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_bindings: Option<Vec<IntegrationTaskResourceBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_resource_bindings: Option<Vec<IntegrationTaskResourceBinding>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selection_distinguishes_no_external_tools_and_preserves_account_versions() {
        let mut selection:IntegrationTaskCapabilityScopeSelection=serde_json::from_value(json!({"mode":"selected","sources":[{"sourceRef":{"id":"mcp-one","revision":"security-1"},"accountRef":{"id":"account-one","revision":"credential-2"}}]})).unwrap();
        selection.validate().unwrap();
        let mut other = selection.sources[0].clone();
        other.account_ref = IntegrationNullable::Value(IntegrationRevisionRef {
            id: "account-two".into(),
            revision: "1".into(),
        });
        selection.sources.push(other);
        selection.validate().unwrap();
        let mut duplicate = selection.sources[0].clone();
        duplicate.source_ref.revision = "other".into();
        selection.sources.push(duplicate);
        assert!(selection.validate().is_err());
        selection.sources.clear();
        selection.mode = IntegrationTaskCapabilityScopeMode::None;
        selection.validate().unwrap();
        selection.mode = IntegrationTaskCapabilityScopeMode::Selected;
        assert!(selection.validate().is_err());
    }
    #[test]
    fn resource_binding_is_separate_and_contains_only_exact_native_locators() {
        let old = serde_json::json!({"threadId":"thread","selection":{"mode":"none","sources":[]}});
        let parsed: IntegrationTaskCapabilityScopeSetParams =
            serde_json::from_value(old.clone()).unwrap();
        assert!(parsed.resource_bindings.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), old);
        let mut empty = old.clone();
        empty["resourceBindings"] = serde_json::json!([]);
        let parsed: IntegrationTaskCapabilityScopeSetParams =
            serde_json::from_value(empty).unwrap();
        assert_eq!(parsed.resource_bindings, Some(vec![]));
        let binding = serde_json::json!({"source":{"sourceRef":{"id":"source","revision":"s1"},"accountRef":null},"connectionRef":{"id":"application","revision":"3"},"resourceRefs":[{"id":"candidate","revision":"7","kind":"document"}]});
        let valid: IntegrationTaskResourceBinding =
            serde_json::from_value(binding.clone()).unwrap();
        valid.validate().unwrap();
        let mut uri = binding.clone();
        uri["uri"] = serde_json::json!("file:///not-a-grant");
        assert!(serde_json::from_value::<IntegrationTaskResourceBinding>(uri).is_err());
        let mut changed = binding;
        changed["resourceRefs"][0]["revision"] = serde_json::json!("");
        assert!(
            serde_json::from_value::<IntegrationTaskResourceBinding>(changed)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    #[test]
    fn request_labels_cannot_supply_authority_or_omit_an_account_null() {
        let legal = json!({"sourceRef":{"id":"local-mcp","revision":"1"},"accountRef":null});
        serde_json::from_value::<IntegrationTaskCapabilitySourceChoice>(legal.clone())
            .unwrap()
            .validate()
            .unwrap();
        let mut bad = legal.clone();
        bad.as_object_mut().unwrap().remove("accountRef");
        assert!(serde_json::from_value::<IntegrationTaskCapabilitySourceChoice>(bad).is_err());
        let mut bad = legal;
        bad["trusted"] = json!(true);
        assert!(serde_json::from_value::<IntegrationTaskCapabilitySourceChoice>(bad).is_err());
    }
}
