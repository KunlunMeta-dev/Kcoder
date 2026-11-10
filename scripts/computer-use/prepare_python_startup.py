"""Prepare an immutable encoding bootstrap before sealing bundled Python."""
import argparse
import ast
from pathlib import Path
import zipfile

ARCHIVE = "kcoder-bootstrap.zip"
PATH_CONFIG = "python314._pth"
POLICY_VERSION = 1
_ANCHOR = b"import codecs\nimport sys\n"
_REPLACEMENT = (
    b"# KCoder: disable bytecode before importing any filesystem-backed module.\n"
    b"import sys\nsys.dont_write_bytecode = True\nimport codecs\n"
)
PATH_CONTENT = f"{ARCHIVE}\nLib\nDLLs\n.\nimport site\n"


def _plain(path, directory=False):
    info = path.lstat()
    if (path.is_symlink()
            or (hasattr(path, "is_junction") and path.is_junction())
            or (not directory and info.st_nlink != 1)
            or not (path.is_dir() if directory else path.is_file())):
        raise ValueError("Linked or unsupported Python bootstrap input")


def prepare(interpreter_root):
    root = Path(interpreter_root).absolute()
    for parent in (root, root / "Lib", root / "Lib" / "encodings"):
        _plain(parent, directory=True)
    _plain(root / "python314.dll")
    outputs = [root / ARCHIVE, root / PATH_CONFIG, root / "python._pth"]
    if any(path.exists() or path.is_symlink() for path in outputs):
        raise ValueError("Python startup policy already exists; use a fresh build directory")
    sources = []
    for path in sorted((root / "Lib" / "encodings").iterdir()):
        if path.suffix != ".py":
            continue
        _plain(path)
        contents = path.read_bytes().replace(b"\r\n", b"\n")
        if path.name == "__init__.py":
            statements = ast.parse(contents).body
            if statements and isinstance(statements[0], ast.Expr) and isinstance(statements[0].value, ast.Constant) and isinstance(statements[0].value.value, str):
                statements = statements[1:]
            if (contents.count(_ANCHOR) != 1 or len(statements) < 2
                    or not all(isinstance(node, ast.Import) and len(node.names) == 1
                               and node.names[0].name == name and node.names[0].asname is None
                               for node, name in zip(statements[:2], ["codecs", "sys"]))):
                raise ValueError("Unsupported Python encodings bootstrap; re-review pinned source")
            contents = contents.replace(_ANCHOR, _REPLACEMENT, 1)
        sources.append((f"encodings/{path.name}", contents))
    names = {name for name, _ in sources}
    if not {"encodings/__init__.py", "encodings/aliases.py", "encodings/utf_8.py"} <= names:
        raise ValueError("Incomplete Python encoding sources")
    created = []
    try:
        # Stored entries do not need zlib or a filesystem import during bootstrap.
        with zipfile.ZipFile(outputs[0], "x", compression=zipfile.ZIP_STORED) as archive:
            created.append(outputs[0])
            for name, contents in sources:
                archive.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)), contents)
        for path in outputs[1:]:
            with path.open("x", encoding="utf-8", newline="\n") as output:
                created.append(path)
                output.write(PATH_CONTENT)
    except BaseException as error:
        for path in reversed(created):
            try:
                path.unlink()
            except OSError as cleanup_error:
                error.add_note(f"Bootstrap output cleanup failed: {cleanup_error}")
        raise
    return len(sources)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("interpreter_root", type=Path)
    args = parser.parse_args()
    count = prepare(args.interpreter_root)
    print(f"Prepared bytecode startup policy v{POLICY_VERSION}: {count} encoding modules")
