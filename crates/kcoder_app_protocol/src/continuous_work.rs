//! Continuous-work wire shapes. Read-only methods use a separate negotiated
//! capability; the remaining draft methods are not yet advertised.
//!
//! The target host must derive account, target and workspace from the current
//! authenticated connection, resolve the original thread/work binding, and
//! enforce native source guards before handling a request.

use crate::{InteractionStatusKindV1, TaskInteractionReferenceV1, TurnRetentionRequestV1};
pub use kcoder_types::continuous_work::WorkControlTarget as ContinuousWorkControlTarget;
use kcoder_types::continuous_work::{
    MAX_RESULT_REFERENCES, WorkControlAction, WorkControlState, WorkControlTargetFact,
    WorkDeliveryState, WorkInputState, WorkObservationFreshness, WorkPhase, WorkUsage,
    WorkWaitKind,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const CONTINUOUS_WORK_PAGE_SIZE: usize = 10;
// Wire names are defined for review only. The server must not advertise this
// capability until its dispatch, authorization and consumers are implemented.
pub const CAPABILITY_CONTINUOUS_WORK_V1: &str = "continuousWorkV1";
/// Independently negotiated read-only projection; this does not offer control
/// or imply that persistent work can be created or resumed.
pub const CAPABILITY_CONTINUOUS_WORK_READ_V1: &str = "continuousWorkReadV1";
/// Opt in to paged reads that can omit unverified records and flag the page.
pub const CAPABILITY_CONTINUOUS_WORK_PARTIAL_LIST_V1: &str = "continuousWorkPartialListV1";
/// Target-only promise that no persistent work may bind any ephemeral thread.
/// The server must not advertise this until that invariant is enforced.
pub const CAPABILITY_CONTINUOUS_WORK_NO_EPHEMERAL_V1: &str = "continuousWorkNoEphemeralV1";
/// Draft name for durable input acceptance (`work/input/*`). The server must not
/// advertise this until a busy target keeps the input and a later turn consumes
/// it; a client must keep using its own page-local queue until then.
pub const CAPABILITY_CONTINUOUS_WORK_INPUT_V1: &str = "continuousWorkInputV1";
/// Draft name for control submission (`work/control`). The server must not
/// advertise this until it persists the requested control and can report an
/// honest settling/settled/unknown outcome.
pub const CAPABILITY_CONTINUOUS_WORK_CONTROL_V1: &str = "continuousWorkControlV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ContinuousWorkCapability {
    #[serde(rename = "continuousWorkV1")]
    Work,
    #[serde(rename = "continuousWorkReadV1")]
    Read,
    #[serde(rename = "continuousWorkPartialListV1")]
    PartialList,
    #[serde(rename = "continuousWorkNoEphemeralV1")]
    NoEphemeral,
    #[serde(rename = "continuousWorkInputV1")]
    Input,
    #[serde(rename = "continuousWorkControlV1")]
    Control,
}
pub mod method {
    pub const LIST: &str = "work/list";
    pub const READ: &str = "work/read";
    pub const INPUT_SUBMIT: &str = "work/input/submit";
    pub const INPUT_READ: &str = "work/input/read";
    pub const CONTROL: &str = "work/control";
    pub const CHANGED: &str = "work/changed";
}

/// One record never forwards more pending requirements than a compact row can
/// show; the bounded page itself stays a separate observation.
pub const MAX_PENDING_INPUT_VIEWS: usize = 8;
const MAX_ID_BYTES: usize = 256;
const MAX_CURSOR_BYTES: usize = 2048;
// The app-server also checks the complete JSON-RPC frame size. This bounds the
// standalone text even before a caller assembles that frame.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
fn work_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn cursor(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_CURSOR_BYTES && !value.chars().any(char::is_control)
}

/// All listing is scoped by the server; no caller-selected account or target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_after_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<WorkPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Omission retains the original all-or-error list behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
}
impl ContinuousWorkListParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.cursor.as_deref().is_some_and(|v| !cursor(v))
            || self.phase.as_ref().is_some_and(|v| !v.is_known())
            || self
                .query
                .as_ref()
                .is_some_and(|v| v.len() > 1024 || v.chars().any(char::is_control))
        {
            return Err("invalid work list filter");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkReadParams {
    pub work_id: String,
}
impl ContinuousWorkReadParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if work_id(&self.work_id) {
            Ok(())
        } else {
            Err("invalid work identity")
        }
    }
}

