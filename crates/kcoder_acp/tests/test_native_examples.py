"""Deterministic, isolated regression checks for the owned ACP probe helpers."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
sys.path.insert(0, str(EXAMPLES))
from native_process_owner import OwnedProcesses
from native_local_provider import LocalProviderScenario
from native_material_probe import MaterialScenario, decode_reader_reply
from native_office_provider import OfficeProviderScenario


class ReceiptShapeTests(unittest.TestCase):
    def test_reader_result_budget_includes_the_actual_envelope_and_newline(self):
        value = {"padding": ""}
        value["padding"] = "x" * (65536 - len(json.dumps(value, separators=(',', ':')).encode()))
        payload = json.dumps({"ok": True, "result": value}, separators=(',', ':')).encode() + b'\n'
        self.assertGreater(len(payload), 65537)
        self.assertEqual(decode_reader_reply(payload, 0)["result"], value)
        value["padding"] += "x"
        oversized = json.dumps({"ok": True, "result": value}, separators=(',', ':')).encode() + b'\n'
        with self.assertRaisesRegex(RuntimeError, "ORIGINAL_MATERIAL_READER_FAILED"):
            decode_reader_reply(oversized, 0)

    @unittest.skipUnless(Path('/usr/bin/node').is_file(), 'explicit Linux Node fixture required')
    def test_preflight_rejects_bad_arguments_and_observation_before_copy(self):
        script = EXAMPLES / 'native_office_preflight.mjs'
        with tempfile.TemporaryDirectory(prefix='owned-acp-preflight-') as root:
            root = Path(root)
            observation = root / 'observation.json'
            for value in [None, 'not an observation', {}]:
                observation.write_text(json.dumps(value))
                run = subprocess.run(['/usr/bin/node', str(script), str(observation), str(root / 'installation')],
                                     env={'PATH': '/usr/bin:/bin'}, capture_output=True, timeout=5)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(b'OFFICE_PREFLIGHT_INVALID_OBSERVATION', run.stderr)
                self.assertFalse((root / 'installation').exists())
            run = subprocess.run(['/usr/bin/node', str(script), str(observation), 'relative-destination'],
                                 env={'PATH': '/usr/bin:/bin'}, capture_output=True, timeout=5)
            self.assertIn(b'absolute destination', run.stderr)
            run = subprocess.run(['/usr/bin/node', str(script)], env={'PATH': '/usr/bin:/bin'}, capture_output=True, timeout=5)
            self.assertIn(b'Usage:', run.stderr)

    def test_reservation_requires_an_actual_accepted_receipt(self):
        scenario = object.__new__(LocalProviderScenario)
        scenario.control_invocations, scenario.seen, scenario.calls = 0, set(), {}
        scenario.accepted, scenario.max_calls, scenario.model = None, 1, "fixture-model"
        scenario.checkpoint = lambda *args, **kwargs: None
        scenario.header = {"version": 1, "operationId": "op", "endpointRevision": "rev", "endpointInstanceId": "ep", "sourceAcceptedSha256": "a" * 64}
        frame = {"id": "native-control-fixture", "params": {**scenario.header, "requestId": "reserve",
            "message": {"method": "reserve_model", "params": {"receiverAccepted": None, "nativeCallId": "call", "providerId": "fixture",
                "modelId": "fixture-model", "modelConfigurationRevision": "rev", "conservativeBound": {"tokens": 10, "modelCalls": 1}}}}}
        with self.assertRaisesRegex(RuntimeError, "RESERVE_ORIGINAL_ACCEPTED_REQUIRED"):
            scenario.control(frame)
        self.assertEqual(scenario.calls, {})

    def test_null_material_receipts_keep_the_closed_diagnostic(self):
        scenario = object.__new__(MaterialScenario)
        scenario.outer_id = 0
        scenario.checkpoint = lambda *args, **kwargs: None
        for reply in [{"result": None}, {"result": {"state": "received", "data": None}}, {"error": None}]:
            with self.subTest(reply=reply), self.assertRaisesRegex(RuntimeError, "ACTUAL_MATERIAL_RECEIPT_REQUIRED"):
                scenario.call(lambda *args: reply, {"requestId": "fixture"})

    def test_office_receipts_require_an_object_reference_and_content_digest(self):
        scenario = object.__new__(OfficeProviderScenario)
        scenario.requests, scenario.generation_approved, scenario.permissions, scenario.text = 3, True, 1, "fixture"
        scenario.checkpoint = lambda *args, **kwargs: None
        for artifact, sha in [(None, "a" * 64), ([], "a" * 64), ({"id": "artifact"}, None)]:
            receipt = {"format": "docx", "artifactRef": artifact}
            if sha is not None:
                receipt["sha256"] = sha
            body = {"tools": [{"function": {"name": name}} for name in ("tool_search", "tool_execute")],
                    "messages": [{"role": "tool", "tool_call_id": "owned-office-create", "content": json.dumps(receipt)}]}
            with self.subTest(receipt=receipt), self.assertRaisesRegex(RuntimeError, "ACTUAL_OFFICE_GENERATION_RECEIPT_REQUIRED"):
                scenario.response_chunks(body)


class ProcessOwnerTests(unittest.TestCase):
    def test_recycled_parent_never_enters_its_new_children(self):
        owner = OwnedProcesses(threading.Event())
        owner.observed[(100, 1)] = 10
        with patch("native_process_owner.process_identity", return_value=(999, 2)), \
                patch("native_process_owner.exited", return_value=False), \
                patch("native_process_owner.Path") as paths, patch("native_process_owner.os.pidfd_open", create=True) as opened:
            owner.descendants(100)
            paths.assert_not_called()
            opened.assert_not_called()

    def test_an_unobserved_child_is_not_a_new_recursion_root(self):
        owner = OwnedProcesses(threading.Event())
        owner.observed[(100, 1)] = 10
        visits = []

        class Task:
            def __truediv__(self, name):
                return self

            def read_text(self):
                return "101"

        class Proc:
            def __init__(self, name):
                self.pid = int(str(name).split("/")[2])

            def iterdir(self):
                visits.append(self.pid)
                return [Task()]

        def identity(pid):
            return (os.getpid(), 1) if pid == 100 else (999, 2)

        with patch("native_process_owner.process_identity", side_effect=identity), \
                patch("native_process_owner.exited", return_value=False), patch("native_process_owner.Path", Proc):
            owner.descendants(100)
        self.assertEqual(visits, [100])

    def test_freeze_rejects_late_observations_from_the_monitor(self):
        owner = OwnedProcesses(threading.Event())
        owner.observed[(100, 1)] = 10
        self.assertEqual(owner.freeze(), [10])
        with patch("native_process_owner.os.pidfd_open", create=True) as opened:
            self.assertIsNone(owner.observe(101, 100))
        opened.assert_not_called()
        self.assertEqual(owner.observed, {(100, 1): 10})

    def test_a_signal_failure_does_not_skip_other_handles_or_final_close(self):
        owner = OwnedProcesses(threading.Event())
        owner.observed.update({(100, 1): 10, (101, 2): 11})
        dead, sent, closed = set(), [], []

        def send(fd, sig):
            sent.append((fd, sig))
            if fd == 11 and sig == signal.SIGTERM:
                raise PermissionError("synthetic owned signal failure")
            dead.add(fd)

        with patch("native_process_owner.exited", side_effect=lambda fd: fd in dead), \
                patch("native_process_owner.signal.pidfd_send_signal", side_effect=send), \
                patch("native_process_owner.os.close", side_effect=closed.append), \
                patch("native_process_owner.time.monotonic", side_effect=range(0, 100, 10)):
            report = owner.cleanup(None)
            self.assertIs(owner.cleanup(None), report)
        self.assertIn((10, signal.SIGTERM), sent)
        self.assertIn((11, signal.SIGKILL), sent)
        self.assertEqual(closed, [10, 11])
        self.assertTrue(report["allObservedExited"])
        self.assertEqual(report["cleanupFailures"], ["term_signal:PermissionError"])

    @unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "Linux pidfd required")
    def test_actual_owned_child_is_signalled_reaped_and_closed(self):
        owner = OwnedProcesses(threading.Event())
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdin=subprocess.PIPE)
        try:
            self.assertIsNotNone(owner.observe(child.pid, os.getpid()))
            report = owner.cleanup(child)
            self.assertTrue(report["allObservedExited"])
            self.assertEqual(report["cleanupFailures"], [])
            self.assertIsNotNone(child.returncode)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    @unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "Linux probe required")
    def test_attempt_diagnostic_failure_preserves_the_original_probe_error(self):
        with tempfile.TemporaryDirectory(prefix="owned-acp-probe-error-") as root:
            root = Path(root)
            binary = root / "synthetic-peer"
            binary.write_text("#!" + sys.executable + "\nimport os,pathlib\npathlib.Path(os.environ['KCODER_CONFIG_DIR'],'large.attempt.json').write_text('x'*(1024*1024+1))\n")
            binary.chmod(0o755)
            private = root / "private"
            private.mkdir()
            report = root / "report.json"
            run = subprocess.run([sys.executable, str(EXAMPLES / "native_original_probe.py"), str(binary), str(private), str(report)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            self.assertEqual(run.returncode, 1, run.stderr.decode())
            self.assertTrue(report.is_file(), run.stderr.decode())
            value = json.loads(report.read_text())
            self.assertEqual(value["ownedAttemptDiagnosticFailure"], "RuntimeError")
            failed = [stage for stage in value["stages"] if stage["stage"] == "failed"]
            self.assertEqual(failed[0]["diagnostic"], "RuntimeError:ACP_CLOSED_BEFORE_RECEIPT")
            self.assertTrue(value["cleanup"]["allObservedExited"])
            self.assertTrue(value["cleanup"]["monitorComplete"])
            self.assertEqual(value["cleanup"]["cleanupFailures"], [])


if __name__ == "__main__":
    unittest.main()
