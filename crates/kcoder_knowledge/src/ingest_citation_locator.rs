//! Resolve explicit private source coordinates against this batch's actual
//! immutable chunks. Public citation records remain complete literal evidence.
use super::*;
use serde_json::{Map, Value};
use std::ops::Range;

pub(super) fn literal(
    object: &Map<String, Value>,
    source: &str,
    revision: &str,
    chunks: &[crate::SourceChunk],
    stage: &'static str,
    field: &str,
) -> Result<Option<KnowledgeCitation>> {
    let selectors = [
        "firstLine",
        "lastLine",
        "startByte",
        "endByte",
        "wholeChunk",
    ];
    let has_location = selectors
        .iter()
        .any(|key| object.get(*key).is_some_and(|value| !value.is_null()));
    let declared = |key| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    if !has_location && declared("sourceId") && declared("revisionId") {
        return Ok(None);
    }
    let Some(chunk_id) = object.get("chunkId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let mut matching = chunks.iter().filter(|chunk| chunk.chunk_id == chunk_id);
    let chunk = matching.next().ok_or_else(|| {
        failure(
            stage,
            "wiki_evidence_chunk_not_supplied",
            &format!("{field}/chunkId"),
        )
    })?;
    require(
        matching.next().is_none(),
        stage,
        "wiki_evidence_chunk_ambiguous",
        &format!("{field}/chunkId"),
    )?;
    for (key, expected, code) in [
        ("sourceId", source, "wiki_evidence_source_not_supplied"),
        (
            "revisionId",
            revision,
            "wiki_evidence_revision_not_supplied",
        ),
    ] {
        if let Some(value) = object.get(key) {
            if value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty()) {
                continue;
            }
            require(
                value.as_str() == Some(expected),
                stage,
                code,
                &format!("{field}/{key}"),
            )?;
        }
    }
    if let Some(page) = object.get("page").filter(|value| !value.is_null()) {
        require(
            page == &serde_json::to_value(chunk.page)?,
            stage,
            "wiki_evidence_locator_conflict",
            &format!("{field}/page"),
        )?;
    }
    let selected = if has_location {
        Some(range(object, chunk, stage, field)?)
    } else {
        None
    };
    let quote = match object.get("quote") {
        Some(value) => {
            let quote = value
                .as_str()
                .ok_or_else(|| failure(stage, "wiki_json_type", &format!("{field}/quote")))?;
            // A literal plus coordinates must agree; coordinates cannot hide a
            // forged quote or redirect its later normalization outside this range.
            if let Some(selected) = &selected {
                require(
                    chunk.text[selected.clone()].contains(quote),
                    stage,
                    "wiki_evidence_locator_conflict",
                    &format!("{field}/quote"),
                )?;
            }
            quote.to_owned()
        }
        None => {
            let selected =
                selected.ok_or_else(|| failure(stage, "wiki_evidence_locator_required", field))?;
            chunk.text[selected].to_owned()
        }
    };
    require(
        !quote.trim().is_empty() && quote.len() <= 16 * 1024,
        stage,
        "wiki_evidence_quote_bounds",
        &format!("{field}/quote"),
    )?;
    Ok(Some(KnowledgeCitation {
        source_id: source.into(),
        revision_id: revision.into(),
        chunk_id: chunk_id.into(),
        quote,
    }))
}

fn number(
    object: &Map<String, Value>,
    key: &str,
    stage: &'static str,
    field: &str,
) -> Result<usize> {
    object
        .get(key)
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|text| {
                        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .and_then(|text| text.parse().ok())
            })
        })
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| {
            anyhow::Error::from(failure(stage, "wiki_json_type", &format!("{field}/{key}")))
        })
}
fn range(
    object: &Map<String, Value>,
    chunk: &crate::SourceChunk,
    stage: &'static str,
    field: &str,
) -> Result<Range<usize>> {
    let present = |key| object.get(key).is_some_and(|value| !value.is_null());
    let bytes = present("startByte") || present("endByte");
    let lines = present("firstLine") || present("lastLine");
    let selected = if bytes {
        let start = number(object, "startByte", stage, field)?;
        let end = number(object, "endByte", stage, field)?;
        require(
            start < end
                && end <= chunk.text.len()
                && chunk.text.is_char_boundary(start)
                && chunk.text.is_char_boundary(end),
            stage,
            "wiki_evidence_locator_bounds",
            field,
        )?;
        start..end
    } else if lines {
        let first = number(object, "firstLine", stage, field)?;
        let last = number(object, "lastLine", stage, field)?;
        let raw: Vec<_> = chunk.text.split_inclusive('\n').collect();
        require(
            first >= chunk.first_line
                && first <= last
                && last
                    .checked_sub(chunk.first_line)
                    .is_some_and(|last| last < raw.len()),
            stage,
            "wiki_evidence_locator_bounds",
            field,
        )?;
        let start = raw[..first - chunk.first_line]
            .iter()
            .map(|line| line.len())
            .sum();
        let end = raw[..=last - chunk.first_line]
            .iter()
            .map(|line| line.len())
            .sum();
        start..end
    } else {
        require(
            object.get("wholeChunk") == Some(&Value::Bool(true)),
            stage,
            "wiki_evidence_locator_required",
            field,
        )?;
        0..chunk.text.len()
    };
    if bytes && lines {
        let first = chunk.first_line
            + chunk.text[..selected.start]
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
        let last = first
            + chunk.text[selected.clone()]
                .trim_end_matches('\n')
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
        require(
            number(object, "firstLine", stage, field)? == first
                && number(object, "lastLine", stage, field)? == last,
            stage,
            "wiki_evidence_locator_conflict",
            field,
        )?;
    }
    if let Some(whole) = object.get("wholeChunk").filter(|value| !value.is_null()) {
        require(
            whole.as_bool() == Some(selected.start == 0 && selected.end == chunk.text.len()),
            stage,
            "wiki_evidence_locator_conflict",
            &format!("{field}/wholeChunk"),
        )?;
    }
    Ok(selected)
}
fn failure(stage: &'static str, code: &'static str, field: &str) -> WikiCandidateFailure {
    WikiCandidateFailure {
        stage,
        code,
        field: field.into(),
    }
}
fn require(ok: bool, stage: &'static str, code: &'static str, field: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure(stage, code, field).into())
    }
}
