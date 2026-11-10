//! Count collections before typed decoding so a damaged small-element array cannot amplify memory.
use serde::{Deserialize, Deserializer, de};
use std::fmt;

pub(super) fn check(bytes: &[u8]) -> anyhow::Result<()> {
    serde_json::from_slice::<Shape>(bytes)
        .map_err(|_| anyhow::anyhow!("migration_instruction_artifact_invalid"))?;
    Ok(())
}
struct Shape;
impl<'de> Deserialize<'de> for Shape {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Shape;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded instruction snapshot")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Shape, A::Error> {
                #[derive(Deserialize, Clone, Copy)]
                #[serde(field_identifier, rename_all = "camelCase")]
                enum Field {
                    Version,
                    Root,
                    Directories,
                    Observations,
                    Markers,
                    Sources,
                    Candidates,
                    CompleteLaunchChain,
                    DynamicScopePresent,
                }
                let mut seen = 0u16;
                while let Some(field) = map.next_key::<Field>()? {
                    let mask = 1u16 << field as u16;
                    if seen & mask != 0 {
                        return Err(de::Error::custom("duplicate instruction snapshot field"));
                    }
                    seen |= mask;
                    match field {
                        Field::Directories => {
                            map.next_value::<MapBounds<4096>>()?;
                        }
                        Field::Observations => {
                            map.next_value::<MapBounds<65_536>>()?;
                        }
                        Field::Markers => {
                            map.next_value::<MapBounds<1024>>()?;
                        }
                        Field::Sources | Field::Candidates => {
                            map.next_value::<SeqBounds<128>>()?;
                        }
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(Shape)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
struct MapBounds<const LIMIT: usize>;
impl<'de, const LIMIT: usize> Deserialize<'de> for MapBounds<LIMIT> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<const LIMIT: usize>;
        impl<'de, const LIMIT: usize> de::Visitor<'de> for Visitor<LIMIT> {
            type Value = MapBounds<LIMIT>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded map")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut count = 0;
                while map.next_key::<de::IgnoredAny>()?.is_some() {
                    count += 1;
                    if count > LIMIT {
                        return Err(de::Error::custom("instruction snapshot map exceeds bound"));
                    }
                    map.next_value::<de::IgnoredAny>()?;
                }
                Ok(MapBounds)
            }
        }
        deserializer.deserialize_map(Visitor::<LIMIT>)
    }
}
struct SeqBounds<const LIMIT: usize>;
impl<'de, const LIMIT: usize> Deserialize<'de> for SeqBounds<LIMIT> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<const LIMIT: usize>;
        impl<'de, const LIMIT: usize> de::Visitor<'de> for Visitor<LIMIT> {
            type Value = SeqBounds<LIMIT>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded sequence")
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut count = 0;
                while seq.next_element::<de::IgnoredAny>()?.is_some() {
                    count += 1;
                    if count > LIMIT {
                        return Err(de::Error::custom(
                            "instruction snapshot sequence exceeds bound",
                        ));
                    }
                }
                Ok(SeqBounds)
            }
        }
        deserializer.deserialize_seq(Visitor::<LIMIT>)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_collections_and_duplicate_fields_are_rejected_without_typed_allocation() {
        let too_many = serde_json::json!({"sources":vec![serde_json::Value::Null;129]});
        assert!(check(&serde_json::to_vec(&too_many).unwrap()).is_err());
        let mut directories = serde_json::Map::new();
        for index in 0..4097 {
            directories.insert(index.to_string(), serde_json::Value::Null);
        }
        assert!(
            check(&serde_json::to_vec(&serde_json::json!({"directories":directories})).unwrap())
                .is_err()
        );
        assert!(check(br#"{"root":{},"root":{}}"#).is_err());
    }
}
