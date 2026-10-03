"""Launch only the pinned, adjacent Windows-MCP runtime; never install packages."""
from pathlib import Path
import json
import os
import site
import sys

# comtypes initializes the importing thread; use the same COM model as UIA
# executor threads instead of creating an STA without a Windows message pump.
sys.coinit_flags = 0
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent
site.addsitedir(str(root / "packages"))
sys.path.insert(0, str(root / "source" / "src"))
os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["WINDOWS_MCP_WATCHDOG"] = "false"
os.environ["PYTHONIOENCODING"] = "utf-8"
# comtypes creates/imports its generated package as soon as client is imported.
# Install an explicit per-worker package first; assigning client.gen_dir only
# afterwards is too late and leaves __init__.py inside immutable resources.
import tempfile
import types
from importlib.machinery import ModuleSpec
import comtypes

_comtypes_cache = tempfile.TemporaryDirectory(prefix="kcoder-comtypes-")
if Path(_comtypes_cache.name).resolve().is_relative_to(root):
    raise RuntimeError("Worker temporary directory must be outside bundled resources")
_generated = types.ModuleType("comtypes.gen")
_generated.__package__ = "comtypes.gen"
_generated.__path__ = [_comtypes_cache.name]
_generated.__spec__ = ModuleSpec("comtypes.gen", loader=None, is_package=True)
_generated.__spec__.submodule_search_locations = _generated.__path__
sys.modules["comtypes.gen"] = _generated
comtypes.gen = _generated
import comtypes.client
comtypes.client.gen_dir = _comtypes_cache.name
if sys.argv[1:] == ["--kcoder-runtime-check"]:
    import importlib.metadata
    import windows_mcp.__main__
    import pythoncom
    import win32api
    import comtypes
    import importlib.util
    assert importlib.util.find_spec("dxcam") is not None
    names = ["fastmcp", "pywin32", "comtypes", "dxcam", "thefuzz"]
    print(json.dumps({"python": sys.version.split()[0], "desktopProbe": "not_run", "dependencies": {
        name: importlib.metadata.version(name) for name in names
    }}))
else:
    from windows_mcp.__main__ import main
    # Desktop host has its own explicit policy; never inherit another client's
    # ~/.windows-mcp settings or allow callers to select a network transport.
    if sys.argv[1:]:
        raise SystemExit("KCoder desktop worker does not accept custom arguments")
    for name in list(os.environ):
        if name.startswith("WINDOWS_MCP_"):
            del os.environ[name]
    os.environ["WINDOWS_MCP_WATCHDOG"] = "false"
    main(args=["serve", "--transport", "stdio", "--config", str(root / "worker.toml"),
               "--tools", "Snapshot,Screenshot,DisplayInventory,App,Click,Type,Scroll,Move,Shortcut,WaitFor"])