/// This is a projection, not the owner's private business record or authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkView {
    pub work_id: String,
    pub thread_id: String,
    /// A reported phase is a point-in-time claim, not completion evidence.
    pub phase: WorkPhase,
    pub revision: u64,
    pub requirements_revision: u64,
    pub freshness: WorkObservationFreshness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<ContinuousWorkWaitView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ContinuousWorkResultView>,
    /// Durable batch counters. Absence is an unobserved record, not zero turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<WorkUsage>,
    /// Accepted requirements that no request consumed yet; absence is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unconsumed_inputs: Option<u64>,
    /// The observed accepted-but-unconsumed requirements with their real
    /// states. Omission means the host did not observe them, never that the
    /// queue is empty; an empty array is an observed empty queue.
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "pending_inputs_schema")
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_inputs: Option<Vec<ContinuousWorkPendingInputView>>,
}
impl ContinuousWorkView {
    /// Check bounded presentation shape only. The host must establish the
    /// original owner, current revision and completion evidence independently.
    /// A completed phase with an unresolved wait remains readable, but must not
    /// be presented as a confirmed completed task.
    pub fn validate_observation(&self) -> Result<(), &'static str> {
        if !work_id(&self.work_id)
            || !atom(&self.thread_id)
            || self.revision == 0
            || self.requirements_revision == 0
            || self
                .title
                .as_ref()
                .is_some_and(|title| title.len() > 512 || title.chars().any(char::is_control))
            || self
                .waiting
                .as_ref()
                .is_some_and(|wait| !atom(&wait.reference))
            || self.pending_inputs.as_ref().is_some_and(|inputs| {
                inputs.len() > MAX_PENDING_INPUT_VIEWS
                    || inputs
                        .iter()
                        .any(|input| input.validate_observation().is_err())
            })
        {
            return Err("invalid continuous work observation");
        }
        if let Some(result) = &self.result {
            result.validate_observation()?;
        }
        Ok(())
    }
}

/// One accepted requirement still waiting for a request. The state is an open
/// label: `applied` only means the requirement entered a request, and an
/// unknown value stays observable without being read as progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkPendingInputView {
    pub input_id: String,
    pub sequence: u64,
    pub state: WorkInputState,
}
impl ContinuousWorkPendingInputView {
    /// Shape only. The host must still prove the requirement is unconsumed.
    pub fn validate_observation(&self) -> Result<(), &'static str> {
        if atom(&self.input_id) && self.sequence > 0 {
            Ok(())
        } else {
            Err("invalid pending work input observation")
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkWaitView {
    pub kind: WorkWaitKind,
    /// The original interaction/event is resolved under the original owner.
    pub reference: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkResultView {
    pub result_id: String,
    pub ready: bool,
    /// The requirement is observed at the parent work's requirements
    /// revision. Omission is legacy unknown, never proof of no requirement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_requirement: Option<ContinuousWorkDeliveryRequirement>,
    /// None means no observed delivery status, not successful delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_delivery_state: Option<WorkDeliveryState>,
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "artifact_refs_schema")
    )]
    pub artifact_refs: Vec<String>,
}
impl ContinuousWorkResultView {
    /// Validate the observed shape without asserting a delivery or completion.
    pub fn validate_observation(&self) -> Result<(), &'static str> {
        if !atom(&self.result_id)
            || self.artifact_refs.len() > MAX_RESULT_REFERENCES
            || self.artifact_refs.iter().any(|reference| !atom(reference))
            || self
                .delivery_requirement
                .as_ref()
                .is_some_and(|requirement| requirement.as_str().len() > MAX_ID_BYTES)
            || (self.delivery_requirement == Some(ContinuousWorkDeliveryRequirement::NotRequired)
                && self.required_delivery_state.is_some())
        {
            return Err("invalid continuous work result observation");
        }
        Ok(())
    }
}

