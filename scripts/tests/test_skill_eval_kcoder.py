"""Exercise the real KCoder CLI adapter with a loopback, fixed-response provider."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skills/skill-creator"))
from scripts.run_eval import run_single_query
from scripts.improve_description import _call_agent_cli


class KcoderAdapterContract(unittest.TestCase):
    def test_real_skill_activation_and_improvement_use_kcoder_wire_contract(self):
        binary = Path(os.environ.get("KCODER_TEST_KCODER_BIN", ROOT / "target/debug/kcoder"))
        self.assertTrue(binary.is_file(), "Build the debug CLI before running this contract")
        requests = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            config = root / "config"
            config.mkdir()

            class Provider(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    skill = next(iter(workspace.glob(".kcoder/skills/*/SKILL.md")), None)
                    tool_result = any(message.get("role") == "tool"
                                      for message in request.get("messages", []))
                    if skill is not None and not tool_result:
                        delta = {"tool_calls": [{"index": 0, "id": "fixture-skill-call",
                                 "type": "function", "function": {"name": "skill",
                                 "arguments": json.dumps({"skill": skill.parent.name})}}]}
                        finish = "tool_calls"
                    else:
                        delta = {"content": "<new_description>Fixture description</new_description>"}
                        finish = "stop"
                    events = [
                        {"id": "fixture", "object": "chat.completion.chunk", "choices": [
                            {"index": 0, "delta": delta, "finish_reason": None}]},
                        {"id": "fixture", "object": "chat.completion.chunk", "choices": [
                            {"index": 0, "delta": {}, "finish_reason": finish}]},
                    ]
                    body = ("".join("data: " + json.dumps(event) + "\n\n" for event in events)
                            + "data: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            settings = {
                "active_provider": "fixture", "summary_provider": None, "summary_model": None,
                "max_retries": 0, "providers": {"fixture": {
                    "api_format": "openai_chat_completions",
                    "endpoint": f"http://127.0.0.1:{server.server_port}/v1",
                    "default_model": "fixture-model", "context_window_tokens": 200000,
                    "output_headroom_tokens": 512, "max_output_tokens": 512,
                }},
            }
            (config / "settings.json").write_text(json.dumps(settings))
            (config / "credentials.json").write_text(json.dumps({
                "fixture": {"type": "api", "key": "fixture-not-a-secret"},
            }))
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith(("KCODER_", "KUNLUNMETA_", "OPENAI_",
                                                  "ANTHROPIC_", "GEMINI_", "GROK_"))
                           and "PROXY" not in key.upper()}
            environment.update({
                "KCODER_CONFIG_DIR": str(config), "XDG_CACHE_HOME": str(root / "cache"),
                "SKILL_EVAL_CLI": str(binary), "SKILL_EVAL_BACKEND": "kcoder",
                "KCODER_PROVIDER": "fixture",
            })
            previous = Path.cwd()
            try:
                with patch.dict(os.environ, environment, clear=True):
                    subprocess.run([str(binary), "trust", "add", "--path", str(workspace)],
                                   capture_output=True, text=True, check=True, timeout=15)
                    os.chdir(workspace)
                    self.assertTrue(run_single_query("Use the fixture skill.", "fixture-skill",
                                                     "Fixture only", 30, str(workspace), "fixture-model"))
                    self.assertFalse(list(workspace.glob(".kcoder/skills/*/SKILL.md")))
                    text = _call_agent_cli("Return a fixture description.", "fixture-model", timeout=30)
                    self.assertEqual(text, "<new_description>Fixture description</new_description>")
                self.assertEqual(len(requests), 3, "Training mode must suppress unrelated model requests")
                names = [tool["function"]["name"] for tool in requests[0].get("tools", [])]
                self.assertIn("skill", names)
                self.assertFalse(requests[-1].get("tools"), "Improvement is a text-only request")
            finally:
                os.chdir(previous)
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
