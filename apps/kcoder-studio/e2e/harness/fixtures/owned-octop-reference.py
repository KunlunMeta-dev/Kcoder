"""An isolated source reference whose lifetime belongs to its SSH stdin owner."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import subprocess
import hashlib


def remove_owned_root(root, identity):
    current = root.lstat()
    if root.is_symlink() or (current.st_dev, current.st_ino, current.st_uid) != identity:
        raise RuntimeError("reference root identity changed")
    shutil.rmtree(root)


async def main():
    root = Path(tempfile.mkdtemp(prefix="kcoder-octop-reference-"))
    info = root.lstat()
    identity = (info.st_dev, info.st_ino, info.st_uid)
    os.environ["OCTOP_HOME"] = str(root)
    (root / "config.json").write_text(json.dumps({
        "require_setup_password": False,
        "database": {"driver": "sqlite", "sqlite_path": str(root / "octop.db")},
        "bind_host": "127.0.0.1", "enable_dashboard": True,
    }))
    srv = None
    web = None
    task = None
    try:
        import uvicorn
        from octop.infra.server import OctopServer
        from octop.api.app import build_app
        srv = OctopServer()
        await srv.start()
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        web = uvicorn.Server(uvicorn.Config(build_app(srv), log_level="error"))
        task = asyncio.create_task(web.serve(sockets=[listener]))
        while not web.started:
            if task.done():
                await task
                raise RuntimeError("reference exited before ready")
            await asyncio.sleep(0.05)
        source_root = Path('/data/nvme2/cyx/Octop')
        revision = subprocess.check_output(['git', '-c', 'safe.directory='+str(source_root), '-C', str(source_root), 'rev-parse', 'HEAD'], text=True).strip()
        index_sha = hashlib.sha256((source_root/'src/octop/dashboard/index.html').read_bytes()).hexdigest()
        print(json.dumps({"ready": True, "port": listener.getsockname()[1], "root": str(root), "revision": revision, "indexSha256": index_sha}), flush=True)
        await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline)
    finally:
        if web is not None:
            web.should_exit = True
        if task is not None:
            await asyncio.wait_for(task, 15)
        if srv is not None:
            await srv.stop()
        remove_owned_root(root, identity)
        print(json.dumps({"cleaned": True}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
