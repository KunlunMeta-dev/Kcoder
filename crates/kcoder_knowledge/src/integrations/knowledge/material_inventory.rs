//! Byte-for-byte grouping of already-acquired complete Markdown materials.
use kcoder_types::integrations::knowledge::{
    KnowledgeMaterialInventory, KnowledgeTableArithmeticStatus as Status,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub fn calculate_markdown_material_inventory(
    materials: &[Vec<&str>],
) -> KnowledgeMaterialInventory {
    let mut result = KnowledgeMaterialInventory {
        status: Status::NotApplicable,
        material_sha256: Vec::new(),
        content_groups: Vec::new(),
        duplicate_groups: Vec::new(),
        unique_materials: None,
    };
    if materials.is_empty() {
        return result;
    }
    let calculate = (|| {
        if materials.len() > 16
            || materials.iter().any(|pages| pages.len() > 16)
            || materials
                .iter()
                .flatten()
                .map(|page| page.len())
                .sum::<usize>()
                > 512 * 1024
        {
            return Err(Status::LimitExceeded);
        }
        if materials.iter().any(Vec::is_empty) {
            return Err(Status::Unsupported);
        }
        let mut groups: BTreeMap<&Vec<&str>, Vec<u32>> = BTreeMap::new();
        for (index, pages) in materials.iter().enumerate() {
            // Equality uses the actual ordered string vector, not a hash alone.
            groups.entry(pages).or_default().push(index as u32);
            let bytes = serde_json::to_vec(pages).map_err(|_| Status::Unsupported)?;
            result
                .material_sha256
                .push(format!("{:x}", Sha256::digest(&bytes)));
        }
        result.content_groups = groups.into_values().collect();
        result.content_groups.sort_by_key(|group| group[0]);
        result.duplicate_groups = result
            .content_groups
            .iter()
            .filter(|group| group.len() > 1)
            .cloned()
            .collect();
        result.unique_materials = Some(result.content_groups.len() as u32);
        Ok(())
    })();
    match calculate {
        Ok(()) => result.status = Status::Available,
        Err(status) => {
            result.status = status;
            result.material_sha256.clear();
            result.content_groups.clear();
            result.duplicate_groups.clear();
            result.unique_materials = None;
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_duplicates_do_not_remove_distinct_material_with_missing_metadata() {
        let original = vec![
            vec!["Author: Ana\nContent: approved note\n"],
            vec!["Author: Ana\nContent: approved note\n"],
            vec!["Author: not supplied\nContent: workshop\n"],
        ];
        let result = calculate_markdown_material_inventory(&original);
        assert_eq!(result.status, Status::Available);
        assert_eq!(result.unique_materials, Some(2));
        assert_eq!(result.content_groups, [vec![0, 1], vec![2]]);
        assert_eq!(result.duplicate_groups, [vec![0, 1]]);
        assert_eq!(result.material_sha256[0], result.material_sha256[1]);
        assert_ne!(result.material_sha256[0], result.material_sha256[2]);
        let changed = vec![
            original[0].clone(),
            vec!["Author: Ana\nContent: approved note"],
            original[2].clone(),
        ];
        assert_eq!(
            calculate_markdown_material_inventory(&changed).unique_materials,
            Some(3)
        );
        assert_eq!(
            calculate_markdown_material_inventory(&[vec!["a", "b"], vec!["ab"]]).unique_materials,
            Some(2)
        );
    }
    #[test]
    fn incomplete_or_excessive_input_never_publishes_partial_grouping() {
        let empty = calculate_markdown_material_inventory(&[vec!["a"], vec![]]);
        assert_eq!(empty.status, Status::Unsupported);
        assert!(empty.unique_materials.is_none());
        assert!(empty.content_groups.is_empty());
        let large = "x".repeat(512 * 1024 + 1);
        let exceeded = calculate_markdown_material_inventory(&[vec![&large]]);
        assert_eq!(exceeded.status, Status::LimitExceeded);
        assert!(exceeded.material_sha256.is_empty());
        assert!(
            calculate_markdown_material_inventory(&vec![vec!["x"]; 17])
                .unique_materials
                .is_none()
        );
    }
}