/// Observation of the accepted requirement, not the outcome of a delivery.
/// Unknown labels remain readable but cannot establish that none was required.
#[derive(Clone, PartialEq, Eq)]
pub enum ContinuousWorkDeliveryRequirement {
    NotRequired,
    Required,
    Unobserved,
    Unknown(String),
}
impl std::fmt::Debug for ContinuousWorkDeliveryRequirement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRequired => formatter.write_str("NotRequired"),
            Self::Required => formatter.write_str("Required"),
            Self::Unobserved => formatter.write_str("Unobserved"),
            Self::Unknown(_) => formatter.write_str("Unknown(<redacted>)"),
        }
    }
}
impl ContinuousWorkDeliveryRequirement {
    pub fn as_str(&self) -> &str {
        match self {
            Self::NotRequired => "not_required",
            Self::Required => "required",
            Self::Unobserved => "unknown",
            Self::Unknown(raw) => raw,
        }
    }
}
impl Serialize for ContinuousWorkDeliveryRequirement {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for ContinuousWorkDeliveryRequirement {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw.len() > MAX_ID_BYTES {
            return Err(serde::de::Error::custom(
                "delivery requirement exceeds 256 bytes",
            ));
        }
        Ok(match raw.as_str() {
            "not_required" => Self::NotRequired,
            "required" => Self::Required,
            "unknown" => Self::Unobserved,
            _ => Self::Unknown(raw),
        })
    }
}
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for ContinuousWorkDeliveryRequirement {
    fn schema_name() -> String {
        "ContinuousWorkDeliveryRequirement".into()
    }
    fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
        if let schemars::schema::Schema::Object(object) = &mut schema {
            object
                .extensions
                .insert("x-max-utf8-bytes".into(), serde_json::json!(MAX_ID_BYTES));
            object.extensions.insert(
                "x-known-values".into(),
                serde_json::json!(["not_required", "required", "unknown"]),
            );
        }
        schema
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkListResult {
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "work_page_schema"))]
    pub items: Vec<ContinuousWorkView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Some records in this page could not be verified and were omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

#[cfg(feature = "json-schema")]
fn artifact_refs_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    let mut schema = <Vec<String> as schemars::JsonSchema>::json_schema(generator);
    if let schemars::schema::Schema::Object(object) = &mut schema {
        object.array.get_or_insert_with(Default::default).max_items =
            Some(MAX_RESULT_REFERENCES as u32);
    }
    schema
}

#[cfg(feature = "json-schema")]
fn pending_inputs_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    let mut schema =
        <Vec<ContinuousWorkPendingInputView> as schemars::JsonSchema>::json_schema(generator);
    if let schemars::schema::Schema::Object(object) = &mut schema {
        object.array.get_or_insert_with(Default::default).max_items =
            Some(MAX_PENDING_INPUT_VIEWS as u32);
    }
    schema
}

#[cfg(feature = "json-schema")]
fn work_page_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    let mut schema = <Vec<ContinuousWorkView> as schemars::JsonSchema>::json_schema(generator);
    if let schemars::schema::Schema::Object(object) = &mut schema {
        object.array.get_or_insert_with(Default::default).max_items =
            Some(CONTINUOUS_WORK_PAGE_SIZE as u32);
    }
    schema
}
impl ContinuousWorkListResult {
    /// A page is a bounded observation, not a stable cross-request snapshot.
    pub fn validate_observation(&self) -> Result<(), &'static str> {
        if self.items.len() > CONTINUOUS_WORK_PAGE_SIZE
            || self
                .next_cursor
                .as_deref()
                .is_some_and(|value| !cursor(value))
        {
            return Err("invalid continuous work page");
        }
        let mut seen = std::collections::HashSet::new();
        for work in &self.items {
            work.validate_observation()?;
            if !seen.insert(&work.work_id) {
                return Err("duplicate continuous work observation");
            }
        }
        Ok(())
    }
}

/// A same-schema future presence label remains observable but is never proof
/// of a missing record or permission to perform a mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuousWorkPresence {
    Present,
    ConfirmedAbsent,
    Unreadable,
    Unobserved,
    Unknown(String),
}
impl ContinuousWorkPresence {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Present => "present",
            Self::ConfirmedAbsent => "confirmed_absent",
            Self::Unreadable => "unreadable",
            Self::Unobserved => "unknown",
            Self::Unknown(raw) => raw,
        }
    }
    pub fn is_known(&self) -> bool {
        !matches!(self, Self::Unknown(_))
    }
}
impl Serialize for ContinuousWorkPresence {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for ContinuousWorkPresence {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw.len() > 256 {
            return Err(serde::de::Error::custom("work presence exceeds 256 bytes"));
        }
        Ok(match raw.as_str() {
            "present" => Self::Present,
            "confirmed_absent" => Self::ConfirmedAbsent,
            "unreadable" => Self::Unreadable,
            "unknown" => Self::Unobserved,
            _ => Self::Unknown(raw),
        })
    }
}
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for ContinuousWorkPresence {
    fn schema_name() -> String {
        "ContinuousWorkPresence".into()
    }
    fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
        if let schemars::schema::Schema::Object(object) = &mut schema {
            object
                .extensions
                .insert("x-max-utf8-bytes".into(), serde_json::json!(256));
            object.extensions.insert(
                "x-known-values".into(),
                serde_json::json!(["present", "confirmed_absent", "unreadable", "unknown"]),
            );
        }
        schema
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkReadResult {
    /// Missing is an observation only; it does not create or repair a record.
    pub work: Option<ContinuousWorkView>,
    /// Omission is a legacy unknown observation, never confirmed absence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence: Option<ContinuousWorkPresence>,
}
impl ContinuousWorkReadResult {
    /// Shape consistency only; a host must prove absence or unreadability from
    /// the actual profile store, with no initialization or recovery side effect.
    pub fn validate_observation(&self) -> Result<(), &'static str> {
        if let Some(work) = &self.work {
            work.validate_observation()?;
        }
        match (&self.presence, &self.work) {
            (None | Some(ContinuousWorkPresence::Unknown(_)), _) => Ok(()),
            (Some(ContinuousWorkPresence::Present), Some(_)) => Ok(()),
            (
                Some(
                    ContinuousWorkPresence::ConfirmedAbsent
                    | ContinuousWorkPresence::Unreadable
                    | ContinuousWorkPresence::Unobserved,
                ),
                None,
            ) => Ok(()),
            _ => Err("work presence conflicts with its observed record"),
        }
    }
}

