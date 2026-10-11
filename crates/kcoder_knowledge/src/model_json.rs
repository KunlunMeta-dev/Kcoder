//! Tolerant adapter for private model responses. Public records and tool inputs
//! keep their typed contract; evidence text and explicitly supplied identities
//! are never repaired here.
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use std::fmt;

fn error(message: &'static str) -> serde_json::Error {
    <serde_json::Error as de::Error>::custom(message)
}

// Value normally keeps the last duplicate key. Conflicting values are rejected
// before any envelope or citation expansion can erase the original choice;
// repeating the exact same value is an unambiguous formatting variation.
struct DistinctValue(Value);
impl<'de> Deserialize<'de> for DistinctValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DistinctVisitor;
        impl<'de> Visitor<'de> for DistinctVisitor {
            type Value = DistinctValue;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an unambiguous JSON value")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(DistinctValue(Value::Bool(value)))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(DistinctValue(value.into()))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(DistinctValue(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(DistinctValue(json!(value)))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(DistinctValue(value.into()))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(DistinctValue(value.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(DistinctValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(DistinctValue(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(DistinctValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some((key, DistinctValue(value))) =
                    map.next_entry::<String, DistinctValue>()?
                {
                    if let Some(prior) = values.get(&key)
                        && prior != &value
                    {
                        return Err(de::Error::custom("conflicting duplicate JSON field"));
                    }
                    values.insert(key, value);
                }
                Ok(DistinctValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(DistinctVisitor)
    }
}

/// Extract one complete JSON value from Markdown fences or surrounding prose.
/// Multiple values and an unfinished second container remain errors.
pub(super) fn value(raw: &str) -> serde_json::Result<Value> {
    let text = raw.trim().trim_start_matches('\u{feff}').trim();
    let original = match decode(text) {
        Ok(value) => return Ok(value.0),
        Err(error) => error,
    };
    let mut start = 0;
    let mut stack = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut selected = None;
    for (offset, ch) in text.char_indices() {
        if stack.is_empty() {
            if matches!(ch, '{' | '[') {
                start = offset;
                stack.push(ch);
                quoted = false;
                escaped = false;
            }
            continue;
        }
        if quoted {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            '{' | '[' => stack.push(ch),
            '}' | ']' => {
                let expected = if ch == '}' { '{' } else { '[' };
                if stack.pop() != Some(expected) {
                    return Err(original);
                }
                if stack.is_empty() {
                    match decode(&text[start..offset + 1]) {
                        Ok(value) if selected.is_none() => selected = Some(value.0),
                        Ok(_) => return Err(error("multiple JSON results")),
                        // Bracketed explanatory prose is not a JSON result. A
                        // duplicate object must not be mistaken for such prose.
                        Err(error) if error.classify() == serde_json::error::Category::Data => {
                            return Err(error);
                        }
                        Err(_) => {}
                    }
                }
            }
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(original);
    }
    selected.ok_or(original)
}

fn decode(text: &str) -> serde_json::Result<DistinctValue> {
    let original = match serde_json::from_str(text) {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    // Recover trailing commas and literal control characters inside an
    // explicit double-quoted string. Escaping changes wire spelling only:
    // citation quotes and complete bodies decode to the same original bytes.
    // Missing delimiters and ambiguous backslash continuations stay errors.
    if original.classify() != serde_json::error::Category::Syntax {
        return Err(original);
    }
    let mut cleaned = String::with_capacity(text.len());
    let mut quoted = false;
    let mut escaped = false;
    for (offset, ch) in text.char_indices() {
        if quoted {
            if ch <= '\u{1f}' && !escaped {
                match ch {
                    '\n' => cleaned.push_str("\\n"),
                    '\r' => cleaned.push_str("\\r"),
                    '\t' => cleaned.push_str("\\t"),
                    _ => cleaned.push_str(&format!("\\u{:04x}", ch as u32)),
                }
                continue;
            }
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' && text[offset + 1..].trim_start().starts_with(['}', ']']) {
            continue;
        }
        cleaned.push(ch);
    }
    if cleaned == text {
        return Err(original);
    }
    serde_json::from_str(&cleaned)
}

fn key(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, '_' | '-' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

/// Collapse known spelling aliases and ignore unrelated model metadata. Two
/// different values for the same factual field are an error, even under different
/// names. Review/advisory lists add observations without overwriting any note.
fn fields(value: &mut Value, definitions: &[(&str, &[&str])]) -> serde_json::Result<()> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let mut canonical = Map::new();
    for (name, value) in std::mem::take(object) {
        let spelling = key(&name);
        let field = definitions.iter().find(|(canonical, aliases)| {
            spelling == key(canonical) || aliases.iter().any(|alias| spelling == key(alias))
        });
        if let Some((canonical_name, _)) = field {
            if matches!(*canonical_name, "reviewNotes" | "advisoryNotes") {
                merge_notes(
                    canonical
                        .entry(*canonical_name)
                        .or_insert_with(|| json!([])),
                    value,
                )?;
                continue;
            }
            if let Some(prior) = canonical.get(*canonical_name)
                && prior != &value
            {
                return Err(error("conflicting JSON field aliases"));
            }
            canonical.insert((*canonical_name).into(), value);
        }
    }
    *object = canonical;
    Ok(())
}

