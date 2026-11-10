"""Exercise the installed Toad application against the real KCoder ACP executable.

Requires batrachian-toad==0.6.20 in an isolated Python 3.14 environment.
The application, ACP client, permissions UI and rendering remain unmodified.
Only its unrelated automatic update check is disabled for this offline probe.
"""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import select
import shlex
import signal
import sys
import tempfile


class OwnedProcesses:
    def __init__(self):
        self.references = {}

    @staticmethod
    def identity(pid):
        try:
            parts = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
            return int(parts[1]), int(parts[19])
        except (OSError, ValueError, IndexError):
            return None

    def observe(self, pid, parent):
        before = self.identity(pid)
        if before is None or before[0] != parent:
            return
        if pid not in self.references:
            fd = os.pidfd_open(pid)
            if self.identity(pid) != before:
                os.close(fd)
                return
            self.references[pid] = fd
        children = set()
        for task in Path(f"/proc/{pid}/task").glob("*"):
            try:
                children.update(map(int, (task / "children").read_text().split()))
            except FileNotFoundError:
                pass
        for child in children:
            self.observe(child, pid)

    def pending(self):
        return [fd for fd in self.references.values() if not select.select([fd], [], [], 0)[0]]

    async def finish(self):
        # Normal EOF must have cleaned up. Forced cleanup is failure evidence.
        for _ in range(300):
            if not self.pending():
                return
            await asyncio.sleep(0.02)
        for fd in self.pending():
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        raise AssertionError("owned client descendants required forced cleanup")

    def close(self):
        for fd in self.references.values():
            os.close(fd)


async def until(predicate, label, timeout=30):
    try:
        async with asyncio.timeout(timeout):
            while not predicate():
                await asyncio.sleep(0.02)
    except TimeoutError as error:
        raise AssertionError(f"deadline exceeded: {label}") from error


