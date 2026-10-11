"""Explicit CLI adapters and bounded, failure-aware event collection."""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading

OUTPUT_LIMIT = 2 * 1024 * 1024
LINE_LIMIT = 1024 * 1024


@dataclass(frozen=True)
class AgentCLI:
    backend: str
    executable: str

    @classmethod
    def configured(cls, backend=None, executable=None):
        backend = backend or os.environ.get("SKILL_EVAL_BACKEND", "kcoder")
        if backend not in ("kcoder", "claude"):
            raise RuntimeError("Unsupported SKILL_EVAL_BACKEND; choose kcoder or claude")
        executable = executable or os.environ.get("SKILL_EVAL_CLI", backend)
        resolved = shutil.which(executable)
        if not resolved:
            raise RuntimeError(f"{backend} CLI executable is unavailable")
        return cls(backend, str(Path(resolved).resolve()))

    def environment(self):
        return {key: value for key, value in os.environ.items()
                if self.backend != "claude" or key != "CLAUDECODE"}

    def preflight(self, project_root=None):
        if os.name != "posix":
            raise RuntimeError("Skill CLI helpers currently require POSIX process ownership")
        try:
            help_result = subprocess.run([self.executable, "--help"], capture_output=True,
                                         text=True, timeout=10, env=self.environment())
            required = (["--json", "--permission-mode", "--cwd", "--training-mode", "--tool-profile", "--settings-file"]
                        if self.backend == "kcoder" else ["--output-format", "--include-partial-messages"])
            if help_result.returncode or any(flag not in help_result.stdout for flag in required):
                raise RuntimeError(f"{self.backend} CLI does not expose the required headless capabilities")
            if project_root is not None and self.backend == "kcoder":
                status = subprocess.run([self.executable, "trust", "status", "--path", str(project_root)],
                                        capture_output=True, text=True, timeout=10, env=self.environment())
                if status.returncode or status.stdout.split("\t", 1)[0].strip() != "trusted":
                    raise RuntimeError("KCoder project must already be trusted for project skill evaluation; use 'kcoder trust add --path <project>' explicitly")
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(f"{self.backend} CLI preflight failed: {error}") from error

    def command(self, prompt, project_root, model=None, skills=False, settings_file=None):
        if self.backend == "kcoder":
            command = [self.executable, "--json", "--permission-mode", "dont-ask",
                       "--training-mode", "--tool-profile", "full" if skills else "none", "--cwd", str(project_root)]
            if settings_file is not None:
                command.extend(["--settings-file", str(settings_file)])
            if model:
                command.extend(["--model", model])
            # KCoder's -p is permission mode. The prompt is a positional argument.
            return command + ["--", prompt]
        command = [self.executable, "-p", "--output-format", "stream-json", "--verbose",
                   "--include-partial-messages"]
        if model:
            command.extend(["--model", model])
        return command

    def collect(self, prompt, project_root, timeout, model=None, skill_name=None):
        if os.name != "posix":
            raise RuntimeError("Skill CLI helpers currently require POSIX process ownership")
        collector = EventCollector(self.backend, skill_name)
        errors = []
        stderr_tail = bytearray()

        def read_events(stream):
            try:
                while line := stream.readline(LINE_LIMIT + 1):
                    if len(line) > LINE_LIMIT:
                        raise RuntimeError("Agent event exceeded the line budget")
                    if line.strip():
                        collector.accept(json.loads(line))
            except Exception as error:
                errors.append(str(error))
                # Continue draining; never leave the producer blocked on a pipe.
                while stream.read(8192):
                    pass
            finally:
                stream.close()

        def read_stderr(stream):
            try:
                while chunk := stream.read(8192):
                    stderr_tail.extend(chunk)
                    del stderr_tail[:-65536]
            finally:
                stream.close()

        with tempfile.TemporaryDirectory(prefix="skill-eval-cli-") as temporary, tempfile.TemporaryFile() as stdin:
            settings_file = None
            if self.backend == "kcoder" and skill_name is not None:
                # This read-only overlay permits only explicit skill activation;
                # dont-ask continues to deny other mutating tool actions.
                settings_file = Path(temporary) / "settings.json"
                settings_file.write_text(json.dumps({"allowed_tools": ["skill"]}))
            if self.backend == "claude":
                stdin.write(prompt.encode("utf-8"))
                stdin.seek(0)
            process = subprocess.Popen(self.command(prompt, project_root, model, skills=skill_name is not None, settings_file=settings_file), stdin=stdin,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       cwd=project_root, env=self.environment(),
                                       start_new_session=True)
            threads = [threading.Thread(target=read_events, args=(process.stdout,), daemon=True),
                       threading.Thread(target=read_stderr, args=(process.stderr,), daemon=True)]
            try:
                for thread in threads:
                    thread.start()
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"{self.backend} CLI timed out; evaluation is incomplete") from error
            finally:
                # The CLI can leave children in its group after its leader exits.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
                for thread, stream in zip(threads, (process.stdout, process.stderr)):
                    if thread.ident is not None:
                        thread.join(timeout=5)
                    else:
                        stream.close()
            if any(thread.is_alive() for thread in threads):
                raise RuntimeError("Agent subprocess pipes did not close after cleanup")
            if process.returncode != 0:
                # stderr may contain credentials or private request data; do not echo it.
                raise RuntimeError(f"{self.backend} CLI exited {process.returncode}; infrastructure failure")
            if errors:
                raise RuntimeError(f"Invalid {self.backend} event stream: {errors[0]}")
            if collector.failed or not collector.completed:
                raise RuntimeError(f"{self.backend} CLI did not report a successful terminal result")
        return collector