fn array(value: &mut Value, single: bool) -> serde_json::Result<()> {
    if value.is_object() {
        // Collection envelopes are distinct from a single identified row. Do
        // not unwrap a page/citation/verdict just because it has extra metadata.
        unwrap(
            value,
            &[
                "id",
                "pageId",
                "targetPageId",
                "unitId",
                "sourceUnitId",
                "aspectId",
                "ref",
                "sourceId",
                "quote",
                "markdown",
                "body",
                "bodyMarkdown",
                "content",
                "title",
                "disposition",
                "verdict",
                "supported",
                "unit",
                "unitIndex",
            ],
        )?;
    }
    if value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty()) {
        *value = json!([]);
    } else if single && (value.is_string() || value.is_object()) {
        *value = Value::Array(vec![std::mem::take(value)]);
    }
    Ok(())
}

fn list(object: &mut Map<String, Value>, name: &str, single: bool) -> serde_json::Result<()> {
    array(object.entry(name).or_insert_with(|| json!([])), single)
}

fn merge_notes(prior: &mut Value, mut incoming: Value) -> serde_json::Result<()> {
    array(prior, true)?;
    array(&mut incoming, true)?;
    let Some(incoming_notes) = incoming.as_array() else {
        // Preserve malformed shapes for the typed parser's precise field path.
        *prior = incoming;
        return Ok(());
    };
    let Some(prior) = prior.as_array_mut() else {
        return Ok(());
    };
    for note in incoming_notes {
        if note.as_str().is_some_and(|text| text.trim().is_empty()) {
            continue;
        }
        if !prior.contains(note) {
            prior.push(note.clone());
        }
    }
    Ok(())
}

fn unsigned(value: &mut Value) {
    if let Some(text) = value.as_str()
        && let Ok(number) = text.trim().parse::<u64>()
    {
        *value = number.into();
    } else if let Some(number) = value.as_f64()
        && number >= 0.0
        && number < u64::MAX as f64
        && number.fract() == 0.0
    {
        *value = (number as u64).into();
    }
}

fn boolean(value: &mut Value) {
    if let Some(text) = value.as_str() {
        match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => *value = true.into(),
            "false" | "0" => *value = false.into(),
            _ => {}
        }
    } else if value == &json!(1) {
        *value = true.into();
    } else if value == &json!(0) {
        *value = false.into();
    }
}

fn enum_text(value: &mut Value) {
    if let Some(text) = value.as_str() {
        *value = text.trim().to_ascii_lowercase().into();
    }
}

fn unwrap(value: &mut Value, root_keys: &[&str]) -> serde_json::Result<()> {
    let keep_notes = matches!(root_keys.first(), Some(&"pages" | &"topics"));
    let mut notes = Map::new();
    for _ in 0..8 {
        if let Some(text) = value.as_str() {
            // Decode only a whole response/envelope, never body or quote text.
            *value = self::value(text)?;
            continue;
        }
        let Some(object) = value.as_object() else {
            break;
        };
        // A real model-reported failure is not decorative metadata, including
        // when it is next to an otherwise usable wrapped result.
        if object.iter().any(|(name, value)| {
            let name = key(name);
            (matches!(name.as_str(), "error" | "errors")
                && !value.is_null()
                && value != &json!([])
                && value != &json!("")
                && value != &json!(false))
                || name == "success" && value == &json!(false)
                || name == "status"
                    && value.as_str().is_some_and(|status| {
                        matches!(
                            status.trim().to_ascii_lowercase().as_str(),
                            "failed" | "error" | "aborted" | "cancelled" | "truncated"
                        )
                    })
        }) {
            return Err(error("model reported an unresolved error"));
        }
        if object
            .keys()
            .any(|name| root_keys.iter().any(|root| key(name) == key(root)))
        {
            break;
        }
        if root_keys.first() == Some(&"pages")
            && object.keys().any(|name| {
                matches!(
                    key(name).as_str(),
                    "markdown" | "body" | "content" | "bodymarkdown"
                )
            })
            && object.keys().any(|name| {
                matches!(
                    key(name).as_str(),
                    "id" | "title"
                        | "name"
                        | "pagetitle"
                        | "kind"
                        | "type"
                        | "citations"
                        | "references"
                        | "refs"
                )
            })
        {
            // `content` is also a page-body alias. Identified page rows retain
            // literal JSON/code bodies instead of treating them as envelopes.
            break;
        }
        let mut wrappers = Vec::new();
        for (name, inner) in object {
            if !matches!(
                key(name).as_str(),
                "result"
                    | "results"
                    | "data"
                    | "output"
                    | "response"
                    | "analysis"
                    | "proposal"
                    | "assessment"
                    | "topicplan"
                    | "payload"
                    | "json"
                    | "text"
                    | "content"
                    | "items"
                    | "records"
                    | "entries"
                    | "values"
            ) {
                continue;
            }
            let mut inner = inner.clone();
            if let Some(text) = inner.as_str() {
                let text = text.trim();
                // Ordinary explanatory metadata is not another JSON result.
                // A JSON-shaped but truncated/ambiguous wrapper is an error.
                if !text.starts_with(['"', '`']) && !text.contains(['{', '[']) {
                    continue;
                }
                inner = self::value(text)?;
            }
            if inner.is_object() || inner.is_array() || inner.is_string() {
                wrappers.push(inner);
            }
        }
        match wrappers.as_slice() {
            [] => break,
            [inner] => {
                if keep_notes {
                    retain_notes(&mut notes, object)?;
                }
                *value = inner.clone();
            }
            [inner, rest @ ..] if rest.iter().all(|other| other == inner) => {
                if keep_notes {
                    retain_notes(&mut notes, object)?;
                }
                *value = inner.clone();
            }
            _ => return Err(error("ambiguous JSON wrapper")),
        }
    }
    if !notes.is_empty() {
        if value.is_array() {
            let mut object = Map::new();
            object.insert(root_keys[0].into(), std::mem::take(value));
            *value = Value::Object(object);
        }
        if let Some(object) = value.as_object_mut() {
            for (name, note) in notes {
                merge_notes(object.entry(name).or_insert_with(|| json!([])), note)?;
            }
        }
    }
    Ok(())
}

