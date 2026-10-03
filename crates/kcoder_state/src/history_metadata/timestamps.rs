use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

pub(super) fn timestamp_from_line(line: &str) -> serde_json::Result<Option<u64>> {
    let mut deserializer = serde_json::Deserializer::from_str(line);
    let timestamp = Scan::Record.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(timestamp)
}

#[derive(Clone, Copy)]
enum Scan {
    Record,
    Candidate,
    Skip,
}

impl<'de> DeserializeSeed<'de> for Scan {
    type Value = Option<u64>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        // deserialize_any preserves the same recursive validation as Value;
        // IgnoredAny can bypass serde_json's recursion limit for skipped bodies.
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Scan {
    type Value = Option<u64>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(matches!(self, Self::Candidate).then_some(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(if matches!(self, Self::Candidate) {
            u64::try_from(value).ok()
        } else {
            None
        })
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(if matches!(self, Self::Candidate) {
            value.parse().ok()
        } else {
            None
        })
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        while sequence.next_element_seed(Self::Skip)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut primary = None;
        let mut camel = None;
        while let Some(field) = map.next_key::<Field>()? {
            match (self, field) {
                (Self::Record, Field::Primary) => {
                    // Keep presence separate from validity; the last duplicate wins.
                    primary = Some(map.next_value_seed(Self::Candidate)?);
                }
                (Self::Record, Field::Camel) => {
                    camel = map.next_value_seed(Self::Candidate)?;
                }
                _ => {
                    map.next_value_seed(Self::Skip)?;
                }
            }
        }
        Ok(primary.unwrap_or(camel))
    }
}

enum Field {
    Primary,
    Camel,
    Other,
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;

        impl Visitor<'_> for FieldVisitor {
            type Value = Field;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object key")
            }

            fn visit_str<E>(self, value: &str) -> Result<Field, E> {
                Ok(match value {
                    "timestamp_ms" => Field::Primary,
                    "timestampMs" => Field::Camel,
                    _ => Field::Other,
                })
            }
        }

        deserializer.deserialize_str(FieldVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::timestamp_from_line;

    fn assert_matches_value(line: &str) {
        let expected = serde_json::from_str::<serde_json::Value>(line).map(|value| {
            value
                .get("timestamp_ms")
                .or_else(|| value.get("timestampMs"))
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str()?.parse::<u64>().ok())
                })
        });
        let actual = timestamp_from_line(line);
        assert_eq!(actual.is_ok(), expected.is_ok());
        assert_eq!(actual.ok(), expected.ok());
    }

    #[test]
    fn timestamp_projection_matches_value_field_precedence_and_duplicates() {
        for line in [
            r#"{"timestamp_ms":1}"#,
            r#"{"timestampMs":"+3","content":[{"text":"内容"}]}"#,
            r#"{"timestamp_ms":null,"timestampMs":9}"#,
            r#"{"timestampMs":9,"timestamp_ms":false}"#,
            r#"{"timestamp_ms":1,"timestamp_ms":"2"}"#,
            r#"{"timestamp_ms":1,"timestamp_ms":null,"timestampMs":9}"#,
            r#"{"timestampMs":9,"timestampMs":"4"}"#,
            r#"{"timestamp_ms":null,"timestampMs":9,"timestamp_ms":0}"#,
            r#"{"timestamp\u005fms":"42","timestamp_ms":43}"#,
            r#"{"timestamp_ms":43,"timestamp\u005fms":"42"}"#,
            r#"{"timestamp\u004ds":"44","时间":"☃\ud83d\ude00"}"#,
            r#"{"body":{"timestamp_ms":900},"Timestamp_ms":800}"#,
        ] {
            assert_matches_value(line);
        }
    }

    #[test]
    fn timestamp_projection_matches_value_candidate_types_and_top_level_values() {
        for value in [
            "0",
            "1",
            "9223372036854775808",
            "18446744073709551615",
            "18446744073709551616",
            "-1",
            "-0",
            "-9223372036854775809",
            "1.0",
            "1e0",
            "1e300",
            "true",
            "false",
            "null",
            "{}",
            "[]",
            r#""0""#,
            r#""+3""#,
            r#""0003""#,
            r#""18446744073709551615""#,
            r#""18446744073709551616""#,
            r#""-0""#,
            r#"" 3""#,
            r#""3 ""#,
            r#""3.0""#,
            r#""３""#,
            r#""""#,
            r#""\u0034\u0032""#,
        ] {
            assert_matches_value(&format!(r#"{{"timestamp_ms":{value},"timestampMs":7}}"#));
            assert_matches_value(&format!(r#"{{"timestampMs":{value}}}"#));
            assert_matches_value(value);
        }
        assert_matches_value(r#"[{"timestamp_ms":9},[null,"内容"]]"#);
    }

    #[test]
    fn timestamp_projection_matches_value_invalid_lines_and_unknown_body() {
        for line in [
            "",
            " \t\r\n",
            "{",
            r#"{"timestamp_ms":1} trailing"#,
            r#"{"timestamp_ms":1} {}"#,
            r#"{"timestamp_ms":1,"body":[1,]}"#,
            r#"{"timestamp_ms":1,"body":{"x":}}"#,
            r#"{"timestamp_ms":1,"body":1e400}"#,
            r#"{"timestamp_ms":1,"body":"\ud800"}"#,
            r#"{"timestamp_ms":1,"body":{"\udfff":1}}"#,
            r#"{"timestamp_ms":1,"body":"\q"}"#,
            r#"{"timestamp_ms":1,"body":01}"#,
            r#"{"timestamp_ms":1,"body":NaN}"#,
            r#"{"timestamp_ms":1,2:3}"#,
            "{\"timestamp_ms\":1,\"body\":\"\u{0001}\"}",
            " \t{\"timestamp_ms\":1}\r\n",
        ] {
            assert_matches_value(line);
        }
        let body = serde_json::json!({
            "text": "中文☃\n\"\\".repeat(20_000),
            "items": (0..2_000).map(|n| serde_json::json!({"n":n,"v":[true,null]})).collect::<Vec<_>>()
        });
        assert_matches_value(&format!(r#"{{"body":{body},"timestamp_ms":"+42"}}"#));
        assert_matches_value(&format!(r#"{{"timestamp_ms":42,"body":{body}}}"#));
    }

    #[test]
    fn timestamp_projection_matches_value_recursion_limit() {
        for depth in [1, 32, 125, 126, 127, 128, 129, 150] {
            for (open, close) in [("[", "]"), (r#"{"nested":"#, "}")] {
                let nested = format!("{}0{}", open.repeat(depth), close.repeat(depth));
                assert_matches_value(&nested);
                assert_matches_value(&format!(r#"{{"timestamp_ms":9,"body":{nested}}}"#));
                assert_matches_value(&format!(r#"{{"timestamp_ms":{nested},"timestampMs":9}}"#));
            }
        }
    }
}
