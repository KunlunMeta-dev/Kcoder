//! Static, bounded reports for inert source definitions; no source value appears in a report.
use anyhow::{Result, ensure};
use kcoder_types::migration_definitions::{
    MigrationDefinitionField as Field, MigrationDefinitionFieldReport as FieldReport,
    MigrationDefinitionFormat as Format, MigrationDefinitionHookEvent as Event,
    MigrationDefinitionKind as Kind, MigrationDefinitionParseStatus as Status,
    MigrationDefinitionReport as Report,
};
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;
use zeroize::Zeroize;

const MAX_PARSE_BYTES: usize = 256 * 1024;
const MAX_FIELDS: usize = 1024;
const MAX_NODES: usize = 65_536;

pub(crate) fn format(
    kind: kcoder_types::migration::MigrationSourceKind,
    category: kcoder_types::migration::MigrationCategory,
) -> Result<Format> {
    use kcoder_types::migration::{MigrationCategory as C, MigrationSourceKind as S};
    Ok(match (kind, category) {
        (S::ClaudeCode, C::Agent) => Format::ClaudeAgentMarkdown,
        (S::Codex, C::Agent) => Format::CodexAgentToml,
        (S::ClaudeCode, C::Hook) => Format::ClaudeHooksJson,
        (S::Codex, C::Hook) => Format::CodexHooksJson,
        _ => anyhow::bail!("migration_not_a_definition"),
    })
}

