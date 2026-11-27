//! Structural wire checks are projected identically to serde and JSON Schema.
use serde::{Deserialize, Deserializer, de::Error};
#[cfg(feature = "json-schema")]
const UUID: &str = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
pub(super) fn uuid<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    let valid = v.len() == 36
        && v.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && (b'1'..=b'8').contains(&v.as_bytes()[14])
        && matches!(v.as_bytes()[19], b'8' | b'9' | b'a' | b'b');
    if valid {
        Ok(v)
    } else {
        Err(D::Error::custom(
            "expected a canonical instruction capture UUID",
        ))
    }
}
pub(super) fn directory<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    if v.len() <= 4096
        && !v
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
        && !v.chars().any(char::is_control)
    {
        Ok(v)
    } else {
        Err(D::Error::custom("expected a bounded source directory"))
    }
}
pub(super) fn atom<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    if !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control) {
        Ok(v)
    } else {
        Err(D::Error::custom("expected a bounded instruction reference"))
    }
}
pub(super) fn sha<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    if v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(v)
    } else {
        Err(D::Error::custom("expected a payload digest"))
    }
}
pub(super) fn entry<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    if v.len() == 10
        && v.starts_with('e')
        && v.as_bytes()[5] == b'-'
        && v.bytes()
            .enumerate()
            .all(|(i, b)| matches!(i, 0 | 5) || b.is_ascii_digit())
    {
        Ok(v)
    } else {
        Err(D::Error::custom("expected a receiving entry reference"))
    }
}
pub(super) fn relative<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    if v.len() <= 4096
        && !v.contains(['\\', ':'])
        && !v.chars().any(char::is_control)
        && (v.is_empty()
            || v.split('/').count() <= 64
                && v.split('/')
                    .all(|part| !part.is_empty() && !matches!(part, "." | "..")))
    {
        Ok(v)
    } else {
        Err(D::Error::custom(
            "expected an existing relative target directory",
        ))
    }
}
pub(super) fn confirmed<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    if bool::deserialize(d)? {
        Ok(true)
    } else {
        Err(D::Error::custom(
            "explicit static subset consent is required",
        ))
    }
}
pub(super) fn disabled<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    if bool::deserialize(d)? {
        Err(D::Error::custom("preview never enables imported data"))
    } else {
        Ok(false)
    }
}
pub(super) fn choices<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<super::MigrationInstructionScopeChoice>, D::Error> {
    let v = Vec::<super::MigrationInstructionScopeChoice>::deserialize(d)?;
    if !v.is_empty() && v.len() <= 128 {
        Ok(v)
    } else {
        Err(D::Error::custom("expected one to 128 explicit mappings"))
    }
}
#[cfg(feature = "json-schema")]
type Schema = schemars::schema::Schema;
#[cfg(feature = "json-schema")]
fn schema(value: serde_json::Value) -> Schema {
    serde_json::from_value(value).expect("static instruction schema")
}
#[cfg(feature = "json-schema")]
pub(super) fn uuid_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(serde_json::json!({"type":"string","pattern":UUID}))
}
#[cfg(feature = "json-schema")]
pub(super) fn directory_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(
        serde_json::json!({"type":"string","minLength":1,"x-max-utf8-bytes":4096,"pattern":"^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+$"}),
    )
}
#[cfg(feature = "json-schema")]
pub(super) fn atom_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(
        serde_json::json!({"type":"string","minLength":1,"x-max-utf8-bytes":256,"pattern":"^[^\\u0000-\\u001f\\u007f-\\u009f]+$"}),
    )
}
#[cfg(feature = "json-schema")]
pub(super) fn sha_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(serde_json::json!({"type":"string","pattern":"^[0-9a-f]{64}$"}))
}
#[cfg(feature = "json-schema")]
pub(super) fn entry_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(serde_json::json!({"type":"string","pattern":"^e[0-9]{4}-[0-9]{4}$"}))
}
#[cfg(feature = "json-schema")]
pub(super) fn relative_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(
        serde_json::json!({"type":"string","x-max-utf8-bytes":4096,"pattern":"^(?!(?:[^/]+/){64})(?!(?:.*?/)?\\.{1,2}(?:/|$))(?!.*[\\\\:])(?!/)(?!.*//)(?!.*[^/]/$)[^\\u0000-\\u001f\\u007f-\\u009f]*$"}),
    )
}
#[cfg(feature = "json-schema")]
pub(super) fn confirmed_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(serde_json::json!({"type":"boolean","enum":[true]}))
}
#[cfg(feature = "json-schema")]
pub(super) fn disabled_schema(_: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    schema(serde_json::json!({"type":"boolean","enum":[false]}))
}
#[cfg(feature = "json-schema")]
pub(super) fn choices_schema(g: &mut schemars::r#gen::SchemaGenerator) -> Schema {
    let item = g.subschema_for::<super::MigrationInstructionScopeChoice>();
    schema(serde_json::json!({"type":"array","minItems":1,"maxItems":128,"items":item}))
}