async def acceptance(binary, root, evidence):
    assert importlib.metadata.version("batrachian-toad") == "0.6.20"
    from toad.app import ToadApp
    from toad.widgets.conversation import Conversation
    from toad.widgets.prompt import PromptTextArea
    from toad.widgets.question import Question

    class OfflineToad(ToadApp):
        CSS_PATH = Path(sys.modules[ToadApp.__module__].__file__).with_name("toad.tcss")

        async def run_version_check(self):
            # Do not query the vendor's update endpoint during deterministic tests.
            return

    workspace = root / "项目 资料"
    workspace.mkdir()
    toad_config = root / "config" / "toad"
    toad_config.mkdir(parents=True)
    (toad_config / "toad.json").write_text(json.dumps({"statistics": {"allow_collect": False}, "notifications": {"system": "never"}}))
    target = workspace / "审核结果.txt"
    trust = await asyncio.create_subprocess_exec(
        str(binary), "trust", "add", "--path", str(workspace),
        cwd=workspace, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    await asyncio.wait_for(trust.communicate(), 15)
    assert trust.returncode == 0, "cannot prepare isolated trusted workspace"
    requests = []
    errors = []
    streaming = asyncio.Event()
    provider_disconnected = asyncio.Event()
    active_handlers = set()

    async def provider(reader, writer):
        active_handlers.add(asyncio.current_task())
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            length = int(next(line.split(b":", 1)[1] for line in header.split(b"\r\n") if line.lower().startswith(b"content-length:")))
            body = json.loads(await reader.readexactly(length))
            step = len(requests)
            requests.append(body)
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
            if step < 2:
                arguments = {"file_path": str(target), "content": "许可后的唯一成果🙂\n" if step == 0 else "禁止覆盖"}
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"toad-write-{step}", "type": "function", "function": {"name": "write", "arguments": json.dumps(arguments, ensure_ascii=False)}}]}
                finish = "tool_calls"
            elif step == 2:
                delta, finish = {"content": "第一轮完成🙂"}, "stop"
            elif step == 3:
                assert "第一轮完成🙂" in json.dumps(body, ensure_ascii=False), "followup lost assistant context"
                delta, finish = {"content": "第二轮完成✓"}, "stop"
            elif step == 4:
                writer.write(b": waiting for cancellation\n\n")
                await writer.drain()
                streaming.set()
                await asyncio.wait_for(reader.read(), 20)
                provider_disconnected.set()
                return
            elif step == 5:
                delta, finish = {"content": "取消后仍可继续✓"}, "stop"
            else:
                raise AssertionError("unexpected provider replay")
            chunks = [
                {"id": f"toad-{step}", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": f"toad-{step}", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            ]
            for chunk in chunks:
                writer.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
                await writer.drain()
            writer.write(b"data: [DONE]\n\n")
            await writer.drain()
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
        finally:
            writer.close()
            await writer.wait_closed()
            active_handlers.discard(asyncio.current_task())

    server = await asyncio.start_server(provider, "127.0.0.1", 0)
    endpoint = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1"
    command = "exec " + shlex.join([str(binary), "--training-mode", "--permission-mode", "ask", "--max-retries", "0", "--provider", "local", "--model", "fixture", "--local-base-url", endpoint, "acp"])
    data = dict(identity="kcoder-acceptance", name="KCoder ACP", short_name="KCoder", url="https://github.com/KunlunMeta-dev/Kcoder", protocol="acp", type="coding", author_name="KunlunMeta", author_url="", publisher_name="KunlunMeta", publisher_url="", description="Isolated deterministic ACP acceptance", tags=[], help="", run_command={"*": command}, actions={})
    app = OfflineToad(agent_data=data, project_dir=workspace)
    app.settings.set("statistics.allow_collect", False)
    owned = OwnedProcesses()
    process = None
    monitor = None
    report = {"client": "batrachian-toad", "version": "0.6.20", "python": sys.version.split()[0], "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "headless_textual_application": True, "update_check_disabled": True, "paid_model_calls": 0, "assertions": []}
    report["client_acp_module_sha256"] = hashlib.sha256(Path(importlib.metadata.distribution("batrachian-toad").locate_file("toad/acp/agent.py")).read_bytes()).hexdigest()
    report["dependencies"] = dict(sorted((distribution.metadata["Name"], distribution.version) for distribution in importlib.metadata.distributions()))
    try:
        async with server, app.run_test(size=(120, 42)) as pilot:
            await until(lambda: bool(app.screen.query(Conversation)), "conversation mounted")
            conversation = app.screen.query_one(Conversation)
            await until(lambda: conversation.agent_ready, "agent ready")
            agent = conversation.agent
            assert agent.session_id and agent.agent_capabilities.get("loadSession") is not True
            process = agent._process
            assert process is not None

            async def observe():
                while process.returncode is None:
                    owned.observe(process.pid, os.getpid())
                    await asyncio.sleep(0.02)

            monitor = asyncio.create_task(observe())
            await until(lambda: len(owned.references) >= 2, "owned native process observed")
            report["assertions"].append("actual_client_initialize_and_new_session")

            async def submit(text):
                area = conversation.query_one(PromptTextArea)
                area.load_text(text)
                area.focus()
                await pilot.press("enter")

            async def answer(key):
                await until(lambda: bool(app.screen.query(Question)), "permission UI")
                question = app.screen.query_one(Question)
                question.focus()
                assert {option.kind for option in question.options} == {"allow_once", "reject_once"}
                await pilot.press(key)

            start = conversation._turn_count
            await submit("请写入审核结果，任何覆盖都再次询问。")
            await answer("a")
            await until(target.exists, "approved write")
            await answer("r")
            await until(lambda: conversation._turn_count > start, "first turn complete")
            assert target.read_text() == "许可后的唯一成果🙂\n"
            assert sorted(call.get("status") for call in agent.tool_calls.values()) == ["completed", "failed"]
            app.save_screenshot(str(evidence / "toad-first-turn.svg"))
            report["assertions"].extend(["real_permissions_ui_allow_once", "real_permissions_ui_reject_once", "approved_file_content_preserved", "tool_rows_settle_completed_and_failed"])

            start = conversation._turn_count
            await submit("继续上一轮，保留已有上下文。")
            await until(lambda: conversation._turn_count > start, "followup complete")
            report["assertions"].append("continuous_prompt_preserves_history")

            start = conversation._turn_count
            await submit("等待取消的任务")
            await asyncio.wait_for(streaming.wait(), 30)
            # The real Conversation action uses the real Toad ACP cancellation client.
            await pilot.press("escape", "escape")
            await asyncio.wait_for(provider_disconnected.wait(), 10)
            await until(lambda: conversation._turn_count > start, "cancelled turn settled")
            report["assertions"].append("cancel_closes_actual_provider_stream")

            start = conversation._turn_count
            await submit("取消后开始新任务")
            await until(lambda: conversation._turn_count > start, "post cancellation turn")
            assert len(requests) == 6 and not errors, errors
            app.save_screenshot(str(evidence / "toad-after-cancel.svg"))
            report["assertions"].append("next_prompt_works_after_cancel")
            process.stdin.close()
            await asyncio.wait_for(process.wait(), 15)
            assert process.returncode == 0, "ACP process failed during clean EOF"
        await owned.finish()
        report["assertions"].append("all_observed_owned_processes_exited")
        report["status"] = "passed"
    finally:
        if report.get("status") != "passed":
            report["screen"] = type(app.screen).__name__
            report["screen_widgets"] = [type(widget).__name__ for widget in app.screen.walk_children()][:100]
        if process is not None and process.returncode is None:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 15)
            except TimeoutError:
                pass
        if monitor is not None:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        server.close()
        await server.wait_closed()
        if active_handlers:
            for handler in active_handlers:
                handler.cancel()
            await asyncio.gather(*active_handlers, return_exceptions=True)
        report["provider_requests"] = len(requests)
        report["provider_errors"] = errors
        report["owned_processes"] = len(owned.references)
        report["cleanup_confirmed"] = not owned.pending()
        (evidence / "toad-acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        await owned.finish()
        owned.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--python-from-env", action="store_true")
    args = parser.parse_args()
    if args.python_from_env:
        runtime = Path(os.environ["KCODER_ACP_TOAD_PYTHON"])
        assert runtime.is_absolute() and runtime.is_file() and os.access(runtime, os.X_OK)
        argv = [argument for argument in sys.argv if argument != "--python-from-env"]
        os.execv(str(runtime), [str(runtime), *argv])
    assert sys.platform == "linux", "Linux procfs/pidfd ownership required"
    binary = args.binary.resolve(strict=True)
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    private = tempfile.TemporaryDirectory(prefix="kcoder-toad-acceptance-")
    root = Path(private.name)
    # Import the real application only after all account paths are isolated.
    path = os.environ.get("PATH", "/usr/bin:/bin")
    os.environ.clear()
    os.environ.update(HOME=str(root), PATH=path, KCODER_CONFIG_DIR=str(root / "kcoder"), XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"), XDG_CACHE_HOME=str(root / "cache"), TOAD_LOG=str(root / "toad.log"))
    try:
        asyncio.run(acceptance(binary, root, evidence))
    except BaseException:
        # Failed evidence may require inspecting owned state; never delete under workers.
        private._finalizer.detach()
        print(f"failed acceptance state retained at {root}", file=sys.stderr)
        raise
    else:
        private.cleanup()
    print("Toad 0.6.20 ACP application acceptance passed")


if __name__ == "__main__":
    main()
