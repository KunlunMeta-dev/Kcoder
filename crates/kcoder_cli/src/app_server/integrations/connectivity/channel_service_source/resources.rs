//! Shape the original signed references for current native preflight; never accept JSON policy.
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::core::{IntegrationEntityKind, IntegrationEntityRef};

pub(super) fn original_selection(
    connection: &IntegrationEntityRef,
    signed: &[IntegrationEntityRef],
) -> Result<Vec<IntegrationEntityRef>> {
    ensure!(
        matches!(signed.len(), 1 | 2)
            && signed.iter().filter(|value| *value == connection).count() == 1,
        "CHANNEL_SERVICE_SIGNED_RESOURCE_SELECTION_UNSUPPORTED"
    );
    let mut selected = vec![connection.clone()];
    if signed.len() == 2 {
        let assistant = signed
            .iter()
            .find(|value| value.kind == IntegrationEntityKind::Assistant)
            .context("CHANNEL_SERVICE_SIGNED_ASSISTANT_REQUIRED")?;
        selected.push(assistant.clone());
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(kind: IntegrationEntityKind, id: &str, revision: &str) -> IntegrationEntityRef {
        IntegrationEntityRef {
            kind,
            id: id.into(),
            revision: Some(revision.into()),
        }
    }
    #[test]
    fn original_ceiling_shapes_only_exact_connection_and_signed_assistant_for_preflight() {
        let connection = reference(IntegrationEntityKind::Connection, "original", "source-1");
        let assistant = reference(
            IntegrationEntityKind::Assistant,
            "saved",
            &format!("1.0@sha256:{}", "a".repeat(64)),
        );
        assert_eq!(
            original_selection(&connection, std::slice::from_ref(&connection)).unwrap(),
            vec![connection.clone()]
        );
        assert_eq!(
            original_selection(&connection, &[assistant.clone(), connection.clone()]).unwrap(),
            vec![connection.clone(), assistant.clone()]
        );
        for signed in [
            vec![],
            vec![assistant.clone()],
            vec![connection.clone(), connection.clone()],
            vec![
                connection.clone(),
                reference(IntegrationEntityKind::Artifact, "caller-file", "1"),
            ],
            vec![
                reference(IntegrationEntityKind::Connection, "original", "source-2"),
                assistant.clone(),
            ],
            vec![connection.clone(), assistant.clone(), assistant],
        ] {
            assert!(original_selection(&connection, &signed).is_err());
        }
    }
}
