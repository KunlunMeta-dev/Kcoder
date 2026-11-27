"""Tag the pinned worker's injected inputs for the native cleanup observer."""
from pathlib import Path

HELPER = '''def _kcoder_input_tag():
    import os
    value = int(os.environ.get("KCODER_DESKTOP_INPUT_TAG", "0"))
    if not 0 < value <= 0x7fffffff:
        raise RuntimeError("KCoder input observer authorization is missing")
    return value


def _kcoder_tag_input(value):
    pointer = ctypes.cast(ctypes.c_void_p(_kcoder_input_tag()), ctypes.wintypes.PULONG)
    if value.type == 0:
        value.union.mi.dwExtraInfo = pointer
    elif value.type == 1:
        value.union.ki.dwExtraInfo = pointer
    else:
        raise RuntimeError("Unsupported KCoder input event")


def _kcoder_send_checked(value):
    _kcoder_tag_input(value)
    accepted = ctypes.windll.user32.SendInput(1, ctypes.byref(value), ctypes.sizeof(INPUT))
    if accepted != 1:
        # UIPI may reject input without setting a useful last-error code. Do not
        # claim delivery or replay an action whose earlier events took effect.
        raise RuntimeError("Windows did not accept desktop input; the target may be elevated or unavailable. Earlier input may have taken effect; do not automatically retry.")
    return accepted


'''


def patch(source):
    if '_kcoder_input_tag' in source:
        raise ValueError('Input tagging patch already present')
    pairs = [
        ('    ctypes.windll.user32.mouse_event(dwFlags, dx, dy, dwData, dwExtraInfo)',
         '    _kcoder_send_checked(MouseInput(dx, dy, dwData, dwFlags))'),
        ('    ctypes.windll.user32.keybd_event(bVk, bScan, dwFlags, dwExtraInfo)',
         '    _kcoder_send_checked(KeyboardInput(bVk, bScan, dwFlags))'),
        ('        ret = ctypes.windll.user32.SendInput(1, ctypes.byref(ip), cbSize)',
         '        ret = _kcoder_send_checked(ip)'),
    ]
    for old, new in pairs:
        if source.count(old) != 1:
            raise ValueError('Pinned input implementation changed; update tagging patch')
        source = source.replace(old, new)
    anchor = 'def mouse_event('
    if source.count(anchor) != 1:
        raise ValueError('Pinned input module layout changed')
    return source.replace(anchor, HELPER + anchor)


if __name__ == '__main__':
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding='utf-8'))
    ast.parse(result)
    path.write_text(result, encoding='utf-8')
