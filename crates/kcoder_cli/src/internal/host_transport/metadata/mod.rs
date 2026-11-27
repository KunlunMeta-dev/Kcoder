//! App Server capability advertisement and process observations.

#[path = "capabilities.rs"]
mod capabilities;
#[path = "negotiation.rs"]
mod negotiation;

pub use capabilities::server_capabilities;
pub use negotiation::{ClientOptIns, advertise_requested, advertise_thread_capabilities};

#[path = "../../../app_server/resources_processor.rs"]
pub mod resources_processor;

#[cfg(test)]
mod clock_tests {
    #[test]
    fn target_time_sampling_and_event_time_are_advertised_together() {
        let capabilities = super::server_capabilities(true, false);
        assert_eq!(
            capabilities.experimental.get("eventTimestampsV1"),
            Some(&true)
        );
        assert_eq!(
            capabilities.experimental.get("serverResourceSnapshotV1"),
            Some(&true)
        );
    }
}