/// The host persists the original text and verified attachment references
/// before acknowledging. It must never treat a receipt ID as authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkInputSubmitParams {
    pub thread_id: String,
    pub work_id: String,
    pub input_id: String,
    pub request_id: String,
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// An original question selector, not an approval or permission grant.
    /// The host verifies that it still belongs to this work and thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<TaskInteractionReferenceV1>,
    /// Separately negotiated retained attachments, verified by native host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<TurnRetentionRequestV1>,
}
impl ContinuousWorkInputSubmitParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !atom(&self.thread_id)
            || !work_id(&self.work_id)
            || !atom(&self.input_id)
            || !atom(&self.request_id)
            || self.expected_revision == 0
            || self
                .text
                .as_ref()
                .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
            || (self.text.as_ref().is_none_or(|text| text.trim().is_empty())
                && self.retention.is_none())
        {
            return Err("invalid continuous work input");
        }
        if let Some(retention) = &self.retention {
            retention.validate()?;
        }
        if let Some(interaction) = &self.interaction {
            interaction.validate()?;
            if interaction.selector.thread_id != self.thread_id
                || interaction.selector.kind != InteractionStatusKindV1::Question
            {
                return Err("input may reference only an original question on this thread");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkInputReadParams {
    pub thread_id: String,
    pub work_id: String,
    pub input_id: String,
}
impl ContinuousWorkInputReadParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if atom(&self.thread_id) && work_id(&self.work_id) && atom(&self.input_id) {
            Ok(())
        } else {
            Err("invalid continuous work input identity")
        }
    }
}

/// No private payload, client-supplied authorization, or execution promise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkInputReceiptView {
    pub thread_id: String,
    pub work_id: String,
    pub input_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub state: WorkInputState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirements_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<TaskInteractionReferenceV1>,
    /// Present only when the target can prove the input entered this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_turn_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkInputResult {
    /// None only reports no observed receipt. It does not permit replay under a new ID.
    pub receipt: Option<ContinuousWorkInputReceiptView>,
}

