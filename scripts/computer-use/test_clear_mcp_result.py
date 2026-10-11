"""Offline FastMCP result contract for uncertain clear; no Windows UI/input.

Pass an owned runtime root to load its sealed helper and dependency packages.
The in-process tool uses a fake UIA ValuePattern and never imports windows_mcp.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import site
from types import SimpleNamespace


def main(runtime):
    runtime = Path(runtime).resolve(strict=True)
    site.addsitedir(str(runtime / "packages"))
    spec = importlib.util.spec_from_file_location("sealed_clear", runtime / "source/src/windows_mcp/kcoder_clear.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    from fastmcp import Client, FastMCP

    writes, typing = [], []
    class Pattern:
        IsReadOnly = False
        Value = "owned fake text"
        def SetValue(self, value, waitTime):
            writes.append(value)
            self.Value = value
            return False  # uncertain acknowledgment after a possible write
    pattern = Pattern()
    window = SimpleNamespace(NativeWindowHandle=100, ProcessId=4)
    target = SimpleNamespace(ControlType=50004, IsPassword=False, IsEnabled=True,
        HasKeyboardFocus=True, ProcessId=4, GetRuntimeId=lambda:[4,9],
        GetTopLevelControl=lambda:window, GetValuePattern=lambda:pattern,
        Element=SimpleNamespace(GetCurrentPropertyValue=lambda _:True))
    uia = SimpleNamespace(ControlType=SimpleNamespace(EditControl=50004),
        PropertyId=SimpleNamespace(IsValuePatternAvailableProperty=30043),
        ControlFromPoint=lambda *loc:target, GetFocusedControl=lambda:target,
        GetForegroundControl=lambda:window)
    server = FastMCP("offline-clear-result-contract")
    @server.tool(name="Type")
    def type_tool(text: str, clear: bool = False) -> str:
        if clear:
            helper.clear_text_field(uia, [10,20])()
        typing.append(text)
        return "typed"

    async def verify():
        async with Client(server) as client:
            result = await client.call_tool_mcp("Type", {"text":"must-not-type", "clear":True})
            wire = result.model_dump(by_alias=True)
            assert wire["isError"] is True, wire
            assert writes == [""], writes
            assert typing == [], typing
            return {"isError":wire["isError"], "clearWrites":len(writes),
                "typingCalls":len(typing), "realWindowsInputSent":False,
                "resultKind":"MCP CallToolResult", "diagnosticTextUsedForClassification":False}
    print(json.dumps(asyncio.run(verify())))


if __name__ == "__main__":
    main(sys.argv[1])
