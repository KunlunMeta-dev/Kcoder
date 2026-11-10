//! Finite public management routes; none bypass native caller or domain policy.
use super::ConnectivityMethod;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_NATIVE_CONNECTIVITY_V1: &str = "connectivityV1";

macro_rules! public_methods {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
        pub enum ConnectivityControlMethod {
            $(#[serde(rename = $wire)] $variant),+
        }
        impl ConnectivityControlMethod {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn parse(wire: &str) -> Option<Self> {
                match wire { $($wire => Some(Self::$variant),)+ _ => None }
            }
            pub const fn wire_name(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
            pub const fn port_method(self) -> ConnectivityMethod {
                match self { $(Self::$variant => ConnectivityMethod::$variant),+ }
            }
        }
    };
}
public_methods! {
    ListConnections => "integrations/connectivity/listConnections",
    ReadConnection => "integrations/connectivity/readConnection",
    ResolveCapability => "integrations/connectivity/resolveCapability",
    ReadResourceGrant => "integrations/connectivity/readResourceGrant",
    PrepareConnectionAction => "integrations/connectivity/prepareConnectionAction",
    InspectReadiness => "integrations/connectivity/inspectReadiness",
    ReadReadiness => "integrations/connectivity/readReadiness",
    VerifyCapability => "integrations/connectivity/verifyCapability",
    SubmitDelivery => "integrations/connectivity/submitDelivery",
    ReadDelivery => "integrations/connectivity/readDelivery",
    CancelDelivery => "integrations/connectivity/cancelDelivery",
    ReconcileDelivery => "integrations/connectivity/reconcileDelivery",
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_management_routes_preserve_original_ports_and_mutation_semantics() {
        let mut names = std::collections::BTreeSet::new();
        let mut writes = 0;
        for &method in ConnectivityControlMethod::ALL {
            assert!(names.insert(method.wire_name()));
            assert_eq!(
                ConnectivityControlMethod::parse(method.wire_name()),
                Some(method)
            );
            assert_eq!(serde_json::to_value(method).unwrap(), method.wire_name());
            let port = method.port_method();
            let leaf = serde_json::to_value(port).unwrap();
            assert_eq!(
                method.wire_name(),
                format!("integrations/connectivity/{}", leaf.as_str().unwrap())
            );
            writes += usize::from(port.is_mutation());
        }
        assert_eq!((names.len(), writes), (12, 5));
        for forbidden in [
            "P-CONNECTION",
            "listConnections",
            "integrations/connectivity/evaluatePolicy",
            "integrations/connectivity/acceptTask",
            "integrations/connectivity/getCredential",
            "integrations/connectivity/handleSdkContext",
        ] {
            assert!(ConnectivityControlMethod::parse(forbidden).is_none());
        }
    }
}
