"""Owned Octop embedded adapter. No credential-store reads or implicit live fallback."""
from __future__ import annotations

import asyncio
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

ALLOWED_TOOLS = frozenset({"searchfree_search", "web_fetch"})
FORBIDDEN_ENV = ("TAVILY_API_KEY", "BRAVE_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CSE_ID", "MOONSHOT_API_KEY", "SEARCHFREE_ENDPOINT", "SEARCHFREE_TIMEOUT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY")


def emit(value):
    print("OCTOP_RESEARCH " + json.dumps(value, ensure_ascii=False), flush=True)


def public_chunk(chunk):
    """Keep public tool bodies; do not persist raw state snapshots or reasoning."""
    kind = str(chunk.get("type", ""))
    if kind == "token":
        return {"type": kind, "text": str(chunk.get("content", ""))}
    if kind in {"tool_call_chunk", "tool_start"}:
        return {key: chunk[key] for key in ("type", "id", "call_id", "name", "args", "index") if key in chunk}
    if kind in {"tool_result", "tool_end"}:
        messages = []
        for raw in chunk.get("messages", []):
            message = raw if isinstance(raw, dict) else raw.model_dump()
            if message.get("type", message.get("role")) != "tool":
                continue
            messages.append({key: message[key] for key in ("tool_call_id", "name", "content", "status") if key in message})
        return {"type": "tool_result", "messages": messages}
    if kind in {"done", "error", "usage", "hitl_required"}:
        if kind == "usage":
            return {"type": kind, "usage": {key: value for key, value in (chunk.get("usage") or {}).items() if isinstance(value, (int, float))},
                    **{key: chunk[key] for key in ("call_id", "model") if key in chunk}}
        return {"type": kind, **({"message": str(chunk.get("message", ""))} if kind == "error" else {})}
    return None


def checked_root(job):
    root = Path(job["stateRoot"]).resolve(strict=True)
    for name, child in (("OCTOP_HOME", "octop"), ("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache")):
        if Path(os.environ.get(name, "")).resolve() != root / child:
            raise RuntimeError("Owned Octop root/environment mismatch")
    if any(os.environ.get(name) for name in FORBIDDEN_ENV) or any(name.startswith("HARNESS_PROVIDER_") for name in os.environ):
        raise RuntimeError("Unexpected provider/search environment in isolated Octop process")
    if Path.cwd().resolve() != root:
        raise RuntimeError("Owned Octop working directory mismatch")
    return root


def bootstrap(job, root):
    import octop
    from octop.config import load_config
    from octop.infra.db.factory import open_database
    from octop.infra.db.migrate import run_migrations
    from octop.infra.db.repos.providers import ProviderRepo
    from octop.infra.db.repos.users import UserRepo
    from octop.infra.utils.paths import PathLayout
    import yaml

    source = Path(job["octopRoot"]).resolve(strict=True)
    if not Path(octop.__file__).resolve().is_relative_to(source / "src"):
        raise RuntimeError("Selected Python does not import the declared Octop checkout")
    if importlib.metadata.version("octop-harness") != "1.0.4":
        raise RuntimeError("UNMET_PREREQUISITE: adapter requires reviewed octop-harness 1.0.4")
    paths = PathLayout.from_env()
    if paths.root.resolve() != root / "octop":
        raise RuntimeError("Octop native root escaped owned state")
    paths.ensure_root()
    plugins = {}
    for manifest in (Path(octop.__file__).parent / "infra/agents/plugins/bundled").glob("*/plugin.yaml"):
        plugins[str(yaml.safe_load(manifest.read_text())["id"])] = {"enabled": False}
    paths.config.write_text(json.dumps({"database": {"driver": "sqlite", "sqlite_path": str(paths.db)}, "plugins": plugins,
        "capabilities": {"mobile": {"enabled": False, "backend": "none", "probed_at": "owned-fixture", "reason": "research ceiling"}}, "log_level": "error"}))
    (paths.root / ".env").write_text("# Owned research baseline; no external provider/search settings.\n")
    db = open_database(load_config(paths.config), paths)
    try:
        run_migrations(db)
        uid = UserRepo(db).create(username="research-owner", role="admin", password_hash=None)
        ProviderRepo(db).create(name=job["provider"], kind=job["protocol"], base_url=job["endpoint"], api_key=job["forwardToken"],
            models_json=json.dumps([{"id": job["model"], "context_window": job["contextWindow"], "max_input_tokens": job["contextWindow"], "max_output_tokens": job["budget"]["outputTokens"]}]))
    finally:
        db.close()
    return uid


