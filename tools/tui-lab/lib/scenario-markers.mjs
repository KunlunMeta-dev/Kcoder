export function scenarioToolNeedle(scenario) {
  if (scenario === "orchestrate") {
    return "README.md";
  }
  if (scenario === "orchestrate-control") {
    return "ControlAgent";
  }
  if (scenario === "lsp-diagnostics") {
    return "reportArgumentType";
  }
  if (scenario === "ocr-review") {
    return "OpenCodeReview command:";
  }
  if (scenario === "subagent-trace") {
    return "output_file";
  }
  if (scenario === "mixed-tools") {
    return "sample workspace file edited by mixed tool scenario";
  }
  return "tui-lab-tool-line-001";
}

export function scenarioFinalNeedle(scenario) {
  if (scenario === "long-write") {
    return "tui-lab-long-write-final-sentinel";
  }
  if (scenario === "orchestrate-control") {
    return "tui-lab-orchestrate-control-final-sentinel";
  }
  return "tui-lab-final-sentinel";
}
