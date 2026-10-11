"""Patch the pinned Type clear branch without changing input/clipboard guards."""
from pathlib import Path

OLD = '''        if clear is True or (isinstance(clear, str) and clear.lower() == "true"):
            sleep(0.5)
            uia.SendKeys("{Ctrl}a", waitTime=0.05)
            uia.SendKeys("{Back}", waitTime=0.05)
'''
NEW = '''        clear_guard = None
        if clear is True or (isinstance(clear, str) and clear.lower() == "true"):
            from windows_mcp.kcoder_clear import clear_text_field
            clear_guard = clear_text_field(uia, loc)
'''
ANCHOR = '        has_control_chars = any(c in text for c in ("\\n", "\\t", "{", "}"))\n'


def patch(source):
    if source.count(OLD) != 1 or source.count(ANCHOR) != 1 or "kcoder_clear" in source:
        raise ValueError("Pinned Type.clear implementation changed or patch already applied")
    source = source.replace(OLD, NEW)
    return source.replace(ANCHOR, '        if clear_guard is not None:\n            clear_guard()\n' + ANCHOR)


if __name__ == "__main__":
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding="utf-8"))
    ast.parse(result)
    path.write_text(result, encoding="utf-8")