def runtime_fingerprint():
    import octop_harness
    package = Path(octop_harness.__file__).parent.resolve()
    digest = hashlib.sha256()
    for source in sorted(package.rglob("*")):
        if source.suffix not in {".py", ".md"} or not source.is_file():
            continue
        if source.is_symlink() or not source.resolve().is_relative_to(package):
            raise RuntimeError("Unexpected link in reviewed harness source")
        digest.update(str(source.relative_to(package)).encode())
        digest.update(source.read_bytes())
    return digest.hexdigest()


async def run(job):
    root = checked_root(job)
    runtime_hash = runtime_fingerprint()
    if job.get("expectedRuntimeFingerprint") and runtime_hash != job["expectedRuntimeFingerprint"]:
        raise RuntimeError("Installed harness source changed during the evaluation")
    uid = bootstrap(job, root)
    from octop.cli.repl.embedded_session import embedded_runtime
    from octop.cli.repl.runtime import CliChatSession
    from octop.infra.agents.manager import AgentCreateSpec
    from octop.infra.agents.settings.tool_catalog import BUILTIN_TOOL_CATALOG
    from octop.infra.gateway.cli.turn import prepare_cli_turn

    async def initialize(_row, workspace):
        workspace.write_text(workspace.resolve_path(None, default=".bootstrapped"), "", force=True)

    async with embedded_runtime() as server:
        registry = server.app_runtime.agent_registry
        row = await registry.create(AgentCreateSpec(name="isolated-research", user_id=uid,
            default_model=f'{job["provider"]}/{job["model"]}',
            runtime_config={"max_tokens": job["budget"]["outputTokens"]},
            config={"memory": {"memory_enabled": False}, "plugins": {}}), workspace_initializer=initialize)
        agent = registry.get_agent(row.agent_id)
        if agent.config.web_search_tools != "auto":
            raise RuntimeError("Octop default auto search policy changed")
        # The public harness setter can hide filesystem/orchestration tools too.
        # The forwarding lease independently rejects any unexpected model tool.
        disabled = {entry.name for entry in BUILTIN_TOOL_CATALOG} - ALLOWED_TOOLS
        disabled.update({"tool_search", "web_search", "list_files"})
        # graph is the harness's documented public escape hatch. Pinning the
        # installed version lets us include every real registered tool name.
        tool_node = agent.graph.nodes.get("tools")
        registered = getattr(getattr(tool_node, "bound", None), "tools_by_name", {})
        if not isinstance(registered, dict) or not ALLOWED_TOOLS.issubset(registered):
            raise RuntimeError("Reviewed native tool execution registry unavailable")
        disabled.update(set(registered) - ALLOWED_TOOLS)
        agent.set_tools_disabled(disabled)
        # Hiding schemas alone does not revoke execution. Reduce this owned
        # graph's actual dispatch map as well; native SearchFree/Fetch stay intact.
        for name in list(registered):
            if name not in ALLOWED_TOOLS:
                del registered[name]
        agent.set_skills_disabled({str(skill.get("name") or skill.get("slug")) for skill in await agent.list_skill_summaries()})
        emit({"type": "ready", "octopVersion": importlib.metadata.version("octop"), "harnessVersion": importlib.metadata.version("octop-harness"),
              "sourceIdentity": job["sourceIdentity"], "runtimeFingerprint": runtime_hash,
              "bootstrap": "owned initialized marker, no onboarding model turn", "searchPolicy": "auto", "researchToolCeiling": sorted(ALLOWED_TOOLS),
              "credential": "owned model-forward lease only", "memory": "disabled common isolated evaluation", "stateRoot": str(root)})
        if job.get("mode") == "probe":
            from langchain_core.messages import AIMessage, ToolMessage
            from langgraph.graph import END, START, MessagesState, StateGraph
            (root / "home" / "owned-home-probe.txt").write_text("owned")
            dispatch = StateGraph(MessagesState)
            dispatch.add_node("tools", tool_node.bound)
            dispatch.add_edge(START, "tools")
            dispatch.add_edge("tools", END)
            denied = await dispatch.compile().ainvoke({"messages": [AIMessage(content="", tool_calls=[{"id": "owned-denied-delete", "name": "delete", "args": {"file_path": str(root / "home" / "owned-home-probe.txt")}, "type": "tool_call"}])]})
            denied_messages = denied.get("messages", [])
            if not denied_messages or not (root / "home" / "owned-home-probe.txt").exists():
                raise RuntimeError("Readonly native dispatch probe did not preserve owned file")
            projected = public_chunk({"type": "tool_result", "messages": [ToolMessage(content="Owned fixture body; published 2026-01-02", tool_call_id="owned-fixture", name="web_fetch")]})
            emit({"type": "probe", "nativeRoot": str(server.paths.root), "home": str(Path.home()), "modelTurns": 0,
                  "projectionFixture": projected, "reasoningExcluded": public_chunk({"type": "reasoning", "content": "not retained"}) is None,
                  "dispatchDeniedFixture": public_chunk({"type": "tool_result", "messages": denied_messages})})
            return
        session = CliChatSession(server, user_id=uid)
        try:
            for repeat in range(job["budget"]["repeats"]):
                thread, session_key = await prepare_cli_turn(server.app_runtime.gateway.thread_registry,
                    agent_id=row.agent_id, user_id=uid, thread_id=None, session_key=f'quality-{job["taskId"]}-{repeat}')
                started = time.monotonic()
                search_calls, fetch_calls = set(), set()
                cancelled = False
                emit({"type": "sample_begin", "repeat": repeat, "threadId": thread})

                def on_chunk(chunk):
                    nonlocal cancelled
                    frame = public_chunk(chunk)
                    if frame is None:
                        return
                    frame.update({"repeat": repeat, "threadId": thread, "atMs": int((time.monotonic() - started) * 1000)})
                    emit(frame)
                    if frame["type"] in {"tool_call_chunk", "tool_start"}:
                        call = frame.get("id") or frame.get("call_id") or str(frame.get("index", 0))
                        if frame.get("name") == "searchfree_search":
                            search_calls.add(call)
                        elif frame.get("name") == "web_fetch":
                            fetch_calls.add(call)
                        elif frame.get("name"):
                            cancelled = True
                        if len(search_calls) > job["budget"]["maxSearchCalls"] or len(fetch_calls) > job["budget"]["maxFetchCalls"]:
                            cancelled = True
                        if cancelled:
                            registry.cancel_stream(row.agent_id, thread)

                try:
                    async with asyncio.timeout(job["budget"]["caseWallMs"] / 1000):
                        await session.run_turn(row.agent_id, job["query"], session_key=session_key, thread_id=thread,
                            model=f'{job["provider"]}/{job["model"]}', conversation_mode=None, on_chunk=on_chunk)
                except TimeoutError:
                    cancelled = True
                    registry.cancel_stream(row.agent_id, thread)
                    emit({"type": "budget", "reason": "case_wall_limit", "repeat": repeat, "threadId": thread})
                except asyncio.CancelledError:
                    registry.cancel_stream(row.agent_id, thread)
                    raise
                finally:
                    if cancelled:
                        registry.cancel_stream(row.agent_id, thread)
                emit({"type": "sample_end", "repeat": repeat, "threadId": thread, "interrupted": cancelled,
                    "elapsedMs": int((time.monotonic() - started) * 1000), "temperature": "process_cold" if repeat == 0 else "process_warm"})
        finally:
            session.close()


async def main(job):
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    await run(job)


if __name__ == "__main__":
    try:
        asyncio.run(main(json.loads(Path(sys.argv[1]).read_text())))
    except asyncio.CancelledError:
        emit({"type": "adapter_cancelled"})
        sys.exit(1)
    except Exception as error:
        # SDK errors can contain headers or request data. Keep only the class.
        emit({"type": "adapter_error", "errorClass": type(error).__name__})
        sys.exit(1)
