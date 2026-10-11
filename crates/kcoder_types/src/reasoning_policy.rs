use crate::ReasoningEffort;
use serde::{Deserialize, Serialize};

/// User-declared controls, not a claim that an upstream model was verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ModelReasoningPolicy {
    pub mode: ReasoningControlMode,
    #[serde(default)]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "efforts_schema"))]
    pub efforts: Vec<ReasoningEffort>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ReasoningControlMode {
    Hidden,
    Optional,
    AlwaysOn,
    AlwaysOff,
}

// ReasoningEffort uses a custom string serde implementation, including vendor
// values. Deriving an enum schema would advertise the wrong wire contract.
#[cfg(feature = "json-schema")]
fn efforts_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    let mut schema = <Vec<String> as schemars::JsonSchema>::json_schema(generator);
    if let schemars::schema::Schema::Object(ref mut object) = schema
        && let Some(array) = object.array.as_mut()
        && let Some(schemars::schema::SingleOrVec::Single(item)) = array.items.as_mut()
        && let schemars::schema::Schema::Object(item) = item.as_mut()
    {
        // Derive the pattern from the parser's actual Unicode whitespace table.
        let whitespace: String = (0..=0x10ffff)
            .filter_map(char::from_u32)
            .filter(|character| character.is_whitespace())
            .map(|character| format!(r"\u{{{:x}}}", character as u32))
            .collect();
        item.string().pattern = Some(format!("[^{whitespace}]"));
    }
    schema
}