fn retain_notes(
    notes: &mut Map<String, Value>,
    object: &Map<String, Value>,
) -> serde_json::Result<()> {
    for (name, note) in object {
        let canonical = match key(name).as_str() {
            "reviewnotes" | "unresolvedissues" => "reviewNotes",
            "advisorynotes" | "notes" | "warnings" => "advisoryNotes",
            _ => continue,
        };
        merge_notes(
            notes.entry(canonical).or_insert_with(|| json!([])),
            note.clone(),
        )?;
    }
    Ok(())
}

fn inventory(context: Option<&Value>) -> Option<&Value> {
    let context = context?;
    context.get("sourceInventory").or_else(|| {
        context
            .get("originalInput")
            .and_then(|input| input.get("sourceInventory"))
    })
}

fn binding(value: &mut Value, inventory: Option<&Value>) -> serde_json::Result<()> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    if (!object.contains_key("binding") || object.get("binding").is_some_and(Value::is_null))
        && let Some(binding) = inventory.and_then(|inventory| inventory.get("binding"))
    {
        object.insert("binding".into(), binding.clone());
    }
    if let Some(value) = object.get_mut("binding") {
        fields(
            value,
            &[
                ("libraryId", &[]),
                ("sourceId", &[]),
                ("sourceRevision", &["sourceRevisionId"]),
                ("purposeHash", &[]),
                ("inventoryHash", &[]),
                ("afterChunk", &[]),
                ("throughChunk", &[]),
            ],
        )?;
        if let Some(object) = value.as_object_mut() {
            if let Some(offered) = inventory.and_then(|inventory| inventory["binding"].as_object())
            {
                for (name, value) in offered {
                    object.entry(name).or_insert_with(|| value.clone());
                }
            }
            for name in ["afterChunk", "throughChunk"] {
                if let Some(value) = object.get_mut(name) {
                    unsigned(value);
                }
            }
        }
    }
    Ok(())
}

fn plan(value: &mut Value, inventory: Option<&Value>) -> serde_json::Result<()> {
    if value.is_array() {
        *value = json!({"units": std::mem::take(value)});
    }
    fields(
        value,
        &[
            ("binding", &[]),
            ("units", &["sourceUnits", "decisions"]),
            ("aspects", &[]),
        ],
    )?;
    binding(value, inventory)?;
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    if object.get("aspects").is_some_and(Value::is_null) {
        object.remove("aspects");
    }
    if let Some(aspects) = object.get_mut("aspects") {
        array(aspects, true)?;
        if let Some(aspects) = aspects.as_array_mut() {
            for aspect in aspects {
                fields(
                    aspect,
                    &[("aspectId", &["id"]), ("unitIds", &["sourceUnitIds"])],
                )?;
                if let Some(object) = aspect.as_object_mut() {
                    list(object, "unitIds", true)?;
                }
            }
        }
    }
    if let Some(units) = object.get_mut("units") {
        array(units, true)?;
        if let Some(units) = units.as_array_mut() {
            for unit in units {
                fields(
                    unit,
                    &[
                        ("unitId", &["id", "sourceUnitId"]),
                        ("disposition", &[]),
                        ("purposeAspectIds", &["aspectIds"]),
                        ("reason", &["rationale"]),
                    ],
                )?;
                let Some(object) = unit.as_object_mut() else {
                    continue;
                };
                if let Some(disposition) = object.get_mut("disposition") {
                    enum_text(disposition);
                }
                list(object, "purposeAspectIds", true)?;
                // There is one host-owned scope for the entire literal goal.
                // A required decision already declares relevance to that scope.
                if object.get("disposition") == Some(&json!("required"))
                    && object["purposeAspectIds"] == json!([])
                    && let Some(aspects) =
                        inventory.and_then(|inventory| inventory["aspects"].as_array())
                    && aspects.len() == 1
                {
                    object.insert("purposeAspectIds".into(), json!([aspects[0]["id"]]));
                }
                object.entry("reason").or_insert_with(|| json!(""));
            }
        }
    }
    Ok(())
}

