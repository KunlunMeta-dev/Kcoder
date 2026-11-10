//! No I/O: project only the complete material set already released by the source port.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) fn annotation(materials: &[Value]) -> Option<Value> {
    let mut pages = Vec::new();
    let mut records = Vec::new();
    for (index, material) in materials.iter().enumerate() {
        if material["kind"] != "publication" || material["schemaVersion"] != 1 {
            return None;
        }
        let publication = &material["publication"];
        let title = publication["draft"]["title"].as_str()?;
        let source_pages = publication["pages"].as_array()?;
        let markdown = source_pages
            .iter()
            .map(|page| page["markdown"].as_str())
            .collect::<Option<Vec<_>>>()?;
        pages.push(markdown);
        records.push(json!({"index":index,"documentTitle":title}));
    }
    let observation =
        kcoder_knowledge::integrations::knowledge::calculate_markdown_material_inventory(&pages);
    let original_sha = format!("{:x}", Sha256::digest(serde_json::to_vec(materials).ok()?));
    let result = json!({"schemaVersion":1,"selectedMaterialsSha256":original_sha,"algorithm":"exact_ordered_markdown_bytes","records":records,"observation":observation});
    (serde_json::to_vec(&result).ok()?.len() <= 8192).then_some(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grouping_uses_original_markdown_but_labels_use_literal_source_record_titles() {
        let material = |title: &str, text: &str| json!({"kind":"publication","schemaVersion":1,"publication":{"draft":{"title":title},"pages":[{"markdown":text}]}});
        let original = vec![
            material("Original document label", "Author: Ada\nSame text\n"),
            material("Second document label", "Author: Ada\nSame text\n"),
            material("Unattributed note", "Author: not supplied\nDistinct text\n"),
        ];
        let before = original.clone();
        let observed = annotation(&original).unwrap();
        assert_eq!(original, before);
        assert_eq!(observed["observation"]["uniqueMaterials"], 2);
        assert_eq!(observed["observation"]["duplicateGroups"], json!([[0, 1]]));
        assert_eq!(observed["records"][2]["documentTitle"], "Unattributed note");
        assert_eq!(
            observed["selectedMaterialsSha256"],
            format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&original).unwrap())
            )
        );
        let mut unsupported = original;
        unsupported.push(json!({"kind":"dataset"}));
        assert!(annotation(&unsupported).is_none());
    }
}
