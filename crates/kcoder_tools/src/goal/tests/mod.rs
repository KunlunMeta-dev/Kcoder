use super::*;
use crate::{AgentError, AgentKind, AgentRunner};
use kcoder_state::{
    AppState, GoalMode, GoalVerificationKind, GoalVerificationVerdict, goal_report_relative_path,
};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use support::*;
mod evidence;
mod reports;
mod support;
mod transitions;
mod verification;