fn proof(value: &mut Value, inventory: Option<&Value>) -> serde_json::Result<()> {
    if value.is_array() {
        *value = json!({"placements": std::mem::take(value)});
    }
    fields(
        value,
        &[
            ("binding", &[]),
            ("placements", &["sourcePlacements"]),
            ("hostBodyHashes", &[]),
        ],
    )?;
    binding(value, inventory)?;
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    list(object, "placements", true)?;
    if let Some(placements) = object.get_mut("placements") {
        array(placements, true)?;
        if let Some(placements) = placements.as_array_mut() {
            for placement in placements {
                fields(
                    placement,
                    &[
                        ("unitId", &["sourceUnitId"]),
                        ("pageId", &["targetPageId"]),
                        ("citationRefs", &["refs"]),
                        ("allLines", &["wholePage"]),
                        ("firstLine", &["startLine"]),
                        ("lastLine", &["endLine"]),
                    ],
                )?;
                let Some(object) = placement.as_object_mut() else {
                    continue;
                };
                for name in ["firstLine", "lastLine", "allLines"] {
                    if object.get(name).is_some_and(Value::is_null) {
                        object.remove(name);
                    }
                }
                if let Some(mode) = object.get_mut("allLines") {
                    boolean(mode);
                }
                for name in ["firstLine", "lastLine"] {
                    if let Some(value) = object.get_mut(name) {
                        unsigned(value);
                    }
                }
                if object.get("allLines") == Some(&json!(false))
                    && object.contains_key("firstLine")
                    && object.contains_key("lastLine")
                {
                    object.remove("allLines");
                }
                if !["firstLine", "lastLine", "allLines"]
                    .iter()
                    .any(|name| object.contains_key(*name))
                {
                    object.insert("allLines".into(), true.into());
                }
                if let Some(refs) = object.get_mut("citationRefs") {
                    array(refs, true)?;
                }
            }
        }
    }
    Ok(())
}

pub(super) fn analysis(value: &mut Value, context: Option<&Value>) -> serde_json::Result<()> {
    unwrap(value, &["summary", "analysisSummary"])?;
    fields(
        value,
        &[
            ("summary", &["analysisSummary"]),
            ("queries", &["searchQueries", "searchTerms"]),
            ("conflicts", &["contradictions", "tensions"]),
            ("organizationPlan", &["plan"]),
        ],
    )?;
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    list(object, "queries", true)?;
    list(object, "conflicts", true)?;
    if let Some(value) = object.get_mut("organizationPlan") {
        plan(value, inventory(context))?;
    }
    Ok(())
}

pub(super) fn queries(value: &mut Value) -> serde_json::Result<()> {
    unwrap(value, &["queries", "searchQueries", "searchTerms"])?;
    if value.is_array() {
        *value = json!({"queries":std::mem::take(value)});
    }
    fields(value, &[("queries", &["searchQueries", "searchTerms"])])?;
    if let Some(object) = value.as_object_mut() {
        list(object, "queries", true)?;
    }
    Ok(())
}

pub(super) fn topic_plan(value: &mut Value) -> serde_json::Result<()> {
    unwrap(
        value,
        &[
            "topics",
            "tasks",
            "pages",
            "topicPlans",
            "pagePlans",
            "items",
            "pageId",
            "id",
            "targetPageId",
            "topicId",
        ],
    )?;
    if value.is_array() {
        *value = json!({"topics":std::mem::take(value)});
    }
    if value.as_object().is_some_and(|object| {
        object.keys().any(|name| {
            matches!(
                key(name).as_str(),
                "pageid" | "id" | "targetpageid" | "topicid"
            )
        })
    }) {
        *value = json!({"topics":[std::mem::take(value)]});
    }
    fields(
        value,
        &[
            (
                "topics",
                &["tasks", "pages", "topicPlans", "pagePlans", "items"],
            ),
            ("reviewNotes", &["unresolvedIssues"]),
            ("advisoryNotes", &["notes", "warnings"]),
        ],
    )?;
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    list(object, "reviewNotes", true)?;
    list(object, "advisoryNotes", true)?;
    if let Some(topics) = object.get_mut("topics") {
        array(topics, true)?;
        if let Some(topics) = topics.as_array_mut() {
            for topic in topics {
                fields(
                    topic,
                    &[
                        ("pageId", &["id", "targetPageId", "topicId"]),
                        ("kind", &["type", "pageType", "pageKind", "topicKind"]),
                        ("title", &["name", "topicTitle", "pageTitle"]),
                        ("unitIds", &["sourceUnitIds", "units", "sourceUnits"]),
                    ],
                )?;
                if let Some(object) = topic.as_object_mut() {
                    if let Some(kind) = object.get_mut("kind") {
                        enum_text(kind);
                        if kind == &json!("topic") {
                            *kind = json!("concept");
                        }
                    }
                    list(object, "unitIds", true)?;
                }
            }
        }
    }
    Ok(())
}

