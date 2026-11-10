//! Model-facing desktop tools. Lease/owner are supplied by the host and checked
//! against each invocation's trusted context, including shared tool registries.
use crate::{
    model::{CallToolResult, McpToolDefinition},
    result_content::{convert_result, convert_result_with_image_budget},
};
use async_trait::async_trait;
use kcoder_computer_use::session::DesktopSession;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
use kcoder_types::computer_use::DESKTOP_SCREENSHOT_BASE64_BYTES;
use serde_json::Value;
use std::{sync::Arc, time::Duration};

mod catalog;
pub use catalog::{desktop_tool_candidates, desktop_tool_model_name, desktop_tool_ui_metadata};

pub struct DesktopTool {
    definition: McpToolDefinition,
    session: Arc<DesktopSession>,
}
impl DesktopTool {
    /// Native host inspection only; the lease was acquired by DesktopSession.
    /// The caller must separately verify its current revocable turn binding.
    pub fn native_owner(&self) -> &kcoder_types::computer_use::DesktopOwner {
        self.session.owner()
    }
    pub fn native_lease_active(&self) -> bool {
        *self.session.subscribe_state().borrow()
            == kcoder_types::computer_use::DesktopSessionState::Active
    }
    pub fn new(
        definition: McpToolDefinition,
        session: Arc<DesktopSession>,
    ) -> Result<Self, &'static str> {
        if !kcoder_computer_use::policy::TOOLS.contains(&definition.name.as_str()) {
            return Err("unexpected desktop tool");
        }
        Ok(Self {
            definition,
            session,
        })
    }
}
#[async_trait]
impl Tool for DesktopTool {
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        desktop_tool_ui_metadata(&self.definition.name)
    }
    fn name(&self) -> String {
        desktop_tool_model_name(&self.definition.name)
    }
    fn description(&self) -> String {
        if self.definition.name == "Screenshot" {
            return "[Current Windows desktop] Capture the visible desktop as an image for native model vision, without UI tree extraction. Start without region for a full view; use DisplayInventory and display to select monitors. Use region=[left, top, right, bottom] in virtual-desktop pixels only for a deliberate close-up; region overrides display. Optional use_annotation, width_reference_line and height_reference_line control overlays. Images may be compressed or proportionally reduced without cropping. Follow the returned coordinate instructions: if a Screenshot ID and the screenshot_id input are available, pass that ID with image-pixel loc directly; otherwise use the returned desktop coordinate metadata. Use Snapshot for accessible text or Scroll and observe again for off-screen content. Do not substitute OCR or guess unreadable details.".into();
        }
        if self.definition.name == "Snapshot" {
            return "[Current Windows desktop] Read accessibility/UIA state: windows, text, interactive element labels and scrollable areas. UIA observation still requires desktop authorization even without an image. Use when you need accessible text or element labels; for a quick visual check use Screenshot instead, avoiding a full UIA scan. Do not automatically call both on an unchanged desktop. use_vision adds an image (default false); use_ui_tree=false skips UIA; use_annotation controls image overlays; use_dom requests browser DOM. Optional display selects monitor indices and region=[left,top,right,bottom] limits scope; omit region for the initial full view. Reference-line options add a grid. Virtualized/off-screen content may be absent: Scroll the intended pane and refresh labels instead of assuming the whole document was read. Prefer native model vision for images, not external OCR.".into();
        }
        let navigation = match self.definition.name.as_str() {
            "DisplayInventory" => {
                " Inspect monitor bounds to choose the correct display. This is desktop access and needs desktop authorization; it does not verify that a prior input succeeded."
            }
            "App" => {
                " Use the live schema's supported application/window modes and verify the intended target after switching. Ordinary non-GUI file, process or service work belongs to separately authorized system tools and does not require desktop authorization solely to use those tools."
            }
            "Click" => {
                " Use a fresh UIA label or observed coordinates in the intended window. Refresh observation after layout changes; do not guess controls or automatically replay input after an unknown outcome."
            }
            "Move" => {
                " Use pointer movement or hover only to expose needed controls or tooltips. Observe the result; pointer movement does not itself click or select an item."
            }
            "Shortcut" => {
                " Confirm the focused window before sending a supported key combination. A later Type clicks its target and may cancel a prior selection; set Type clear=true when replacing field contents."
            }
            "WaitFor" => {
                " Use a bounded supported condition, not long polling loops. A retired control channel cannot be restored by waiting; do not repeat unknown-outcome input."
            }
            "Type" => {
                " Provide a current loc or label. Type clicks the target before entering text, which can cancel a selection made by an earlier Ctrl+L or Ctrl+A. To replace existing content such as a browser address or search field, explicitly set clear=true in this Type call. clear=false or omission inserts/appends; use it only when preserving existing text is intended. Verify the resulting field before submitting."
            }
            "Scroll" => {
                " To discover more content, target a fresh label or location inside the intended scrollable pane. Scroll in small steps with overlap, then refresh Snapshot (or Screenshot when needed). Use horizontal scrolling for sideways clipping. Stop when the target/end is reached or observations show no progress; recheck pane and focus instead of looping blindly."
            }
            _ => "",
        };
        format!(
            "[Current Windows desktop] {}{navigation}",
            self.definition.description
        )
    }
    fn input_schema(&self) -> Value {
        self.definition.input_schema.clone()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn source(&self) -> ToolSource {
        ToolSource::Plugin {
            plugin: "kcoder-windows-computer-use@kcoder-bundled".into(),
            server: "computer-use".into(),
            tool: self.definition.name.clone(),
        }
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    // Observations update the UIA label cache; keep all desktop calls ordered and
    // permission-checked instead of trusting upstream readOnly annotations.
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let owner = self.session.owner();
        if !ctx.authorizes_desktop_owner(owner) {
            return Ok(ToolOutput::error(
                "Desktop tool is not authorized for this conversation turn",
            ));
        }
        let input = match kcoder_computer_use::policy::observation_arguments(
            &self.definition.name,
            input,
            ctx.model_supports_images(),
        ) {
            Ok(input) => input,
            Err(message) => return Ok(ToolOutput::error(message)),
        };
        match self
            .session
            .call(&self.definition.name, input, Duration::from_secs(60))
            .await
        {
            Ok(value) => match serde_json::from_value::<CallToolResult>(value) {
                Ok(result)
                    if matches!(self.definition.name.as_str(), "Screenshot" | "Snapshot") =>
                {
                    Ok(convert_result_with_image_budget(
                        result,
                        DESKTOP_SCREENSHOT_BASE64_BYTES,
                    ))
                }
                Ok(result) => Ok(convert_result(result)),
                Err(_) => Ok(ToolOutput::error(
                    kcoder_computer_use::failure::operation_failure(
                        &kcoder_computer_use::client::ClientError::Protocol,
                    )
                    .to_string(),
                )),
            },
            Err(error) => Ok(ToolOutput::error(
                kcoder_computer_use::failure::operation_failure(&error).to_string(),
            )),
        }
    }
}
