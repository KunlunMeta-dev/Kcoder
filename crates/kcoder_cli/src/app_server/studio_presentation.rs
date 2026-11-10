//! Per-request declaration validation; history labels and shared brokers are not authority.
use super::*;
use kcoder_types::{ClientPresentationV1, StudioWorkMode};

pub(super) fn validate(
    state: &ConnectionState,
    declaration: Option<&ClientPresentationV1>,
    bound_mode: Option<StudioWorkMode>,
) -> Result<Option<ClientPresentationV1>> {
    let Some(value) = declaration else {
        return Ok(None);
    };
    ensure!(
        value.version == 1,
        "Unsupported clientPresentation version; expected 1"
    );
    ensure!(
        state.studio_work_modes_v1,
        "studioWorkModesV1 negotiation is required"
    );
    if value.inline_widgets {
        ensure!(
            state.inline_widgets_v1,
            "inlineWidgetsV1 negotiation is required"
        );
    }
    if value.isolated_widgets {
        ensure!(
            value.inline_widgets && state.isolated_widgets_v1,
            "isolatedWidgetsV1 negotiation and inline widgets are required"
        );
    }
    let requested = value.studio_work_mode.unwrap_or_default();
    if let Some(bound) = bound_mode {
        ensure!(
            bound == requested,
            "clientPresentation.studioWorkMode does not match this conversation; create a new conversation to switch modes"
        );
    }
    ensure!(
        !value.inline_widgets || requested == StudioWorkMode::Kworker,
        "Inline widgets require kworker mode"
    );
    Ok(Some(value.clone()))
}

pub(super) fn validate_creation(
    state: &ConnectionState,
    mode: Option<StudioWorkMode>,
) -> Result<()> {
    ensure!(
        mode.is_none() || state.studio_work_modes_v1,
        "studioWorkModesV1 negotiation is required"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_requires_current_declaration_capabilities_and_matching_binding() {
        let value = ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: false,
        };
        let mut state = ConnectionState::default();
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_err());
        assert!(
            validate(&state, None, Some(StudioWorkMode::Kworker))
                .unwrap()
                .is_none()
        );
        state.studio_work_modes_v1 = true;
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_err());
        state.inline_widgets_v1 = true;
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_ok());
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kcoder)).is_err());
        assert!(
            validate(
                &state,
                Some(&ClientPresentationV1 {
                    version: 2,
                    ..value
                }),
                None
            )
            .is_err()
        );
    }
}
