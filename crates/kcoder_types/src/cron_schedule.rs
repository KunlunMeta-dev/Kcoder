use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CronSchedule {
    At {
        /// RFC3339 timestamp, for example `2026-07-18T09:00:00Z`.
        at: String,
    },
    Every {
        every_seconds: u64,
    },
    /// Legacy schedules retain UTC evaluation.
    Cron {
        expression: String,
    },
    /// Evaluate calendar fields in an explicit IANA timezone. Persisted instants remain UTC.
    ZonedCron {
        expression: String,
        timezone: String,
    },
}