pub(crate) fn report(format: Format, bytes: &[u8]) -> Report {
    let kind = match format {
        Format::ClaudeAgentMarkdown | Format::CodexAgentToml => Kind::Agent,
        _ => Kind::Hook,
    };
    let mut result = Report {
        kind,
        format,
        parse_status: Status::Malformed,
        elements: None,
        fields: Vec::new(),
        unknown_fields: None,
        execution_allowed: false,
        requires_review: true,
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        result.parse_status = Status::Opaque;
        return result;
    };
    if bytes.len() > MAX_PARSE_BYTES {
        result.parse_status = Status::BudgetExceeded;
        return result;
    }
    let parsed = match format {
        Format::ClaudeAgentMarkdown => markdown(text),
        Format::CodexAgentToml => {
            parse(toml::de::Deserializer::new(text)).map(|value| (value, false))
        }
        Format::ClaudeHooksJson | Format::CodexHooksJson => {
            let mut decoder = serde_json::Deserializer::from_str(text);
            parse(&mut decoder).and_then(|value| {
                decoder.end()?;
                Ok((value, false))
            })
        }
    };
    let (value, body) = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            if error
                .downcast_ref::<ParseProblem>()
                .is_some_and(|problem| matches!(problem, ParseProblem::Budget))
            {
                result.parse_status = Status::BudgetExceeded;
            }
            return result;
        }
    };
    let private = PrivateValue(value);
    let inspected = match kind {
        Kind::Agent => agent(&private.0, body, format, &mut result),
        Kind::Hook => hooks(&private.0, &mut result),
    };
    if inspected.is_err() {
        result.fields.clear();
        result.parse_status = Status::BudgetExceeded;
        return result;
    }
    if result.elements.is_some() {
        result.parse_status = Status::Parsed;
        result.unknown_fields = Some(
            result
                .fields
                .iter()
                .filter(|row| row.field.is_none())
                .count() as u32,
        );
    }
    result
}
fn markdown(text: &str) -> Result<(Value, bool)> {
    let (value, body) = markdown_document(text)?;
    Ok((value, !body.trim().is_empty()))
}
fn markdown_document(text: &str) -> Result<(Value, &str)> {
    let text = text.trim_start_matches('\u{feff}');
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| anyhow::anyhow!("migration_definition_format"))?;
    let (header, body) = if let Some((header, body)) = rest.split_once("\n---\n") {
        (header, body)
    } else {
        rest.split_once("\r\n---\r\n")
            .ok_or_else(|| anyhow::anyhow!("migration_definition_format"))?
    };
    let mut documents = serde_yaml::Deserializer::from_str(header);
    let document = documents
        .next()
        .ok_or_else(|| anyhow::anyhow!("migration_definition_format"))?;
    let value = parse(document)?;
    ensure!(documents.next().is_none(), "migration_definition_format");
    Ok((value, body))
}
/// The executable adapter uses the same duplicate/depth/string-budget checks as passive review.
pub(crate) fn agent_document(
    format: Format,
    bytes: &[u8],
) -> Result<(PrivateValue, zeroize::Zeroizing<String>)> {
    ensure!(
        bytes.len() <= MAX_PARSE_BYTES,
        "migration_agent_parse_budget"
    );
    let text =
        std::str::from_utf8(bytes).map_err(|_| anyhow::anyhow!("migration_agent_encoding"))?;
    let (value, body) = match format {
        Format::ClaudeAgentMarkdown => {
            let (value, body) = markdown_document(text)?;
            (
                PrivateValue(value),
                zeroize::Zeroizing::new(body.to_owned()),
            )
        }
        Format::CodexAgentToml => {
            let value = PrivateValue(parse(toml::de::Deserializer::new(text))?);
            let body = zeroize::Zeroizing::new(
                value
                    .0
                    .get("developer_instructions")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("migration_agent_instructions_required"))?
                    .to_owned(),
            );
            (value, body)
        }
        _ => anyhow::bail!("migration_not_an_agent"),
    };
    ensure!(
        !body.trim().is_empty() && !body.contains('\0'),
        "migration_agent_instructions_required"
    );
    Ok((value, body))
}
fn field(report: &mut Report, element: u32, kind: Option<Field>) -> Result<()> {
    ensure!(
        report.fields.len() < MAX_FIELDS,
        "migration_definition_report_budget"
    );
    report.fields.push(FieldReport {
        ordinal: report.fields.len() as u32,
        element,
        field: kind,
        event: None,
    });
    Ok(())
}
fn agent(value: &Value, body: bool, format: Format, report: &mut Report) -> Result<()> {
    let Some(fields) = value.as_object() else {
        return Ok(());
    };
    for key in fields.keys() {
        field(
            report,
            0,
            Some(match key.as_str() {
                "name" => Field::Name,
                "description" => Field::Description,
                "developer_instructions" => Field::Instructions,
                "model" => Field::Model,
                "model_reasoning_effort" => Field::ReasoningEffort,
                "model_reasoning_summary" => Field::ReasoningSummary,
                "model_verbosity" => Field::Verbosity,
                "tools" => Field::Tools,
                "disallowedTools" => Field::DisallowedTools,
                "permissionMode" => Field::PermissionMode,
                "skills" => Field::Skills,
                "mcpServers" => Field::McpServers,
                "hooks" => Field::Hooks,
                "memory" => Field::Memory,
                "background" => Field::Background,
                "isolation" => Field::Isolation,
                "effort" => Field::Effort,
                "color" => Field::Color,
                "maxTurns" => Field::MaxTurns,
                "features" => Field::Features,
                _ => {
                    field(report, 0, None)?;
                    continue;
                }
            }),
        )?;
    }
    if format == Format::ClaudeAgentMarkdown && body {
        field(report, 0, Some(Field::Instructions))?;
    }
    let required = fields.get("name").is_some_and(Value::is_string)
        && fields.get("description").is_some_and(Value::is_string)
        && match format {
            Format::CodexAgentToml => fields
                .get("developer_instructions")
                .is_some_and(Value::is_string),
            _ => body,
        };
    if required {
        report.elements = Some(1);
    }
    Ok(())
}
fn hooks(value: &Value, report: &mut Report) -> Result<()> {
    let Some(root) = value.as_object() else {
        return Ok(());
    };
    let Some(events) = root.get("hooks").and_then(Value::as_object) else {
        return Ok(());
    };
    let mut element = 0u32;
    for key in root.keys().filter(|key| key.as_str() != "hooks") {
        field(
            report,
            0,
            if key == "description" {
                Some(Field::HookDescription)
            } else {
                None
            },
        )?;
    }
    for (event_name, groups) in events {
        let Some(groups) = groups.as_array() else {
            return Ok(());
        };
        for group in groups {
            let Some(group) = group.as_object() else {
                return Ok(());
            };
            let Some(actions) = group.get("hooks").and_then(Value::as_array) else {
                return Ok(());
            };
            for action in actions {
                let Some(action) = action.as_object() else {
                    return Ok(());
                };
                let event = event(event_name);
                field(report, element, event.as_ref().map(|_| Field::HookEvent))?;
                report.fields.last_mut().unwrap().event = event;
                for key in group.keys().filter(|key| key.as_str() != "hooks") {
                    field(
                        report,
                        element,
                        match key.as_str() {
                            "matcher" => Some(Field::HookMatcher),
                            _ => None,
                        },
                    )?;
                }
                for key in action.keys() {
                    field(
                        report,
                        element,
                        match key.as_str() {
                            "type" => Some(Field::HookType),
                            "command" => Some(Field::HookCommand),
                            "prompt" => Some(Field::HookPrompt),
                            "timeout" => Some(Field::HookTimeout),
                            "async" => Some(Field::HookAsync),
                            "statusMessage" => Some(Field::HookStatusMessage),
                            "once" => Some(Field::HookOnce),
                            "model" => Some(Field::HookModel),
                            "args" => Some(Field::HookArgs),
                            _ => None,
                        },
                    )?;
                }
                element = element
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("migration_definition_report_budget"))?;
            }
        }
    }
    report.elements = Some(element);
    Ok(())
}
pub(crate) struct PrivateValue(pub(crate) Value);
impl Drop for PrivateValue {
    fn drop(&mut self) {
        clear(&mut self.0);
    }
}
fn clear(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear),
        Value::Object(values) => {
            for (mut key, mut value) in std::mem::take(values) {
                key.zeroize();
                clear(&mut value);
            }
        }
        _ => {}
    }
}
#[derive(Default)]
struct Budget {
    nodes: usize,
    bytes: usize,
    exceeded: bool,
}
struct Seed<'a> {
    budget: &'a mut Budget,
    depth: usize,
}
fn parse<'de, D: Deserializer<'de>>(decoder: D) -> Result<Value>
where
    D::Error: std::error::Error + Send + Sync + 'static,
{
    let mut budget = Budget::default();
    let result = Seed {
        budget: &mut budget,
        depth: 0,
    }
    .deserialize(decoder);
    result.map_err(|_| {
        if budget.exceeded {
            ParseProblem::Budget.into()
        } else {
            ParseProblem::Malformed.into()
        }
    })
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> std::result::Result<Value, D::Error> {
        self.budget.nodes += 1;
        if self.depth > 64 || self.budget.nodes > MAX_NODES {
            self.budget.exceeded = true;
            return Err(serde::de::Error::custom("definition structure budget"));
        }
        decoder.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded static definition")
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("nonfinite definition"))
    }
    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: serde::de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        self.visit_string(value.into())
    }
    fn visit_string<E: serde::de::Error>(self, mut value: String) -> std::result::Result<Value, E> {
        self.budget.bytes = self.budget.bytes.saturating_add(value.len());
        if self.budget.bytes > MAX_PARSE_BYTES {
            self.budget.exceeded = true;
            value.zeroize();
            return Err(E::custom("definition string budget"));
        }
        Ok(Value::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(Seed {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(mut key) = map.next_key::<String>()? {
            self.budget.bytes = self.budget.bytes.saturating_add(key.len());
            if self.budget.bytes > MAX_PARSE_BYTES || values.contains_key(&key) {
                self.budget.exceeded = self.budget.bytes > MAX_PARSE_BYTES;
                key.zeroize();
                return Err(serde::de::Error::custom(
                    "definition key budget or duplicate",
                ));
            }
            let value = map.next_value_seed(Seed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

#[derive(Debug)]
enum ParseProblem {
    Malformed,
    Budget,
}
impl fmt::Display for ParseProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded definition could not be interpreted")
    }
}
impl std::error::Error for ParseProblem {}
fn event(name: &str) -> Option<Event> {
    Some(match name {
        "PreToolUse" => Event::PreToolUse,
        "PermissionRequest" => Event::PermissionRequest,
        "PostToolUse" => Event::PostToolUse,
        "PostToolUseFailure" => Event::PostToolUseFailure,
        "Notification" => Event::Notification,
        "UserPromptSubmit" => Event::UserPromptSubmit,
        "Stop" => Event::Stop,
        "StopFailure" => Event::StopFailure,
        "SubagentStart" => Event::SubagentStart,
        "SubagentStop" => Event::SubagentStop,
        "PreCompact" => Event::PreCompact,
        "PostCompact" => Event::PostCompact,
        "SessionStart" => Event::SessionStart,
        "SessionEnd" => Event::SessionEnd,
        "Interrupt" => Event::Interrupt,
        "TeammateIdle" => Event::TeammateIdle,
        "TaskCompleted" => Event::TaskCompleted,
        "InstructionsLoaded" => Event::InstructionsLoaded,
        "ConfigChange" => Event::ConfigChange,
        "WorktreeCreate" => Event::WorktreeCreate,
        "WorktreeRemove" => Event::WorktreeRemove,
        _ => return None,
    })
}

/// Only the explicit hooks subtree is returned; unrelated credentials never become a passive asset.
pub(crate) fn hooks_fragment(
    kind: kcoder_types::migration::MigrationSourceKind,
    text: &str,
) -> Result<Option<Vec<u8>>> {
    ensure!(
        text.len() <= 8 * 1024 * 1024,
        "migration_source_budget_exceeded"
    );
    let value = match kind {
        kcoder_types::migration::MigrationSourceKind::ClaudeCode => {
            jsonc_parser::parse_to_serde_value(text, &Default::default())
                .map_err(|_| anyhow::anyhow!("migration_definition_format"))?
        }
        kcoder_types::migration::MigrationSourceKind::Codex => serde_json::to_value(
            toml::from_str::<toml::Value>(text)
                .map_err(|_| anyhow::anyhow!("migration_definition_format"))?,
        )
        .map_err(|_| anyhow::anyhow!("migration_definition_format"))?,
    };
    let mut private = PrivateValue(value);
    bounded(&private.0, 0, &mut 0)?;
    let Some(hooks) = private.0.get_mut("hooks") else {
        return Ok(None);
    };
    let fragment = PrivateValue(serde_json::json!({"hooks":hooks.take()}));
    let bytes = serde_json::to_vec(&fragment.0)?;
    ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "migration_asset_budget_exceeded"
    );
    Ok(Some(bytes))
}
fn bounded(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    ensure!(
        depth <= 64 && *nodes <= MAX_NODES,
        "migration_source_budget_exceeded"
    );
    match value {
        Value::Array(values) => {
            for value in values {
                bounded(value, depth + 1, nodes)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                bounded(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
