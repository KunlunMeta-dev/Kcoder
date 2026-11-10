"""Original worker directory handles for organization budget scope; no body reads."""
import hashlib
import os
from pathlib import Path
import stat

from studio_account_files import AccountError
from studio_account_runtime import validate_binding


class WorkspaceBudgetBinding:
    def __init__(self, binding, identity, workspace):
        validate_binding(binding, identity["id"])
        self.uid, self.principal = binding["uid"], identity["id"]
        self.paths = [Path(binding["home"]) / ".config/kcoder", Path(workspace)]
        self.handles, self.identities = [], []
        try:
            for path in self.paths:
                descriptor = self._open(path)
                info = os.fstat(descriptor)
                self.handles.append(descriptor)
                self.identities.append((info.st_dev, info.st_ino))
            profile, working = ["unix:%s:%s" % item for item in self.identities]
            raw = b"kcoder-native-integrations-v1\0native-workspace\0" + (profile + "\0" + working).encode()
            self.resource_id = "native-" + hashlib.sha256(raw).hexdigest()
        except BaseException:
            self.close()
            raise

    def _open(self, path):
        if not path.is_absolute() or ".." in path.parts:
            raise AccountError("Exact absolute workspace required")
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            for part in path.parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
                info = os.fstat(descriptor)
                if info.st_uid not in {0, self.uid} or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                    raise AccountError("Untrusted workspace ancestor")
            info = os.fstat(descriptor)
            if info.st_uid != self.uid or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
                raise AccountError("Private worker directory required")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def verify(self, identity):
        if identity["id"] != self.principal:
            raise AccountError("Organization workspace owner changed")
        for path, original, held in zip(self.paths, self.identities, self.handles):
            descriptor = self._open(path)
            try:
                info, anchor = os.fstat(descriptor), os.fstat(held)
                if original != (info.st_dev, info.st_ino) or original != (anchor.st_dev, anchor.st_ino):
                    raise AccountError("Organization workspace directory changed")
            finally:
                os.close(descriptor)
        return self.resource_id

    def close(self):
        for descriptor in self.handles:
            os.close(descriptor)
        self.handles = []