class EventCollector:
    def __init__(self, backend, skill_name):
        self.backend = backend
        self.skill_name = skill_name
        self.triggered = False
        self.completed = False
        self.failed = False
        self.text = ""
        self.pending = set()
        self.partial_tools = {}

    def is_target(self, name, tool_input):
        if not self.skill_name or not isinstance(tool_input, dict):
            return False
        if name == ("skill" if self.backend == "kcoder" else "Skill"):
            return tool_input.get("skill", tool_input.get("name")) == self.skill_name
        if name == ("read" if self.backend == "kcoder" else "Read"):
            path = str(tool_input.get("file_path", ""))
            return self.skill_name in Path(path).parts or Path(path).name == self.skill_name + ".md"
        return False

    def append_text(self, text):
        if len(self.text.encode("utf-8")) + len(text.encode("utf-8")) > OUTPUT_LIMIT:
            raise RuntimeError("Agent text exceeded the output budget")
        self.text += text

    def accept(self, event):
        if not isinstance(event, dict):
            raise RuntimeError("Agent event must be a JSON object")
        kind = event.get("type")
        if kind == "result":
            self.completed = True
            self.failed |= event.get("subtype") != "success" or event.get("is_error", False)
            if self.backend == "claude" and isinstance(event.get("result"), str):
                self.text = ""
                self.append_text(event["result"])
            return
        if self.backend == "kcoder":
            if kind == "assistant_text_delta":
                self.append_text(event.get("text", ""))
            elif kind == "tool_use_started" and self.is_target(event.get("name"), event.get("input")):
                self.pending.add(event.get("id"))
            elif kind == "tool_result" and event.get("id") in self.pending:
                self.triggered |= not event.get("is_error", False)
            elif kind in ("error", "stream_aborted", "max_turns_reached"):
                self.failed = True
            return
        if kind == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    self.triggered |= self.is_target(block.get("name"), block.get("input"))
        elif kind == "stream_event":
            stream_event = event.get("event", {})
            index = stream_event.get("index")
            if stream_event.get("type") == "content_block_start":
                block = stream_event.get("content_block", {})
                if block.get("type") == "tool_use":
                    self.partial_tools[index] = [block.get("name"), ""]
                    self.triggered |= self.is_target(block.get("name"), block.get("input"))
            elif stream_event.get("type") == "content_block_delta" and index in self.partial_tools:
                delta = stream_event.get("delta", {})
                if delta.get("type") == "input_json_delta":
                    self.partial_tools[index][1] += delta.get("partial_json", "")
                    if len(self.partial_tools[index][1]) > LINE_LIMIT:
                        raise RuntimeError("Agent tool input exceeded the budget")
            elif stream_event.get("type") == "content_block_stop" and index in self.partial_tools:
                name, raw = self.partial_tools.pop(index)
                if raw:
                    self.triggered |= self.is_target(name, json.loads(raw))
