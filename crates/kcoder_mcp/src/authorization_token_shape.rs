//! Credential-free diagnostics: retain only known OAuth field names and JSON types.

use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

#[derive(Clone, Copy, Default)]
enum Kind {
    #[default]
    Missing,
    Null,
    String,
    Integer,
    Number,
    Boolean,
    Array,
    Object,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Null => "null",
            Self::String => "string",
            Self::Integer => "integer",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Array => "array",
            Self::Object => "object",
        }
    }
}

impl<'de> Deserialize<'de> for Kind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TypeVisitor;
        impl<'de> Visitor<'de> for TypeVisitor {
            type Value = Kind;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Kind, E> {
                Ok(Kind::Null)
            }
            fn visit_bool<E>(self, _: bool) -> Result<Kind, E> {
                Ok(Kind::Boolean)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Kind, E> {
                Ok(Kind::Integer)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Kind, E> {
                Ok(Kind::Integer)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Kind, E> {
                Ok(Kind::Number)
            }
            fn visit_str<E>(self, _: &str) -> Result<Kind, E> {
                Ok(Kind::String)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<Kind, A::Error> {
                while values.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Kind::Array)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut values: A) -> Result<Kind, A::Error> {
                while values.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Kind::Object)
            }
        }
        deserializer.deserialize_any(TypeVisitor)
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Shape {
    access_token: Kind,
    token_type: Kind,
    refresh_token: Kind,
    expires_in: Kind,
    scope: Kind,
}

pub(crate) fn describe(bytes: &[u8]) -> String {
    let Ok(shape) = serde_json::from_slice::<Shape>(bytes) else {
        return "json=invalid".into();
    };
    [
        ("access_token", shape.access_token),
        ("token_type", shape.token_type),
        ("refresh_token", shape.refresh_token),
        ("expires_in", shape.expires_in),
        ("scope", shape.scope),
    ]
    .map(|(name, kind)| format!("{name}={}", kind.name()))
    .join(",")
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_only_known_names_and_types_without_values() {
        let value = super::describe(br#"{"access_token":"private-secret","token_type":"Bearer","expires_in":3600.5,"scope":["private-scope"],"private-key":"private-value"}"#);
        assert_eq!(
            value,
            "access_token=string,token_type=string,refresh_token=missing,expires_in=number,scope=array"
        );
        assert!(!value.contains("private"));
        assert_eq!(super::describe(b"not-json-private"), "json=invalid");
    }
}
