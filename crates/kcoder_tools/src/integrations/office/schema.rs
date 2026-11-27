use serde_json::{Value, json};
/// Keep primitive spreadsheet cells explicit in the model-facing schema. Runtime
/// validators separately enforce the declared column type and calendar/number limits.
pub(super) fn document_schema(mut schema: Value) -> Value {
    if let Some(rows) = schema.pointer_mut("/definitions/OfficeSheetSpec/properties/rows") {
        *rows = json!({"type":"array","maxItems":10000,"items":{"type":"array","maxItems":128,"items":{"type":["string","number","boolean","null"]}}});
    }
    schema
}

/// Keep mode-specific source parameters aligned with runtime validation.
pub(super) fn data_schema(mut schema: Value) -> Value {
    if let Some(options) = schema.pointer_mut("/definitions/CanonicalSourceReadOptions") {
        options["properties"]["expectedSha256"] = json!({"type":["string","null"],"pattern":"^[A-Fa-f0-9]{64}$","description":"Exact source.specificationSha256 returned by metadata, not output SHA or input SHA"});
        options["properties"]["offset"] = json!({"type":["integer","null"],"minimum":0,"description":"UTF-8 byte offset. Continue with nextOffset from the previous exact revision/SHA page"});
        options["properties"]["limit"] = json!({"type":["integer","null"],"minimum":1,"maximum":65536,"description":"Maximum requested source bytes; native model pages are <=16384 bytes and may be shorter; follow returned nextOffset"});
        options["allOf"] = json!([{
            "if":{"required":["metadataOnly"],"properties":{"metadataOnly":{"const":false}}},
            "then":{"required":["expectedSha256","offset","limit"],"properties":{"expectedSha256":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}}},
            "else":{"properties":{"expectedSha256":{"type":"null"},"offset":{"type":"null"},"limit":{"type":"null"}}}
        }]);
    }
    schema["allOf"] = json!([{
        "if":{"required":["action"],"properties":{"action":{"const":"canonical_source"}}},
        "then":{"properties":{"query":{"type":"null"}}},
        "else":{"properties":{"sourceRead":{"type":"null"}}}
    }]);
    schema
}
