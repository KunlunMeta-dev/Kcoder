"""Accept all tracked changes in a DOCX file using LibreOffice.

Requires LibreOffice (soffice) to be installed.
"""

import argparse
import logging
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from office.soffice import get_soffice_env

logger = logging.getLogger(__name__)

ACCEPT_CHANGES_MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub AcceptAllTrackedChanges()
        Dim document As Object
        Dim dispatcher As Object

        document = ThisComponent.CurrentController.Frame
        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")

        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())
        ThisComponent.store()
        ThisComponent.close(True)
    End Sub
</script:module>"""


def accept_changes(
    input_file: str,
    output_file: str,
) -> tuple[None, str]:
    input_path = Path(input_file)
    output_path = Path(output_file)

    if not input_path.exists():
        return None, f"Error: Input file not found: {input_file}"

    if not input_path.suffix.lower() == ".docx":
        return None, f"Error: Input file is not a DOCX file: {input_file}"

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # Work on a private copy; publish only after a successful, validated conversion.
        with tempfile.TemporaryDirectory(prefix=".accept-changes-", dir=output_path.parent) as temporary:
            temporary_path = Path(temporary)
            profile = temporary_path / "profile"
            staged = temporary_path / "document.docx"
            shutil.copy2(input_path, staged)
            if not _setup_libreoffice_macro(profile):
                return None, "Error: Failed to setup LibreOffice macro"
            cmd = [
                "soffice", "--headless", f"-env:UserInstallation={profile.absolute().as_uri()}",
                "--norestore",
                "vnd.sun.star.script:Standard.Module1.AcceptAllTrackedChanges?language=Basic&location=application",
                str(staged.absolute()),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                    check=False, env=get_soffice_env())
            if result.returncode != 0:
                return None, f"Error: LibreOffice failed: {result.stderr}"
            _validate_accepted_document(staged)
            os.replace(staged, output_path)
    except subprocess.TimeoutExpired:
        return None, "Error: LibreOffice timed out; acceptance was not confirmed and no output was published"
    except (OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        return None, f"Error: Tracked changes acceptance failed: {error}"

    return None, f"Successfully accepted all tracked changes: {input_file} -> {output_file}"


def _validate_accepted_document(path: Path) -> None:
    namespaces = ("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}",
                  "{http://purl.oclc.org/ooxml/wordprocessingml/main}")
    revisions = {
        "ins", "del", "moveFrom", "moveTo", "cellIns", "cellDel", "cellMerge",
        "numberingChange", "tblGridChange", "tblPrExChange", "customXmlInsRangeStart", "customXmlInsRangeEnd",
        "customXmlDelRangeStart", "customXmlDelRangeEnd", "customXmlMoveFromRangeStart",
        "customXmlMoveFromRangeEnd", "customXmlMoveToRangeStart", "customXmlMoveToRangeEnd",
        "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd",
    }
    with zipfile.ZipFile(path) as archive:
        required_parts = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
        if not required_parts <= set(archive.namelist()) or archive.testzip() is not None:
            raise ValueError("LibreOffice output is not an intact DOCX document")
        for name in required_parts:
            ElementTree.fromstring(archive.read(name))
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        if document.tag not in {namespace + "document" for namespace in namespaces}:
            raise ValueError("LibreOffice output has no Word document root")
        for name in archive.namelist():
            if not name.startswith("word/") or not name.endswith(".xml"):
                continue
            for element in ElementTree.fromstring(archive.read(name)).iter():
                if element.tag.startswith(namespaces):
                    local_name = element.tag.split("}", 1)[1]
                    if local_name in revisions or local_name.endswith("PrChange"):
                        raise ValueError(f"Pending tracked changes remain in {name}")


def _setup_libreoffice_macro(profile: Path) -> bool:
    macro_dir = profile / "user/basic/Standard"
    macro_file = macro_dir / "Module1.xba"
    result = subprocess.run(
        ["soffice", "--headless", f"-env:UserInstallation={profile.absolute().as_uri()}",
         "--terminate_after_init"],
        capture_output=True, timeout=10, check=False, env=get_soffice_env(),
    )
    if result.returncode != 0:
        return False
    try:
        macro_dir.mkdir(parents=True, exist_ok=True)
        macro_file.write_text(ACCEPT_CHANGES_MACRO)
        return True
    except OSError as error:
        logger.warning("Failed to setup LibreOffice macro: %s", error)
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Accept all tracked changes in a DOCX file"
    )
    parser.add_argument("input_file", help="Input DOCX file with tracked changes")
    parser.add_argument(
        "output_file", help="Output DOCX file (clean, no tracked changes)"
    )
    args = parser.parse_args()

    _, message = accept_changes(args.input_file, args.output_file)
    print(message)

    if "Error" in message:
        raise SystemExit(1)
