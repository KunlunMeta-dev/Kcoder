"""Keep UIA COM clients in initialized MTA worker threads.

FastMCP dispatches synchronous calls through its executor. A process-global STA
client can be used by another thread without a pumping owner apartment.
https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading
"""
from pathlib import Path


def patch(source):
    old = '''class _AutomationClient:
    _instance = None

    @classmethod
    def instance(cls) -> "_AutomationClient":
        """Singleton instance (this prevents com creation on import)."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        try:
            ctypes.windll.ole32.CoInitialize(None)
        except Exception:
            pass
'''
    new = '''import threading as _kcoder_threading


class _AutomationClient:
    _local = _kcoder_threading.local()

    @classmethod
    def instance(cls) -> "_AutomationClient":
        """Do not share apartment-bound clients between executor threads."""
        if not hasattr(cls._local, "client"):
            cls._local.client = cls()
        return cls._local.client

    def __init__(self):
        # MTA avoids dependence on an STA Windows message pump. Fail explicitly
        # if a caller has already initialized this thread in an incompatible mode.
        comtypes.CoInitializeEx(0)
'''
    if source.count(old) != 1:
        raise ValueError("Pinned UIA client implementation changed")
    return patch_timeouts(source.replace(old, new))


def patch_timeouts(source):
    old = '''                self.IUIAutomation = comtypes.client.CreateObject(
                    "{ff48dba4-60ef-4201-aa87-54103eef594e}",
                    interface=self.UIAutomationCore.IUIAutomation,
                )'''
    new = '''                # CUIAutomation8 exposes per-provider timeouts; the legacy
                # CUIAutomation instance can hang on an unrelated app's provider.
                self.IUIAutomation = comtypes.client.CreateObject(
                    "{e22ad333-b25f-460c-83d0-0581107395c9}",
                    interface=self.UIAutomationCore.IUIAutomation2,
                )
                self.IUIAutomation.ConnectionTimeout = 1500
                self.IUIAutomation.TransactionTimeout = 2000'''
    if source.count(old) != 1:
        raise ValueError("Pinned UIA object creation changed")
    return source.replace(old, new)


def patch_virtual_desktop(source):
    # Screenshot initializes this service before Snapshot. Leaving it as STA
    # would make the subsequent MTA UIA initialization fail on the same worker.
    old = "ctypes.windll.ole32.CoInitialize(None)"
    if source.count(old) != 1:
        raise ValueError("Pinned virtual desktop COM initialization changed")
    return source.replace(old, "comtypes.CoInitializeEx(0)")


if __name__ == "__main__":
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding="utf-8"))
    virtual_desktop = path.parent.parent / "vdm" / "core.py"
    vdm_result = patch_virtual_desktop(virtual_desktop.read_text(encoding="utf-8"))
    ast.parse(result)
    ast.parse(vdm_result)
    path.write_text(result, encoding="utf-8")
    virtual_desktop.write_text(vdm_result, encoding="utf-8")