pub(super) fn proposal(value: &mut Value, context: Option<&Value>) -> serde_json::Result<()> {
    unwrap(
        value,
        &[
            "pages",
            "pageDrafts",
            "pageId",
            "page",
            "documents",
            "proposals",
            "items",
            "drafts",
        ],
    )?;
    if value.is_array() {
        *value = json!({"pages": std::mem::take(value)});
    }
    if value.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|name| matches!(key(name).as_str(), "pageid" | "targetpageid"))
            || object.keys().any(|name| key(name) == "id")
                && object
                    .keys()
                    .any(|name| matches!(key(name).as_str(), "title" | "name" | "pagetitle"))
                && object.keys().any(|name| {
                    matches!(
                        key(name).as_str(),
                        "markdown" | "body" | "content" | "bodymarkdown"
                    )
                })
            || context.is_some_and(|context| {
                context
                    .get("originalInput")
                    .unwrap_or(context)
                    .get("selectedTopic")
                    .is_some_and(Value::is_object)
            }) && object.keys().any(|name| {
                matches!(
                    key(name).as_str(),
                    "markdown" | "body" | "content" | "bodymarkdown"
                )
            })
    }) {
        *value = json!({"pages": [std::mem::take(value)]});
    }
    fields(
        value,
        &[
            (
                "pages",
                &[
                    "page",
                    "pageDrafts",
                    "documents",
                    "proposals",
                    "items",
                    "drafts",
                ],
            ),
            ("reviewNotes", &["unresolvedIssues"]),
            ("advisoryNotes", &["notes", "warnings"]),
            ("organizationProof", &["proof"]),
        ],
    )?;
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    list(object, "reviewNotes", true)?;
    list(object, "advisoryNotes", true)?;
    if let Some(value) = object.get_mut("organizationProof") {
        proof(value, inventory(context))?;
    }
    if let Some(pages) = object.get_mut("pages") {
        array(pages, true)?;
        if let Some(pages) = pages.as_array_mut() {
            let selected = if pages.len() == 1 {
                context
                    .map(|context| context.get("originalInput").unwrap_or(context))
                    .and_then(|input| input.get("selectedTopic"))
                    .and_then(Value::as_object)
            } else {
                None
            };
            for page in pages {
                fields(
                    page,
                    &[
                        ("pageId", &["id", "targetPageId"]),
                        ("expectedRevision", &["expectedRevisionId", "baseRevision"]),
                        ("kind", &["type", "pageType", "pageKind"]),
                        ("title", &["name", "pageTitle"]),
                        ("markdown", &["body", "content", "bodyMarkdown"]),
                        ("citations", &["references", "refs"]),
                        ("relatedPageIds", &["relatedPages"]),
                    ],
                )?;
                let Some(object) = page.as_object_mut() else {
                    continue;
                };
                if let Some(selected) = selected {
                    // Exactly one host-selected topic is already authoritative.
                    // Fill omissions only; null/foreign identities stay explicit
                    // and pass through to the normal typed/semantic rejection.
                    for name in ["pageId", "kind", "title"] {
                        if let Some(value) = selected.get(name) {
                            object.entry(name).or_insert_with(|| value.clone());
                        }
                    }
                }
                if !object.contains_key("expectedRevision")
                    && let Some(context) = context
                {
                    let input = context.get("originalInput").unwrap_or(context);
                    if let Some(prior) = input
                        .get("existingPages")
                        .and_then(Value::as_array)
                        .and_then(|pages| {
                            pages.iter().find(|prior| {
                                prior["draft"]["pageId"]
                                    == object.get("pageId").cloned().unwrap_or(Value::Null)
                            })
                        })
                        && let Some(revision) = prior.get("revisionId").and_then(Value::as_str)
                    {
                        // This is the exact already-read base, not the latest
                        // revision at commit time. Concurrent human edits still
                        // fail CAS; an explicit null/wrong base stays unchanged.
                        object.insert("expectedRevision".into(), revision.into());
                    }
                }
                if let Some(kind) = object.get_mut("kind") {
                    enum_text(kind);
                    if kind == &json!("topic") {
                        *kind = json!("concept");
                    }
                }
                list(object, "relatedPageIds", true)?;
                list(object, "citations", true)?;
                if let Some(citations) = object.get_mut("citations").and_then(Value::as_array_mut) {
                    for citation in citations {
                        if citation.is_string() {
                            *citation = json!({"ref": std::mem::take(citation)});
                        }
                        // Preserve ref/literal conflicts so expansion rejects
                        // an attempted evidence rewrite rather than hiding it.
                        fields(
                            citation,
                            &[
                                ("ref", &["reference", "spanRef", "citationRef"]),
                                ("sourceId", &[]),
                                ("revisionId", &["sourceRevision"]),
                                ("chunkId", &[]),
                                ("quote", &["excerpt", "quotedText"]),
                                ("firstLine", &["startLine", "lineStart"]),
                                ("lastLine", &["endLine", "lineEnd"]),
                                ("startByte", &["startOffset"]),
                                ("endByte", &["endOffset"]),
                                ("wholeChunk", &["fullChunk"]),
                                ("page", &["sourcePage"]),
                            ],
                        )?;
                        if let Some(object) = citation.as_object_mut() {
                            if !object.contains_key("ref")
                                && ["sourceId", "revisionId", "chunkId", "quote"].iter().all(
                                    |key| {
                                        object
                                            .get(*key)
                                            .and_then(Value::as_str)
                                            .is_some_and(|text| !text.trim().is_empty())
                                    },
                                )
                            {
                                // Complete literal citations retain their established identity
                                // and quote. Extra display coordinates do not rewrite prior evidence.
                                for key in [
                                    "firstLine",
                                    "lastLine",
                                    "startByte",
                                    "endByte",
                                    "wholeChunk",
                                    "page",
                                ] {
                                    object.remove(key);
                                }
                            } else {
                                for key in ["firstLine", "lastLine", "startByte", "endByte", "page"]
                                {
                                    if let Some(value) = object.get_mut(key) {
                                        unsigned(value);
                                    }
                                }
                                if let Some(value) = object.get_mut("wholeChunk") {
                                    boolean(value);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn auxiliary(value: &mut Value, context: Option<&Value>) -> serde_json::Result<()> {
    unwrap(
        value,
        &[
            "units",
            "sourceCoverage",
            "organizationPlan",
            "organizationProof",
        ],
    )?;
    if value.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|name| matches!(key(name).as_str(), "organizationplan" | "organizationproof"))
    }) {
        fields(
            value,
            &[("organizationPlan", &[]), ("organizationProof", &[])],
        )?;
        if let Some(plan_value) = value.get_mut("organizationPlan") {
            plan(plan_value, inventory(context))?;
        }
        if let Some(proof_value) = value.get_mut("organizationProof") {
            proof(proof_value, inventory(context))?;
        }
        return Ok(());
    }
    if value.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|name| matches!(key(name).as_str(), "sourcecoverage" | "coverage"))
    }) {
        fields(
            value,
            &[
                ("units", &["verdicts"]),
                ("sourceCoverage", &["coverage"]),
                ("organizationUnits", &[]),
            ],
        )?;
        let Some(object) = value.as_object_mut() else {
            return Ok(());
        };
        if let Some(coverage) = object.get_mut("sourceCoverage") {
            boolean(coverage);
            if let Some(complete) = coverage.as_bool() {
                *coverage = json!(if complete { "complete" } else { "incomplete" });
            }
            enum_text(coverage);
        }
        for (name, organization) in [("units", false), ("organizationUnits", true)] {
            let Some(rows) = object.get_mut(name) else {
                continue;
            };
            array(rows, true)?;
            if let Some(rows) = rows.as_array_mut() {
                for row in rows {
                    let definitions: &[(&str, &[&str])] = if organization {
                        &[
                            ("unitId", &["sourceUnitId"]),
                            ("verdict", &["supported"]),
                            ("placementIndices", &[]),
                        ]
                    } else {
                        &[
                            ("pageId", &[]),
                            ("unit", &["unitIndex"]),
                            ("verdict", &["supported"]),
                            ("citationIndices", &[]),
                        ]
                    };
                    fields(row, definitions)?;
                    let Some(object) = row.as_object_mut() else {
                        continue;
                    };
                    if let Some(verdict) = object.get_mut("verdict") {
                        boolean(verdict);
                        if let Some(supported) = verdict.as_bool() {
                            *verdict = json!(if supported {
                                "supported"
                            } else {
                                "unsupported"
                            });
                        }
                        enum_text(verdict);
                    }
                    if let Some(unit) = object.get_mut("unit") {
                        unsigned(unit);
                    }
                    let indices = if organization {
                        "placementIndices"
                    } else {
                        "citationIndices"
                    };
                    list(object, indices, true)?;
                    if let Some(value) = object.get_mut(indices)
                        && value.is_number()
                    {
                        *value = Value::Array(vec![std::mem::take(value)]);
                    }
                    if let Some(indices) = object.get_mut(indices).and_then(Value::as_array_mut) {
                        for index in indices {
                            unsigned(index);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_text_and_collection_envelopes_preserve_complete_evidence() {
        let text = "PDF-\nline\t preserved {\"items\":[]}\r\n";
        let page = json!({"id":"owned", "page_kind":"TOPIC", "page_title":"Topic",
            "body":text, "references":{"items":[{"source_id":"s","revision_id":"r","chunk_id":"c","quote":text}]}});
        let wrapped = json!({"items":{"records":[page]},"warnings":"Formatting observation"});
        let raw = json!({"output":json!({"data":format!("Result:\n```json\n{wrapped}\n```")}).to_string(),
            "notes":["Formatting observation", " Keep this text exactly. ", " "]}).to_string();
        let mut canonical = value(&serde_json::to_string(&raw).unwrap()).unwrap();
        proposal(&mut canonical, None).unwrap();
        assert_eq!(canonical["pages"][0]["markdown"], text);
        assert_eq!(canonical["pages"][0]["citations"][0]["quote"], text);
        assert_eq!(canonical["pages"][0]["kind"], "concept");
        assert_eq!(canonical["reviewNotes"], json!([]));
        let notes = canonical["advisoryNotes"].as_array().unwrap();
        assert_eq!(notes.len(), 2);
        assert!(notes.contains(&json!("Formatting observation")));
        assert!(notes.contains(&json!(" Keep this text exactly. ")));
        let typed: crate::WikiProposal = serde_json::from_value(canonical).unwrap();
        assert_eq!(typed.pages[0].markdown.as_bytes(), text.as_bytes());
    }

    #[test]
    fn topic_aliases_single_topics_and_query_arrays_have_canonical_shapes() {
        let topic = json!({"target_page_id":"owned","page_kind":"TOPIC","topic_title":"Subject",
            "source_units":{"items":["unit-owned"]}});
        for raw in [
            json!({"topicPlan":{"page_plans":{"items":[topic.clone()]}}}).to_string(),
            topic.to_string(),
        ] {
            let mut canonical = value(&raw).unwrap();
            topic_plan(&mut canonical).unwrap();
            assert_eq!(
                canonical["topics"],
                json!([{"pageId":"owned","kind":"concept",
                "title":"Subject","unitIds":["unit-owned"]}])
            );
        }
        for raw in [r#"["query one","query two"]"#.to_owned(),
            json!({"result":json!({"search_terms":{"records":["query one","query two"]}}).to_string()}).to_string()] {
            let mut canonical = value(&raw).unwrap();
            queries(&mut canonical).unwrap();
            assert_eq!(canonical, json!({"queries":["query one","query two"]}));
        }
    }

    #[test]
    fn advisory_and_blocking_notes_remain_distinct_and_survive_envelopes() {
        for normalize in [
            proposal_without_context as fn(&mut Value) -> serde_json::Result<()>,
            topic_plan,
        ] {
            let mut canonical = json!({"output":{"pages":[],"warnings":["Check source accuracy","", "Formatting tip"],
                "review_notes":"An actual blocking decision"},
                "notes":["Formatting tip", " Another tip. "],
                "advisory_notes":"Keep every assertion source-backed",
                "unresolved_issues":["An actual blocking decision", "Resolve missing source"]});
            normalize(&mut canonical).unwrap();
            assert_eq!(canonical["reviewNotes"].as_array().unwrap().len(), 2);
            let advice = canonical["advisoryNotes"].as_array().unwrap();
            assert_eq!(advice.len(), 4);
            assert!(
                advice.contains(&json!("Check source accuracy")),
                "no severity guessing from wording"
            );
            assert!(advice.contains(&json!(" Another tip. ")));
        }
    }

    fn proposal_without_context(value: &mut Value) -> serde_json::Result<()> {
        proposal(value, None)
    }

    #[test]
    fn host_selected_metadata_fills_only_single_page_omissions() {
        let context = json!({"originalInput":{"selectedTopic":{"pageId":"owned","kind":"entity","title":"Host planned title"}}});
        let mut canonical = json!({"body":"Exact complete body", "citations":"owned-ref"});
        proposal(&mut canonical, Some(&context)).unwrap();
        assert_eq!(canonical["pages"][0]["pageId"], "owned");
        assert_eq!(canonical["pages"][0]["kind"], "entity");
        assert_eq!(canonical["pages"][0]["title"], "Host planned title");
        assert_eq!(canonical["pages"][0]["markdown"], "Exact complete body");
        let mut foreign = json!({"pages":[{"pageId":"foreign","kind":"query","title":"Explicit title","markdown":"Exact body"}]});
        proposal(&mut foreign, Some(&context)).unwrap();
        assert_eq!(foreign["pages"][0]["pageId"], "foreign");
        assert_eq!(foreign["pages"][0]["kind"], "query");
        assert_eq!(foreign["pages"][0]["title"], "Explicit title");
        let mut explicit_null =
            json!({"pages":[{"pageId":null,"kind":null,"title":null,"markdown":"Exact body"}]});
        proposal(&mut explicit_null, Some(&context)).unwrap();
        assert!(serde_json::from_value::<crate::WikiProposal>(explicit_null).is_err());
        let mut multiple = json!({"pages":[{"markdown":"First"},{"markdown":"Second"}]});
        proposal(&mut multiple, Some(&context)).unwrap();
        assert!(multiple["pages"][0].get("pageId").is_none());
        assert!(serde_json::from_value::<crate::WikiProposal>(multiple).is_err());
        let exact_json_body = r#"{"items": [{"literal": "source structure"}]}"#;
        for mut literal in [
            json!({"content":exact_json_body,"citations":"owned-ref"}),
            json!({"pages":{"content":exact_json_body,"citations":"owned-ref"}}),
        ] {
            proposal(&mut literal, Some(&context)).unwrap();
            assert_eq!(literal["pages"][0]["markdown"], exact_json_body);
            assert_eq!(literal["pages"][0]["pageId"], "owned");
        }
        let mut text_envelope = json!({"content":json!({"pages":[{"pageId":"owned","markdown":exact_json_body}]}).to_string()});
        proposal(&mut text_envelope, Some(&context)).unwrap();
        assert_eq!(text_envelope["pages"][0]["markdown"], exact_json_body);
    }

    #[test]
    fn encoded_conflicts_truncation_and_explicit_failures_stay_errors() {
        for raw in [
            json!({"data":{"pages":[]},"output":{"pages":[{"pageId":"foreign"}]}}).to_string(),
            json!({"output":r#"{"pages":[],"pages":[{"pageId":"foreign"}]}"#}).to_string(),
            json!({"data":{"pages":[]},"output":"{\"pages\":["}).to_string(),
            json!({"output":json!({"pages":[],"status":"truncated"}).to_string()}).to_string(),
        ] {
            let mut canonical = value(&raw).unwrap();
            assert!(proposal(&mut canonical, None).is_err(), "must reject {raw}");
        }
        let mut equal = json!({"data":{"pages":[]},"output":json!({"pages":[]}).to_string()});
        proposal(&mut equal, None).unwrap();
        assert_eq!(equal["pages"], json!([]));
        let mut aliases = json!({"topics":[{"pageId":"owned","targetPageId":"foreign"}]});
        assert!(topic_plan(&mut aliases).is_err());
        let mut body = json!({"pages":[{"pageId":"owned","body":"first","markdown":"second"}]});
        assert!(proposal(&mut body, None).is_err());
    }

    #[test]
    fn prose_fences_and_trailing_commas_keep_decoded_body_and_quote_exact() {
        let text = "PDF-\nline\t  preserved [,}]";
        let raw = format!(
            "Prepared result:\n```javascript\n{{\"data\":{{\"page\":{{\"id\":\"p\",\"type\":\"CONCEPT\",\"title\":\"Topic\",\"body\":{},\"citations\":{{\"source_id\":\"s\",\"revision_id\":\"r\",\"chunk_id\":\"c\",\"quote\":{},}},}},}},}}\n```\nDone.",
            serde_json::to_string(text).unwrap(),
            serde_json::to_string(text).unwrap()
        );
        let mut value = value(&raw).unwrap();
        proposal(&mut value, None).unwrap();
        assert_eq!(value["pages"][0]["markdown"], text);
        assert_eq!(value["pages"][0]["citations"][0]["quote"], text);
        assert_eq!(value["pages"][0]["kind"], "concept");
        assert_eq!(value["pages"][0]["relatedPageIds"], json!([]));
        assert_eq!(value["reviewNotes"], json!([]));
    }

    #[test]
    fn literal_unescaped_newlines_tabs_and_crlf_keep_evidence_bytes_exact() {
        let original = "PDF-\nline\t  preserved\r\nnext line.\n";
        let raw = format!(
            r#"{{"pages":{{"pageId":"p","kind":"concept","title":"Topic","markdown":"{original}","citations":{{"sourceId":"s","revisionId":"r","chunkId":"c","quote":"{original}"}}}}}}"#
        );
        assert!(serde_json::from_str::<Value>(&raw).is_err());
        let mut canonical = value(&raw).unwrap();
        proposal(&mut canonical, None).unwrap();
        assert_eq!(
            canonical["pages"][0]["markdown"]
                .as_str()
                .unwrap()
                .as_bytes(),
            original.as_bytes()
        );
        assert_eq!(
            canonical["pages"][0]["citations"][0]["quote"]
                .as_str()
                .unwrap()
                .as_bytes(),
            original.as_bytes()
        );
        assert!(value("{\"markdown\":\"unfinished\nbody").is_err());
    }

    #[test]
    fn malformed_ambiguous_duplicate_and_reported_errors_do_not_become_results() {
        for raw in [
            "```json\n{\"pages\":[",
            "{}\n{}",
            "{}\n{\"unfinished\":",
            "{\"summary\":\"first\",\"summary\":\"second\"}",
            "{\"citations\":{\"ref\":\"a\",\"\\u0072ef\":\"b\"}}",
        ] {
            assert!(
                value(raw).is_err(),
                "must reject ambiguous or incomplete output: {raw}"
            );
        }
        let mut aliases = value(r#"{"pages":[],"page_drafts":[{"id":"different"}]}"#).unwrap();
        assert!(proposal(&mut aliases, None).is_err());
        let mut reported =
            value(r#"{"data":{"pages":[]},"error":"provider returned incomplete work"}"#).unwrap();
        assert!(proposal(&mut reported, None).is_err());
        for raw in [
            r#"{"data":{"pages":[]},"status":"failed"}"#,
            r#"{"pages":[],"success":false}"#,
        ] {
            assert!(proposal(&mut value(raw).unwrap(), None).is_err());
        }
    }

    #[test]
    fn identical_repeated_fields_and_escaped_reference_keys_are_unambiguous() {
        let mut repeated = value(
            r#"{"summary":"Evidence","summary":"Evidence","queries":[],"search_queries":[]}"#,
        )
        .unwrap();
        analysis(&mut repeated, None).unwrap();
        assert_eq!(repeated["summary"], "Evidence");
        assert_eq!(repeated["queries"], json!([]));
        let reference = value(r#"{"ref":"owned","\u0072ef":"owned"}"#).unwrap();
        assert_eq!(reference, json!({"ref":"owned"}));
        assert!(value(r#"{"ref":"owned","\u0072ef":"foreign"}"#).is_err());
    }

    #[test]
    fn omitted_binding_and_line_metadata_derive_but_supplied_foreign_values_remain_foreign() {
        let inventory = json!({"binding":{"libraryId":"l","sourceId":"s","sourceRevision":"r",
            "purposeHash":"purpose","inventoryHash":"inventory","afterChunk":0,"throughChunk":1},
            "aspects":[{"id":"purpose-0"}]});
        let context = json!({"originalInput":{"sourceInventory":inventory}});
        let mut analysis_value = json!({"summary":"Evidence","organization_plan":{"units":{
            "unit_id":"unit-owned","disposition":"REQUIRED"}}});
        analysis(&mut analysis_value, Some(&context)).unwrap();
        assert_eq!(
            analysis_value["organizationPlan"]["binding"],
            inventory["binding"]
        );
        assert_eq!(
            analysis_value["organizationPlan"]["units"][0]["purposeAspectIds"],
            json!(["purpose-0"])
        );
        assert_eq!(analysis_value["queries"], json!([]));
        let mut proposal_value = json!({"pages":[],"organization_proof":{"binding":{"source_id":"foreign"},
            "placements":{"unit_id":"unit-owned","page_id":"page-owned"}}});
        proposal(&mut proposal_value, Some(&context)).unwrap();
        assert_eq!(
            proposal_value["organizationProof"]["binding"]["sourceId"],
            "foreign"
        );
        assert_eq!(
            proposal_value["organizationProof"]["binding"]["libraryId"],
            "l"
        );
        assert_eq!(
            proposal_value["organizationProof"]["placements"][0]["allLines"],
            true
        );
    }
}
