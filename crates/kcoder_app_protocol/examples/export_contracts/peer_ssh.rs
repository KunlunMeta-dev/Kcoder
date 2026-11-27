//! Draft facts only: these schemas register no RPC, capability or enrollment action.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
    macro_rules! contracts {
        ($($contract:ident),+ $(,)?) => {$(
            super::register::<$contract>(stringify!($contract), fixtures, schemas)?;
        )+};
    }
    contracts!(
        PeerSshEnrollmentV1,
        PeerSshChallengeOfferV1,
        PeerSshChallengeClaimsV1,
        PeerSshNativeProofV1,
        PeerSshGatewayProofV1,
        PeerSshPinCommandV1,
        PeerSshPinReceiptV1,
        PeerSshProfileObservationV1,
        PeerSshPinReceiptReadV1,
        PeerSshAuthOfferParamsV1,
        PeerSshAuthNativeProofParamsV1,
        PeerSshAuthCompleteParamsV1,
        PeerSshAuthCompleteResultV1,
        PeerSshGatewayPinStatusV1,
        PeerSshGatewayProposalPhaseV1,
        PeerSshGatewayProposalV1,
        PeerSshGatewayStatusV1
    );
    Ok(())
}
