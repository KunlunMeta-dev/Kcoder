"""Encode non-BMP keyboard input as UTF-16 units, not a truncated WORD."""
from pathlib import Path

PREFIX = '''    if len(char) != 1:
        raise ValueError("SendUnicodeChar requires one Unicode character")
    codepoint = ord(char)
    if codepoint > 0xFFFF:
        scalar = codepoint - 0x10000
        units = (0xD800 + (scalar >> 10), 0xDC00 + (scalar & 0x3FF))
        inputs = []
        for unit in units:
            inputs.append(KeyboardInput(0, unit, KeyboardEventFlag.KeyUnicode | KeyboardEventFlag.KeyDown))
            inputs.append(KeyboardInput(0, unit, KeyboardEventFlag.KeyUnicode | KeyboardEventFlag.KeyUp))
        return SendInput(*inputs)
'''


def patch(source):
    anchor = '    if charMode:\n        vk = 0\n        scan = ord(char)\n'
    if source.count(anchor) != 1 or 'scalar = codepoint - 0x10000' in source:
        raise ValueError('Pinned Unicode input implementation changed')
    return source.replace(anchor, PREFIX + anchor)


if __name__ == '__main__':
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding='utf-8'))
    ast.parse(result)
    path.write_text(result, encoding='utf-8')
