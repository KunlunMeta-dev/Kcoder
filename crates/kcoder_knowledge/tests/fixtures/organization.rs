//! Test-only organization certificates for owned fixture material. Verdicts
//! exercise lifecycle/schema only and never stand in for model quality evidence.
use serde_json::{Value, json};

pub fn plan(input: &Value) -> Value {
    let inventory = &input["sourceInventory"];
    let units = inventory["units"].as_array().unwrap();
    let aspects = inventory["aspects"].as_array().unwrap();
    let required = units
        .iter()
        .filter(|unit| !matches!(unit["kind"].as_str(), Some("heading" | "table_header")))
        .map(|unit| unit["id"].clone())
        .collect::<Vec<_>>();
    json!({"binding":inventory["binding"],
        "aspects":aspects.iter().map(|aspect|json!({"aspectId":aspect["id"],"unitIds":required})).collect::<Vec<_>>(),
        "units":units.iter().map(|unit|{let context=matches!(unit["kind"].as_str(),Some("heading"|"table_header"));
            json!({"unitId":unit["id"],"disposition":if context {"context"} else {"required"},
                "purposeAspectIds":if context {vec![]} else {aspects.iter().map(|aspect|aspect["id"].clone()).collect()},
                "reason":if context {"Original named heading/table context is preserved by refs"} else {""}})
        }).collect::<Vec<_>>()})
}

pub fn with_plan(input: &Value, mut analysis: Value) -> Value {
    analysis["organizationPlan"] = plan(input);
    analysis
}

/// Preserve every existing fixture claim (including deliberate unsupported
/// test claims), append genuinely missing source facts in the real topic body,
/// and cite exact offered unit/context spans. Nothing is certified by raw pages.
pub fn with_proof(input: &Value, mut proposal: Value) -> Value {
    let inventory = &input["sourceInventory"];
    let preferred = proposal["pages"]
        .as_array()
        .unwrap()
        .iter()
        .position(|page| {
            page["expectedRevision"].is_null()
                && matches!(
                    page["kind"].as_str(),
                    Some("concept" | "entity" | "synthesis" | "query")
                )
        });
    let Some(target) = preferred.or_else(|| {
        proposal["pages"]
            .as_array()
            .unwrap()
            .iter()
            .position(|page| {
                matches!(
                    page["kind"].as_str(),
                    Some("concept" | "entity" | "synthesis" | "query")
                )
            })
    }) else {
        return proposal;
    };
    let page = &mut proposal["pages"][target];
    let mut body = page["markdown"].as_str().unwrap().to_owned();
    let mut citations = page["citations"].as_array().unwrap().clone();
    let mut placements = Vec::new();
    for unit in inventory["units"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| !matches!(unit["kind"].as_str(), Some("heading" | "table_header")))
    {
        let chunk = input["source"]["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|chunk| chunk["chunkId"] == unit["chunkId"])
            .unwrap();
        let text = &chunk["text"].as_str().unwrap()[unit["startByte"].as_u64().unwrap() as usize
            ..unit["endByte"].as_u64().unwrap() as usize];
        if !body.contains(text.trim_end_matches('\n')) {
            body.push('\n');
            body.push_str(text);
        }
        let mut selected = vec![unit["reference"].clone()];
        selected.extend(unit["contextRefs"].as_array().unwrap().iter().cloned());
        for reference in &selected {
            let span = input["citationSpans"]
                .as_array()
                .unwrap()
                .iter()
                .find(|span| span["ref"] == *reference)
                .unwrap();
            let origin = input["source"]["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|chunk| chunk["chunkId"] == span["chunkId"])
                .unwrap();
            let quote = &origin["text"].as_str().unwrap()[span["startByte"].as_u64().unwrap()
                as usize
                ..span["endByte"].as_u64().unwrap() as usize];
            let literal = json!({"sourceId":input["source"]["sourceId"],"revisionId":input["source"]["revisionId"],"chunkId":span["chunkId"],"quote":quote});
            // Keep ref and literal citation variants intact; no evidence error
            // is silently fixed merely to create the organization sidecar.
            if !citations.contains(&literal)
                && !citations
                    .iter()
                    .any(|citation| citation["ref"] == *reference)
            {
                citations.push(literal);
            }
        }
        placements.push(json!({"unitId":unit["id"],"pageId":page["pageId"],"firstLine":1,"lastLine":body.lines().count(),"citationRefs":selected}));
    }
    page["markdown"] = json!(body);
    page["citations"] = json!(citations);
    proposal["organizationProof"] = json!({"binding":inventory["binding"],"placements":placements});
    proposal
}

pub fn with_organization_support(input: &Value, mut response: Value) -> Value {
    let placements = input["candidate"]["organizationProof"]["placements"]
        .as_array()
        .unwrap();
    response["organizationUnits"]=json!(input["organizationInventory"]["units"].as_array().unwrap().iter().map(|unit|json!({
        "unitId":unit["id"],"verdict":"supported","placementIndices":placements.iter().enumerate()
            .filter(|(_,placement)|placement["unitId"]==unit["id"]).map(|(index,_)|index).collect::<Vec<_>>()
    })).collect::<Vec<_>>());
    response
}