/// Unknown commands are rejected on input; observations remain lossless strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ContinuousWorkControlAction {
    Pause,
    Resume,
    Stop,
    CancelRun,
    Retry,
    Reconcile,
}
impl From<ContinuousWorkControlAction> for WorkControlAction {
    fn from(value: ContinuousWorkControlAction) -> Self {
        match value {
            ContinuousWorkControlAction::Pause => Self::Pause,
            ContinuousWorkControlAction::Resume => Self::Resume,
            ContinuousWorkControlAction::Stop => Self::Stop,
            ContinuousWorkControlAction::CancelRun => Self::CancelRun,
            ContinuousWorkControlAction::Retry => Self::Retry,
            ContinuousWorkControlAction::Reconcile => Self::Reconcile,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkControlParams {
    pub thread_id: String,
    pub work_id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub action: ContinuousWorkControlAction,
    pub target: ContinuousWorkControlTarget,
}
impl ContinuousWorkControlParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !atom(&self.thread_id)
            || !work_id(&self.work_id)
            || !atom(&self.request_id)
            || self.expected_revision == 0
            || self.target.validate_shape().is_err()
        {
            return Err("invalid continuous work control identity");
        }
        if self.target.matches_action(&self.action.into()) {
            Ok(())
        } else {
            Err("control target does not match action")
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkControlResult {
    pub work_id: String,
    pub request_id: String,
    pub action: WorkControlAction,
    pub target: WorkControlTargetFact,
    pub revision: u64,
    pub control_epoch: u64,
    pub state: WorkControlState,
}
/// Notification contains an observation hint, never an executable command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContinuousWorkChanged {
    pub work_id: String,
    pub revision: u64,
    pub event_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn submit() -> serde_json::Value {
        json!({"threadId":"thread-1","workId":"work-1","inputId":"input-1",
            "requestId":"request-1","expectedRevision":1,"text":"New requirement"})
    }

    #[test]
    fn capability_names_are_frozen_without_advertising_support() {
        assert_eq!(
            serde_json::to_value(ContinuousWorkCapability::Work).unwrap(),
            CAPABILITY_CONTINUOUS_WORK_V1
        );
        assert_eq!(
            serde_json::to_value(ContinuousWorkCapability::NoEphemeral).unwrap(),
            CAPABILITY_CONTINUOUS_WORK_NO_EPHEMERAL_V1
        );
        assert!(
            !crate::ServerCapabilities::default()
                .experimental
                .contains_key(CAPABILITY_CONTINUOUS_WORK_V1)
        );
        assert!(
            !crate::ServerCapabilities::default()
                .experimental
                .contains_key(CAPABILITY_CONTINUOUS_WORK_NO_EPHEMERAL_V1)
        );
        // Draft mutation capabilities keep their reserved wire names so clients
        // and the host cannot drift, but they stay unadvertised by default.
        assert_eq!(CAPABILITY_CONTINUOUS_WORK_INPUT_V1, "continuousWorkInputV1");
        assert_eq!(
            CAPABILITY_CONTINUOUS_WORK_CONTROL_V1,
            "continuousWorkControlV1"
        );
        assert_eq!(
            serde_json::to_value(ContinuousWorkCapability::Input).unwrap(),
            CAPABILITY_CONTINUOUS_WORK_INPUT_V1
        );
        assert_eq!(
            serde_json::to_value(ContinuousWorkCapability::Control).unwrap(),
            CAPABILITY_CONTINUOUS_WORK_CONTROL_V1
        );
        for capability in [
            CAPABILITY_CONTINUOUS_WORK_INPUT_V1,
            CAPABILITY_CONTINUOUS_WORK_CONTROL_V1,
        ] {
            assert!(
                !crate::ServerCapabilities::default()
                    .experimental
                    .contains_key(capability)
            );
        }
        // Method names are part of the frozen draft contract; clients must not
        // guess `work/input` or expect a separate `work/result` method.
        assert_eq!(method::INPUT_SUBMIT, "work/input/submit");
        assert_eq!(method::INPUT_READ, "work/input/read");
        assert_eq!(method::CONTROL, "work/control");
    }

    #[test]
    fn batch_counters_and_unconsumed_inputs_are_optional_observations() {
        let base = json!({"work":{"workId":"work-1","threadId":"thread-1","phase":"running",
            "revision":3,"requirementsRevision":2,"freshness":"current"},"presence":"present"});
        // An older host omits both fields; that is unknown, not zero.
        let legacy: ContinuousWorkReadResult = serde_json::from_value(base.clone()).unwrap();
        assert!(legacy.validate_observation().is_ok());
        let work = legacy.work.expect("work");
        assert_eq!(work.usage, None);
        assert_eq!(work.unconsumed_inputs, None);

        let mut observed = base;
        observed["work"]["usage"] =
            json!({"automaticTurns": 4, "consecutiveFailures": 1, "stalledRounds": 0});
        observed["work"]["unconsumedInputs"] = json!(2);
        let read: ContinuousWorkReadResult = serde_json::from_value(observed).unwrap();
        assert!(read.validate_observation().is_ok());
        let work = read.work.expect("work");
        let usage = work.usage.expect("usage");
        assert_eq!(usage.automatic_turns, 4);
        assert_eq!(usage.consecutive_failures, 1);
        assert_eq!(work.unconsumed_inputs, Some(2));
        // Counters never substitute for completion evidence or a result.
        assert_eq!(work.phase, WorkPhase::Running);
        assert!(work.result.is_none());
    }

    #[test]
    fn pending_inputs_keep_their_real_states_and_stay_optional() {
        let base = json!({"work":{"workId":"work-1","threadId":"thread-1","phase":"running",
            "revision":3,"requirementsRevision":2,"freshness":"partial"},"presence":"present"});
        // An older host omits the queue; that is unobserved, not empty.
        let legacy: ContinuousWorkReadResult = serde_json::from_value(base.clone()).unwrap();
        assert!(legacy.work.expect("work").pending_inputs.is_none());

        let mut observed = base.clone();
        observed["work"]["unconsumedInputs"] = json!(3);
        observed["work"]["pendingInputs"] = json!([
            {"inputId": "input-1", "sequence": 1, "state": "queued"},
            {"inputId": "input-2", "sequence": 2, "state": "rejected"},
            {"inputId": "input-3", "sequence": 3, "state": "future_state"},
        ]);
        let read: ContinuousWorkReadResult = serde_json::from_value(observed.clone()).unwrap();
        read.validate_observation().unwrap();
        // The observed queue round-trips, including the open state label.
        assert_eq!(serde_json::to_value(&read).unwrap(), observed);
        let inputs = read.work.expect("work").pending_inputs.expect("inputs");
        assert_eq!(
            inputs
                .iter()
                .map(|input| (input.input_id.as_str(), input.state.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("input-1", "queued"),
                ("input-2", "rejected"),
                ("input-3", "future_state")
            ]
        );
        assert!(!inputs[2].state.is_known());
        assert_eq!(
            inputs[2].state,
            WorkInputState::Unknown("future_state".into())
        );

        let mut unobserved_state = observed.clone();
        unobserved_state["work"]["pendingInputs"][1]["inputId"] = json!("");
        let read: ContinuousWorkReadResult = serde_json::from_value(unobserved_state).unwrap();
        assert!(read.validate_observation().is_err());
        // An empty observed queue stays distinct from an omitted one.
        let mut empty = base.clone();
        empty["work"]["pendingInputs"] = json!([]);
        let read: ContinuousWorkReadResult = serde_json::from_value(empty.clone()).unwrap();
        assert_eq!(serde_json::to_value(&read).unwrap(), empty);

        let mut unbounded = base;
        let states: Vec<_> = (1..=MAX_PENDING_INPUT_VIEWS + 1)
            .map(|sequence| {
                json!({"inputId": format!("input-{sequence}"), "sequence": sequence,
                    "state": "queued"})
            })
            .collect();
        unbounded["work"]["pendingInputs"] = json!(states);
        let read: ContinuousWorkReadResult = serde_json::from_value(unbounded).unwrap();
        assert!(read.validate_observation().is_err());
    }

    #[test]
    fn read_observation_requires_original_identity_and_positive_revisions() {
        let base = json!({"work":{"workId":"work-1","threadId":"thread-1",
            "phase":"running","revision":3,"requirementsRevision":2,"freshness":"current"},
            "presence":"present"});
        let valid: ContinuousWorkReadResult = serde_json::from_value(base.clone()).unwrap();
        assert!(valid.validate_observation().is_ok());
        for (field, value) in [
            ("workId", json!("../another-work")),
            ("threadId", json!("thread\nforeign")),
            ("revision", json!(0)),
            ("requirementsRevision", json!(0)),
        ] {
            let mut invalid = base.clone();
            invalid["work"][field] = value;
            let observation: ContinuousWorkReadResult = serde_json::from_value(invalid).unwrap();
            assert!(observation.validate_observation().is_err(), "{field}");
        }
        let mut waiting = base.clone();
        waiting["work"]["waiting"] = json!({"kind":"user","reference":""});
        let observation: ContinuousWorkReadResult = serde_json::from_value(waiting).unwrap();
        assert!(observation.validate_observation().is_err());
        let mut title = base.clone();
        title["work"]["title"] = json!("x".repeat(513));
        let observation: ContinuousWorkReadResult = serde_json::from_value(title).unwrap();
        assert!(observation.validate_observation().is_err());
    }

    #[test]
    fn readable_completion_claim_with_unresolved_wait_is_not_rewritten() {
        let raw = json!({"work":{"workId":"work-1","threadId":"thread-1",
            "phase":"completed","revision":3,"requirementsRevision":2,"freshness":"current",
            "waiting":{"kind":"user","reference":"question-1"}},"presence":"present"});
        let observation: ContinuousWorkReadResult = serde_json::from_value(raw.clone()).unwrap();
        assert!(observation.validate_observation().is_ok());
        assert_eq!(serde_json::to_value(observation).unwrap(), raw);
    }

    #[test]
    fn delivery_requirement_preserves_absence_future_and_explicit_none() {
        let base = json!({"resultId":"result-1","ready":true,"artifactRefs":[]});
        let legacy: ContinuousWorkResultView = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(serde_json::to_value(legacy).unwrap(), base);
        for value in ["not_required", "required", "unknown", "future_requirement"] {
            let mut raw = base.clone();
            raw["deliveryRequirement"] = json!(value);
            let result: ContinuousWorkResultView = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(serde_json::to_value(result).unwrap(), raw, "{value}");
        }
        let mut conflicting = base.clone();
        conflicting["deliveryRequirement"] = json!("not_required");
        conflicting["requiredDeliveryState"] = json!("confirmed");
        let result: ContinuousWorkResultView = serde_json::from_value(conflicting).unwrap();
        assert!(result.validate_observation().is_err());
        let mut required = base;
        required["deliveryRequirement"] = json!("required");
        let result: ContinuousWorkResultView = serde_json::from_value(required).unwrap();
        assert!(result.validate_observation().is_ok());
        let future: ContinuousWorkDeliveryRequirement =
            serde_json::from_value(json!("future-private-label")).unwrap();
        assert!(!format!("{future:?}").contains("future-private-label"));
        assert_eq!(
            serde_json::to_value(future).unwrap(),
            "future-private-label"
        );
        let directly_constructed = ContinuousWorkResultView {
            result_id: "result-1".into(),
            ready: true,
            delivery_requirement: Some(ContinuousWorkDeliveryRequirement::Unknown("x".repeat(257))),
            required_delivery_state: None,
            artifact_refs: vec![],
        };
        assert!(directly_constructed.validate_observation().is_err());
        let empty_ref: ContinuousWorkResultView = serde_json::from_value(json!({
            "resultId":"result-1","ready":true,"artifactRefs":[""]
        }))
        .unwrap();
        assert!(empty_ref.validate_observation().is_err());
        let oversized: ContinuousWorkResultView = serde_json::from_value(json!({
            "resultId":"result-1","ready":true,
            "artifactRefs":vec!["reference"; MAX_RESULT_REFERENCES + 1]
        }))
        .unwrap();
        assert!(oversized.validate_observation().is_err());
    }

    #[test]
    fn work_pages_are_bounded_and_never_repeat_a_work_identity() {
        let item = json!({"workId":"work-1","threadId":"thread-1",
            "phase":"future_phase","revision":1,"requirementsRevision":1,"freshness":"future_freshness"});
        let one: ContinuousWorkListResult =
            serde_json::from_value(json!({"items":[item.clone()]})).unwrap();
        assert!(one.validate_observation().is_ok());
        let duplicate: ContinuousWorkListResult =
            serde_json::from_value(json!({"items":[item.clone(),item.clone()]})).unwrap();
        assert!(duplicate.validate_observation().is_err());
        let oversized: ContinuousWorkListResult = serde_json::from_value(json!({
            "items":(0..=CONTINUOUS_WORK_PAGE_SIZE).map(|index| {
                let mut work = item.clone(); work["workId"] = json!(format!("work-{index}")); work
            }).collect::<Vec<_>>()
        }))
        .unwrap();
        assert!(oversized.validate_observation().is_err());
        let cursor: ContinuousWorkListResult =
            serde_json::from_value(json!({"items":[],"nextCursor":""})).unwrap();
        assert!(cursor.validate_observation().is_err());
    }

    #[cfg(feature = "json-schema")]
    #[test]
    fn generated_work_view_schemas_keep_the_native_page_and_artifact_bounds() {
        let result = serde_json::to_value(schemars::schema_for!(ContinuousWorkResultView)).unwrap();
        assert_eq!(
            result["properties"]["artifactRefs"]["maxItems"],
            MAX_RESULT_REFERENCES
        );
        let list = serde_json::to_value(schemars::schema_for!(ContinuousWorkListResult)).unwrap();
        assert_eq!(
            list["properties"]["items"]["maxItems"],
            CONTINUOUS_WORK_PAGE_SIZE
        );
    }

    #[test]
    fn absence_unreadable_and_unknown_observation_are_distinct() {
        for label in [
            "confirmed_absent",
            "unreadable",
            "unknown",
            "future_observation",
        ] {
            let value = json!({"work":null,"presence":label});
            let result: ContinuousWorkReadResult = serde_json::from_value(value.clone()).unwrap();
            result.validate_observation().unwrap();
            assert_eq!(serde_json::to_value(result).unwrap(), value);
        }
        let legacy: ContinuousWorkReadResult =
            serde_json::from_value(json!({"work":null})).unwrap();
        assert!(legacy.presence.is_none());
        legacy.validate_observation().unwrap();
        let contradiction: ContinuousWorkReadResult =
            serde_json::from_value(json!({"work":null,"presence":"present"})).unwrap();
        assert!(contradiction.validate_observation().is_err());
    }

    #[test]
    fn mutation_requests_reject_forged_authority_scope_and_paths() {
        let parsed: ContinuousWorkInputSubmitParams = serde_json::from_value(submit()).unwrap();
        parsed.validate().unwrap();
        for field in [
            "accountId",
            "targetId",
            "workspace",
            "authority",
            "sourceApproved",
            "path",
        ] {
            let mut value = submit();
            value[field] = json!("forged");
            assert!(
                serde_json::from_value::<ContinuousWorkInputSubmitParams>(value).is_err(),
                "{field}"
            );
        }
        let mut invalid = submit();
        invalid["workId"] = json!("../other-profile");
        assert!(
            serde_json::from_value::<ContinuousWorkInputSubmitParams>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
        let mut invalid = submit();
        invalid["expectedRevision"] = json!(0);
        assert!(
            serde_json::from_value::<ContinuousWorkInputSubmitParams>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn retained_attachment_uses_versioned_receipt_not_a_caller_path() {
        let mut value = submit();
        value.as_object_mut().unwrap().remove("text");
        value["retention"] = json!({
            "references": [{"retentionId": format!("r1.root.1.{}", "a".repeat(32)),
                "expectedRevision":1,"entryIds":["entry-1"]}],
            "attachments": [{"entryId":"entry-1","filename":"document.txt","mimeType":"text/plain"}]
        });
        let parsed: ContinuousWorkInputSubmitParams =
            serde_json::from_value(value.clone()).unwrap();
        parsed.validate().unwrap();
        value["retention"]["attachments"][0]["path"] = json!("/other/profile/document.txt");
        assert!(serde_json::from_value::<ContinuousWorkInputSubmitParams>(value).is_err());
        let mut missing = submit();
        missing.as_object_mut().unwrap().remove("text");
        assert!(
            serde_json::from_value::<ContinuousWorkInputSubmitParams>(missing)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn answer_can_reference_only_its_original_thread_question() {
        let mut value = submit();
        value["interaction"] = json!({"attemptId":"attempt-1","selector":{
            "serverId":"server-1","threadId":"thread-1","turnId":"turn-1","requestId":1,
            "appServerEpoch":"epoch-1","kind":"question","questionId":"question-1"
        }});
        let parsed: ContinuousWorkInputSubmitParams =
            serde_json::from_value(value.clone()).unwrap();
        parsed.validate().unwrap();
        value["interaction"]["selector"]["threadId"] = json!("other-thread");
        assert!(
            serde_json::from_value::<ContinuousWorkInputSubmitParams>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["interaction"]["selector"]["threadId"] = json!("thread-1");
        value["interaction"]["selector"]["kind"] = json!("approval");
        value["interaction"]["selector"]
            .as_object_mut()
            .unwrap()
            .remove("questionId");
        value["interaction"]["selector"]["approvalId"] = json!("approval-1");
        assert!(
            serde_json::from_value::<ContinuousWorkInputSubmitParams>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn control_action_must_name_the_original_relevant_run_or_operation() {
        let pause = json!({"threadId":"thread-1","workId":"work-1","requestId":"req-1",
            "expectedRevision":4,"action":"pause","target":{"kind":"work"}});
        let parsed: ContinuousWorkControlParams = serde_json::from_value(pause.clone()).unwrap();
        parsed.validate().unwrap();
        let mut forged_work = pause.clone();
        forged_work["target"]["approved"] = json!(true);
        assert!(serde_json::from_value::<ContinuousWorkControlParams>(forged_work).is_err());
        let mut mismatched = pause.clone();
        mismatched["action"] = json!("cancel_run");
        assert!(
            serde_json::from_value::<ContinuousWorkControlParams>(mismatched)
                .unwrap()
                .validate()
                .is_err()
        );
        let mut cancel = pause.clone();
        cancel["action"] = json!("cancel_run");
        cancel["target"] =
            json!({"kind":"turn","threadId":"thread-1","turnId":"turn-1","attemptId":"attempt-1"});
        serde_json::from_value::<ContinuousWorkControlParams>(cancel.clone())
            .unwrap()
            .validate()
            .unwrap();
        cancel["target"]["authorized"] = json!(true);
        assert!(serde_json::from_value::<ContinuousWorkControlParams>(cancel).is_err());
        let mut future = pause;
        future["action"] = json!("future_action");
        assert!(serde_json::from_value::<ContinuousWorkControlParams>(future).is_err());
    }

    #[test]
    fn observation_preserves_future_labels_without_treating_them_as_completion() {
        let value = json!({"workId":"work-1","threadId":"thread-1","phase":"future_wait",
            "revision":2,"requirementsRevision":1,"freshness":"current"});
        let view: ContinuousWorkView = serde_json::from_value(value.clone()).unwrap();
        assert!(!view.phase.is_known());
        assert_eq!(serde_json::to_value(view).unwrap(), value);
        let receipt = json!({"receipt":{"threadId":"thread-1","workId":"work-1",
            "inputId":"input-1","requestId":"request-1","sequence":3,"state":"queued"}});
        let parsed: ContinuousWorkInputResult = serde_json::from_value(receipt).unwrap();
        assert_eq!(parsed.receipt.unwrap().state, WorkInputState::Queued);
    }
}
