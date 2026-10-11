import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  stat,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { copyVerifiedSnapshot } from "../../harness/frozen-copy.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { createRedactingStream, repoRoot, RunContext, runE2E, waitFor } from "../../harness/run-context.mjs";
import { staticTreeContentProjection } from "./public-static-tree-projection.mjs";
import { allocateRecoveryStepBudget } from "./public-recovery-budget.mjs";
import { remoteRecoveryTransactionPython } from "./public-recovery-transaction-agent.mjs";

const localRenameat2ProbeOnly = process.env.KCODER_E2E_PUBLIC_NO_RELOAD_LOCAL_RENAMEAT2_PROBE === "1";
const readOnlyPreflightOnly = process.env.KCODER_E2E_PUBLIC_NO_RELOAD_PREFLIGHT_ONLY === "1";
const enabled = process.env.KCODER_E2E_PUBLIC_NO_RELOAD_SETUP === "1";
assert.ok(enabled || localRenameat2ProbeOnly || readOnlyPreflightOnly,
  "Set the reviewed public setup flag, isolated local renameat2 probe flag, or read-only preflight flag");
assert.equal(process.version, "v22.17.0", "the public setup and UI child use the pinned Node 22.17.0 runtime");

const cloudHost = "aliyun";
const publicOrigin = "https://hyf2333.top";
const expectedSidecarPid = 255620;
const sidecarConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const expectedSidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const expectedStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const expectedRemoteForwardPort = 32552;
const forbiddenProductionRelayPort = 8451;

const workspaceRoot = resolve(repoRoot, "../..");
const oldPublicFixtureRoot = resolve(
  workspaceRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state",
);
const frozenGatewayCandidateRoot = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/public-no-reload-gateway-relay-532138ad-20261008",
);
const expectedGatewaySourceCommit = "532138adad9e8025538b08aa7e1fad43220c5b2e";
const expectedGatewayCandidateDigest = "6c31971e988e2ca458729c4f7d0c944b1e9ec041f9596fa144eed2fcdbedb316";
const expectedGatewayCandidateFiles = 87;
const expectedGatewayGitSourceFiles = 68;
const expectedGatewayMetadataSha256 = "1aa15d354101bd63e3c3d56815e0fffa73bb2b4b788b76bc08e4eba7eb09806f";
const expectedGatewayInitialMetadataSha256 = "7be390b71ada1711c2924fde6e08d64fe2d45940fa5e7f8d2d57d4cdd174693c";
const expectedGatewayPreCountMetadataSha256 = "25e8eafe993fa4edded69abc176a1f41f2b5e516d7a32c0a7e8e709056d5879e";
const expectedGatewayManifestSha256 = "6c31971e988e2ca458729c4f7d0c944b1e9ec041f9596fa144eed2fcdbedb316";
const expectedGatewayGitObjectsSha256 = "0e256eba61261f6230c4f4b69f5d4eececb9b0fdc252830bcf6f32542af00d21";
const expectedGatewayRuntimeInputsSha256 = "222b9ad8ed9c7062ba3bc2643b11e7d06d9dd402d81f153830e10e87cf9aaade";
const expectedGatewayGitSourceTreeSha256 = "a9b9b60b1c3bcd886736229e345bf9ea798c059103bb8a6e7f1977f9322c216a";
const expectedGatewayStudioPackageSha256 = "116ab8872d97c3d8125f9844c8b3557ecd32e1b1d4092d55567d66156fea8cd3";
const expectedGatewayRelayPackageSha256 = "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb";
const expectedGatewayNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const pinnedGatewayNodeExecutable = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";

const privateWebRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
const mobileBundleRoot = resolve(privateWebRoot, "mobile-web-export-after-f643bc69-20261008");
const mobileBundleManifestPath = resolve(privateWebRoot, "mobile-web-export-after-f643bc69-20261008-manifest.json");
const mobileCandidateMetadataPath = resolve(privateWebRoot, "mobile-web-export-after-f643bc69-20261008-candidate-metadata.json");
const expectedMobileSourceDigest = "1c01f1b6ca6d3eebedb9146ceb3ed38811d5c22e5d48b9ea9ce9c1b497ec43ff";
const expectedMobileSourceTreeSha256 = "860c896d7a20022b5335fa80782ef235fff55bc2121b25390bdb1fdb7ae09956";
const expectedMobileBundleSha256 = "217a045ecae2f5bc7712455ec198e6546e2a9d1ca4265da8b836877a0323c03c";
const expectedMobileManifestSha256 = "fbe0181a60e42f7ef87f8f9cbac356b88776e416e3d9de9e886a9a1dad52d0b3";
const expectedMobileCandidateMetadataSha256 = "19774cb10c6f0bb3bb85d2c2b93ebc0345bc3e1b22a7234616144935467b0688";
const expectedMobileCandidateManifestSha256 = "0de09424e70fcdf52272d99cd5e90719451f43f0f0cf077b8bcb9782b288a12f";

const pinnedStudioDependencyRoot = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/render-profile-gateway-runtime-3151f17f-20261008/node_modules",
);
const pinnedStudioRuntimeFreezePath = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/render-profile-gateway-runtime-3151f17f-20261008/gateway-runtime-freeze.json",
);
const pinnedStudioRuntimeRelocationPath = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/render-profile-gateway-runtime-3151f17f-20261008.relocation.json",
);
const expectedStudioDependencyTreeSha256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const expectedStudioDependencyManifestSha256 = "f026430f4b28b9da31f33140ec5892bcf19f54ada97f77744ed6f0144a6b06eb";
const expectedStudioDependencyRelocationSha256 = "920fa9ad8eba197f876dc037d003ff9d7721eca9f2b45f2cfc4f2680fb9766b7";
const expectedStudioRuntimeSourceTreeSha256 = "d16bfd1ebb61e516e418e67d0a982860e6980fca4fa9df900fefcb71db9fa135";
const expectedRelayWsPackageSha256 = "384cc85faaca8864920c384d14037ba8dfe0e956356b0d1ddfbfcbbfc27086dc";
const expectedRelayWsPackageFiles = 19;
const expectedRelayWsPackageVersion = "8.22.0";

const renameat2PythonExchange = String.raw`
AT_FDCWD = -100
RENAME_EXCHANGE = 2

def exchange(left, right):
    if left == right or os.path.dirname(left) != os.path.dirname(right):
        raise RuntimeError("exchange-paths-not-siblings")
    for path in (left, right):
        if os.path.islink(path) or os.path.realpath(path) != path or not os.path.isdir(path):
            raise RuntimeError("exchange-path-not-real-directory")
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    result = fn(AT_FDCWD, os.fsencode(left), AT_FDCWD, os.fsencode(right), RENAME_EXCHANGE)
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
`;

const localRenameat2ProbePython = String.raw`
import ctypes, json, os, sys, tempfile

${renameat2PythonExchange}

with open(sys.argv[2], "r", encoding="utf-8") as handle:
    compile(handle.read(), "<remote-no-reload-agent>", "exec")

def marker(path):
    with open(os.path.join(path, ".owner"), "r", encoding="utf-8") as handle:
        return handle.read()

scratch = sys.argv[1]
if os.path.islink(scratch) or os.path.realpath(scratch) != scratch or not os.path.isdir(scratch):
    raise RuntimeError("probe-scratch-not-real-directory")
with tempfile.TemporaryDirectory(prefix="renameat2-probe-", dir=scratch) as root:
    left = os.path.join(root, "left")
    right = os.path.join(root, "right")
    os.mkdir(left, 0o700)
    os.mkdir(right, 0o700)
    with open(os.path.join(left, ".owner"), "x", encoding="utf-8") as handle:
        handle.write("left")
    with open(os.path.join(right, ".owner"), "x", encoding="utf-8") as handle:
        handle.write("right")
    exchange(left, right)
    if marker(left) != "right" or marker(right) != "left":
        raise RuntimeError("first-exchange-did-not-reverse-markers")
    exchange(left, right)
    if marker(left) != "left" or marker(right) != "right":
        raise RuntimeError("second-exchange-did-not-restore-markers")
    print(json.dumps({
        "remoteAgentSyntaxCompiled": True,
        "firstExchangeReversed": True,
        "secondExchangeRestored": True,
    }, separators=(",", ":")))
`;

const remotePython = String.raw`
import ctypes, hashlib, json, os, re, shutil, stat, subprocess, sys, time

SIDECAR_PID = 255620
SIDECAR_CONFIG = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile"
SIDECAR_SHA256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c"
STATIC_ROOT = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root"
REMOTE_PARENT = "/tmp/kc-phone-ux-443-20261007-183008"
REMOTE_PORT = 32552
${renameat2PythonExchange}

def digest_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def process_info(pid):
    p = subprocess.run(["sudo", "-n", "ps", "-p", str(pid), "-o", "pid=,ppid=,euid=,comm=,args="], capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout.strip():
        return None
    fields = p.stdout.strip().split(None, 4)
    if len(fields) < 5:
        return {"rawFieldCount": len(fields)}
    argv = fields[4]
    return {
        "pid": int(fields[0]), "ppid": int(fields[1]), "euid": int(fields[2]),
        "comm": fields[3], "argvSha256": hashlib.sha256(argv.encode()).hexdigest(),
        "argvMatchesSidecar": argv == "/usr/bin/caddy run --config " + SIDECAR_CONFIG + " --adapter caddyfile",
    }

def listener_rows(port):
    p = subprocess.run(["sudo", "-n", "ss", "-H", "-ltnp", "sport = :" + str(port)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("sudo-ss-failed")
    rows = []
    for line in p.stdout.splitlines():
        row = {"lineSha256": hashlib.sha256(line.encode()).hexdigest()}
        pid_match = __import__("re").search(r"pid=(\d+)", line)
        if pid_match:
            info = process_info(int(pid_match.group(1)))
            row["owner"] = info
        rows.append(row)
    return rows

def route_block_for_id(text, gateway_id):
    escaped = re.escape(gateway_id)
    matcher_re = re.compile(
        r"^[ \t]*@([A-Za-z0-9_-]+)[ \t]+path[ \t]+/g/" + escaped
        + r"[ \t]+/g/" + escaped + r"/\*[ \t]*$",
        re.MULTILINE,
    )
    matchers = list(matcher_re.finditer(text))
    if len(matchers) != 1:
        return None
    matcher_name = matchers[0].group(1)
    handle_re = re.compile(r"^[ \t]*handle[ \t]+@" + re.escape(matcher_name) + r"[ \t]*\{", re.MULTILINE)
    handle = handle_re.search(text, matchers[0].end())
    if handle is None:
        return None
    depth = 0
    block_lines = []
    for line in text[handle.start():].splitlines():
        block_lines.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0:
            return "\n".join(block_lines)
    return None

def route_matches(text, ids):
    route_specs = []
    for line in text.splitlines():
        matcher = re.match(r"^[ \t]*@[A-Za-z0-9_-]+[ \t]+path[ \t]+(/g/.*?)[ \t]*$", line)
        if matcher:
            route_specs.append(matcher.group(1))
    expected = sorted(["/g/*"] + [f"/g/{ids[name]} /g/{ids[name]}/*" for name in ("alpha", "beta")])
    if sorted(route_specs) != expected:
        return {name: False for name in ("alpha", "beta")}
    result = {}
    for name in ("alpha", "beta"):
        block = route_block_for_id(text, ids[name])
        result[name] = bool(
            block
            and re.search(r"\breverse_proxy[ \t]+127\.0\.0\.1:32552\b", block)
            and re.search(r"\bflush_interval[ \t]+-1\b", block)
        )
    return result

def port_status(port):
    if int(port) != REMOTE_PORT:
        raise RuntimeError("port-status-outside-approved-remote-forward")
    listeners = listener_rows(REMOTE_PORT)
    owner = listeners[0].get("owner") if len(listeners) == 1 else None
    return {
        "free": len(listeners) == 0,
        "listeners": listeners,
        "ownerPid": owner.get("pid") if owner else None,
        "ownerComm": owner.get("comm") if owner else None,
        "ownerEuid": owner.get("euid") if owner else None,
        "ownerArgvSha256": owner.get("argvSha256") if owner else None,
    }

def tree(root):
    if not os.path.lexists(root):
        return None
    if os.path.islink(root) or os.path.realpath(root) != root or not os.path.isdir(root):
        raise RuntimeError("tree-root-not-owned-real-directory")
    directories = []
    files = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        dirnames.sort()
        filenames.sort()
        for name in list(dirnames):
            path = os.path.join(current, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("symlink-or-nondirectory-in-static-root")
            directories.append(stat_row(root, path, info))
        for name in filenames:
            path = os.path.join(current, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise RuntimeError("symlink-or-nonfile-in-static-root")
            row = stat_row(root, path, info)
            row["sha256"] = digest_file(path)
            files.append(row)
    root_info = os.lstat(root)
    return {
        "root": stat_row(os.path.dirname(root), root, root_info),
        "directories": sorted(directories, key=lambda x: x["path"]),
        "files": sorted(files, key=lambda x: x["path"]),
    }

def stat_row(root, path, info):
    return {
        "path": os.path.relpath(path, root).replace(os.sep, "/"),
        "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid,
        "dev": info.st_dev, "inode": info.st_ino, "size": info.st_size,
        "mtimeNs": str(info.st_mtime_ns), "ctimeNs": str(info.st_ctime_ns),
    }

def below_parent(path):
    return os.path.dirname(path) == REMOTE_PARENT and os.path.basename(path).startswith("mobile-web-root.")

def read_owner_marker(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError("owner-marker-not-regular-file")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()

${remoteRecoveryTransactionPython}

def main(request):
    action = request.get("action")
    if action == "restore-owned-static-transaction":
        return run_recovery_transaction(request, main)
    if action == "preflight":
        caddy_info = process_info(SIDECAR_PID)
        caddy_listeners = listener_rows(443)
        config = open(SIDECAR_CONFIG, "rb").read()
        config_sha = hashlib.sha256(config).hexdigest()
        text = config.decode("utf-8")
        routes = route_matches(text, request["ids"])
        catchall = re.search(r"^[ \t]*@test_gateway_prefix[ \t]+path[ \t]+/g/\*[ \t]*$", text, re.MULTILINE)
        catchall_handle = None
        if catchall:
            catchall_handle = re.search(r"^[ \t]*handle[ \t]+@test_gateway_prefix[ \t]*\{", text, re.MULTILINE)
        catchall_block = ""
        if catchall_handle:
            depth = 0
            block_lines = []
            for line in text[catchall_handle.start():].splitlines():
                block_lines.append(line)
                depth += line.count("{") - line.count("}")
                if depth == 0:
                    break
            catchall_block = "\n".join(block_lines)
        forward_listeners = listener_rows(REMOTE_PORT)
        return {
            "caddy": caddy_info, "caddyListeners": caddy_listeners,
            "configSha256": config_sha, "configHashMatches": config_sha == SIDECAR_SHA256,
            "staticRootMatches": "\troot * " + STATIC_ROOT in text,
            "routesMatch": routes,
            "catchall404Matches": bool(catchall and catchall_handle and re.search(r"\brespond[ \t]+404\b", catchall_block)),
            "staticRootTree": tree(STATIC_ROOT),
            "remoteForwardPort": REMOTE_PORT, "remoteForwardListeners": forward_listeners,
            "remoteForwardFree": len(forward_listeners) == 0,
        }
    if action == "port-status":
        return port_status(request["port"])
    if action == "manifest":
        path = request["path"]
        if not (path == STATIC_ROOT or below_parent(path)):
            raise RuntimeError("manifest-path-outside-approved-static-root")
        return {"tree": tree(path)}
    if action == "exchange":
        left, right = request["left"], request["right"]
        if not (left == STATIC_ROOT or below_parent(left)) or not (right == STATIC_ROOT or below_parent(right)):
            raise RuntimeError("exchange-path-outside-approved-static-root")
        exchange(left, right)
        return {"exchanged": True}
    if action == "probe-exchange":
        left, right = request["left"], request["right"]
        if not below_parent(left) or not below_parent(right) or os.path.lexists(left) or os.path.lexists(right):
            raise RuntimeError("exchange-probe-path-invalid-or-exists")
        created = []
        try:
            os.mkdir(left, 0o700)
            created.append(left)
            with open(os.path.join(left, ".owner"), "x", encoding="utf-8") as handle:
                handle.write(request["owner"] + ":left")
            os.mkdir(right, 0o700)
            created.append(right)
            with open(os.path.join(right, ".owner"), "x", encoding="utf-8") as handle:
                handle.write(request["owner"] + ":right")
            exchange(left, right)
            left_after_first = read_owner_marker(os.path.join(left, ".owner"))
            right_after_first = read_owner_marker(os.path.join(right, ".owner"))
            if left_after_first != request["owner"] + ":right":
                raise RuntimeError("exchange-probe-first-direction-failed")
            if right_after_first != request["owner"] + ":left":
                raise RuntimeError("exchange-probe-first-direction-failed")
            exchange(left, right)
            left_after_second = read_owner_marker(os.path.join(left, ".owner"))
            right_after_second = read_owner_marker(os.path.join(right, ".owner"))
            if left_after_second != request["owner"] + ":left":
                raise RuntimeError("exchange-probe-second-direction-failed")
            if right_after_second != request["owner"] + ":right":
                raise RuntimeError("exchange-probe-second-direction-failed")
            return {
                "firstExchangeReversed": True,
                "secondExchangeRestored": True,
                "ownerMarkerVerifiedBeforeCleanup": True,
            }
        finally:
            observed = []
            for path in created:
                if os.path.islink(path) or os.path.realpath(path) != path or not os.path.isdir(path):
                    raise RuntimeError("exchange-probe-cleanup-path-no-longer-owned-directory")
                marker_path = os.path.join(path, ".owner")
                observed.append(read_owner_marker(marker_path) if os.path.lexists(marker_path) else None)
            if len(created) == 1:
                if observed == [request["owner"] + ":left"]:
                    shutil.rmtree(created[0])
                elif observed == [None] and not os.listdir(created[0]):
                    os.rmdir(created[0])
                else:
                    raise RuntimeError("exchange-probe-cleanup-owner-marker-mismatch")
            else:
                expected_markers = {request["owner"] + ":left", request["owner"] + ":right"}
                if set(observed) != expected_markers or len(observed) != len(expected_markers):
                    raise RuntimeError("exchange-probe-cleanup-owner-markers-mismatch")
                for path in reversed(created):
                    shutil.rmtree(path)
    if action == "cleanup-probe-exchange":
        owner = request["owner"]
        left = request["left"]
        right = request["right"]
        expected_left = STATIC_ROOT + ".exchange-probe-" + owner + "-a"
        expected_right = STATIC_ROOT + ".exchange-probe-" + owner + "-b"
        if left != expected_left or right != expected_right:
            raise RuntimeError("exchange-probe-cleanup-path-mismatch")
        expected_markers = {owner + ":left", owner + ":right"}
        existing = []
        markers = []
        empty_dirs = []
        for path in (left, right):
            if not os.path.lexists(path):
                continue
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or os.path.realpath(path) != path:
                raise RuntimeError("exchange-probe-cleanup-path-not-owned-directory")
            if stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError("exchange-probe-cleanup-directory-mode-mismatch")
            existing.append(path)
            marker_path = os.path.join(path, ".owner")
            if os.path.lexists(marker_path):
                if set(os.listdir(path)) != {".owner"}:
                    raise RuntimeError("exchange-probe-cleanup-directory-contents-mismatch")
                marker = read_owner_marker(marker_path)
                if marker not in expected_markers:
                    raise RuntimeError("exchange-probe-cleanup-owner-marker-mismatch")
                markers.append(marker)
            elif os.listdir(path):
                raise RuntimeError("exchange-probe-cleanup-unmarked-directory-not-empty")
            else:
                empty_dirs.append(path)
        if len(existing) > 2 or len(set(markers)) != len(markers):
            raise RuntimeError("exchange-probe-cleanup-state-ambiguous")
        if len(existing) == 2:
            if len(markers) == 2 and set(markers) != expected_markers:
                raise RuntimeError("exchange-probe-cleanup-owner-set-mismatch")
            if len(markers) == 1 and len(empty_dirs) == 1:
                pass
            elif len(markers) != 2:
                raise RuntimeError("exchange-probe-cleanup-partial-owner-state")
        elif len(existing) == 1:
            if len(markers) not in (0, 1):
                raise RuntimeError("exchange-probe-cleanup-partial-owner-state")
        elif markers or empty_dirs:
            raise RuntimeError("exchange-probe-cleanup-state-ambiguous")
        for path in reversed(existing):
            shutil.rmtree(path)
        return {"removed": True, "remaining": False}
    if action == "create-stage":
        path = request["path"]
        if not below_parent(path) or os.path.lexists(path):
            raise RuntimeError("stage-path-invalid-or-exists")
        os.mkdir(path, 0o700)
        fd = os.open(os.path.join(path, ".kc-e2e-owner"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(request["owner"])
            f.flush()
            os.fsync(f.fileno())
        return {"created": True}
    if action == "remove-stage":
        path = request["path"]
        if not below_parent(path) or os.path.islink(path) or os.path.realpath(path) != path or not os.path.isdir(path):
            raise RuntimeError("refusing-to-remove-nonowned-stage-path")
        owner = os.path.join(path, ".kc-e2e-owner")
        if os.path.isfile(owner) and not os.path.islink(owner) and read_owner_marker(owner) == request["owner"]:
            shutil.rmtree(path)
            return {"removed": True, "by": "owner-marker"}
        expected = request.get("expectedFiles")
        current = tree(path)
        projection = [{k: f[k] for k in ("path", "size", "sha256")} for f in current["files"]]
        if expected is not None and projection == expected:
            shutil.rmtree(path)
            return {"removed": True, "by": "verified-bundle-manifest"}
        raise RuntimeError("stage-owner-or-bundle-manifest-mismatch")
    if action == "remove-owner-marker":
        path = request["path"]
        if not below_parent(path) or os.path.islink(path) or os.path.realpath(path) != path or not os.path.isdir(path):
            raise RuntimeError("stage-path-invalid")
        owner = os.path.join(path, ".kc-e2e-owner")
        if os.path.islink(owner) or read_owner_marker(owner) != request["owner"]:
            raise RuntimeError("stage-owner-marker-mismatch")
        os.unlink(owner)
        return {"removed": True}
    raise RuntimeError("unknown-action")

try:
    result = main(json.loads(sys.stdin.read()))
    print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
except Exception as exc:
    print(json.dumps({"ok": False, "errorType": type(exc).__name__, "error": str(exc)[:240]}, separators=(",", ":")))
    sys.exit(2)
`;

const remoteJsonArtifactOrdinals = new WeakMap();
const knownRemoteActions = new Set([
  "preflight",
  "restore-owned-static-transaction",
  "port-status",
  "manifest",
  "exchange",
  "probe-exchange",
  "cleanup-probe-exchange",
  "create-stage",
  "remove-stage",
  "remove-owner-marker",
]);
const knownRemoteErrorKinds = new Set([
  "AssertionError",
  "FileExistsError",
  "FileNotFoundError",
  "IsADirectoryError",
  "KeyError",
  "NotADirectoryError",
  "OSError",
  "PermissionError",
  "RuntimeError",
  "TimeoutExpired",
  "TimeoutError",
  "TypeError",
  "ValueError",
]);

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-public-no-reload-setup",
  tier: "manual-live",
  modelPolicy: "model-independent; read-only preflight mode only inspects the approved isolated :443 sidecar and loopback forward port, local renameat2 mode uses a temporary directory, and full mode serves frozen Mobile Web without a Provider",
  retainSuccessLogs: true,
  bodyAbortTimeoutMs: 60_000,
  cleanupTimeoutMs: 60_000,
}, async context => {
  assert.equal(await realpath(process.execPath), await realpath(pinnedGatewayNodeExecutable), "the public setup must use the exact pinned Node executable");
  assert.equal(await hashFileSha256(process.execPath), expectedGatewayNodeSha256, "the public setup Node executable bytes changed");
  if (localRenameat2ProbeOnly) return runLocalRenameat2Probe(context);
  const ownerMarker = context.seed;
  const mobile = await verifyMobileExport();
  const gatewaySource = await verifyGatewayCandidateSource();
  const relayInputs = await loadPrivateRelayInputs(context);

  const remotePreflightStartedAt = Date.now();
  const remotePreflight = await remoteJson(context, "no-reload-caddy-preflight", {
    action: "preflight",
    ids: { alpha: relayInputs.fixtures.alpha.id, beta: relayInputs.fixtures.beta.id },
  });
  const remotePreflightElapsedMs = Date.now() - remotePreflightStartedAt;
  if (readOnlyPreflightOnly) {
    await context.writeArtifactJson("public-no-reload-readonly-preflight.json", {
      status: "observed",
      remotePreflightElapsedMs,
      remotePreflightBoundMs: 45_000,
      observation: remotePreflight,
      noRemoteMutationActionsRequested: true,
      noRelayGatewayOrBrowserStarted: true,
      productionRelayPortTouched: false,
      productionRelayPortForbidden: forbiddenProductionRelayPort,
    });
  }
  assert.ok(remotePreflightElapsedMs <= 45_000, "the one-shot remote read-only preflight must finish within 45 seconds");
  const caddy = remotePreflight.caddy;
  assert.equal(caddy?.pid, expectedSidecarPid, "do not reuse a different public :443 Caddy owner");
  assert.equal(caddy?.euid, 0);
  assert.equal(caddy?.comm, "caddy");
  assert.equal(caddy?.argvMatchesSidecar, true, "the verified :443 owner must still use the isolated sidecar file");
  assert.ok(remotePreflight.caddyListeners.length > 0, "the approved isolated sidecar must own at least one :443 listener");
  assert.ok(remotePreflight.caddyListeners.every(row => row.owner?.pid === expectedSidecarPid
    && row.owner?.euid === 0
    && row.owner?.comm === "caddy"
    && row.owner?.argvMatchesSidecar === true), "every observed :443 listener must belong to the exact isolated sidecar process");
  assert.equal(remotePreflight.configSha256, expectedSidecarConfigSha256);
  assert.equal(remotePreflight.configHashMatches, true);
  assert.equal(remotePreflight.staticRootMatches, true);
  assert.equal(remotePreflight.catchall404Matches, true);
  assert.deepEqual(remotePreflight.routesMatch, { alpha: true, beta: true }, "only the two private paired IDs may match existing /g routes");
  if (!remotePreflight.remoteForwardFree) {
    await context.writeArtifactJson("remote-forward-port-32552-occupied.json", {
      port: expectedRemoteForwardPort,
      listeners: remotePreflight.remoteForwardListeners,
      ownerEvidence: remotePreflight.remoteForwardListeners,
      existingReverseMapping: "UNVERIFIED; fail closed and do not reuse or signal the listener",
    });
    throw new Error("remote loopback port 32552 is occupied; its exact existing reverse-forward mapping is not owned by this RunContext");
  }
  if (readOnlyPreflightOnly) {
    return {
      status: "readonly-preflight-passed",
      isolatedSidecarPid: caddy.pid,
      isolatedSidecarConfigSha256: remotePreflight.configSha256,
      caddyListenerCount: remotePreflight.caddyListeners.length,
      remoteLoopbackForwardPort: expectedRemoteForwardPort,
      remoteLoopbackForwardFree: true,
      productionRelayPortTouched: false,
    };
  }
  const originalStaticTree = remotePreflight.staticRootTree;
  assert.ok(originalStaticTree && originalStaticTree.files.length > 0, "existing configured static root must be a real, nonempty directory");
  await context.writeArtifactJson("existing-static-root-manifest.json", originalStaticTree);
  await context.writeArtifactJson("public-no-reload-inputs.json", {
    publicOrigin,
    isolatedSidecarPid: expectedSidecarPid,
    isolatedSidecarConfigSha256: expectedSidecarConfigSha256,
    isolatedStaticRoot: expectedStaticRoot,
    existingExactGatewayRoutes: 2,
    remoteReverseForwardPort: expectedRemoteForwardPort,
    productionRelayPortForbidden: forbiddenProductionRelayPort,
    productionRelayPortTouched: false,
    mobileWeb: mobile,
    gatewayRelayCandidate: gatewaySource,
    sourceSnapshotsVerifiedIndependently: true,
    sourceSetsDisjoint: false,
    sourceScopeNote: "Mobile Web is served only from the separately pinned 312-file candidate/37-file bundle; Gateway/Relay launch code is the separate 68-file Git source closure from commit 532138ad plus a separately identified 19-file ws dependency, with Studio pnpm dependencies pinned independently",
    gatewayRelaySourceCommit: gatewaySource.sourceCommit,
    gatewayRelaySourceDigest: gatewaySource.sourceDigest,
    gatewayRelayGitSourceTreeSha256: gatewaySource.gitSourceTreeSha256,
    gatewayRelayGitSourceFiles: gatewaySource.gitSourceFiles,
    gatewayRelayPinnedWsTreeSha256: gatewaySource.relayWsTreeSha256,
    gatewayRelayPinnedStudioDependencyTreeSha256: gatewaySource.studioDependencyTreeSha256,
    mobileSourceDigest: mobile.sourceDigest,
  });

  const gatewayRuntimeRoot = context.pathInState("gateway-relay-runtime");
  const copiedGatewayCandidate = await copyVerifiedSnapshot({
    sourceRoot: frozenGatewayCandidateRoot,
    destination: gatewayRuntimeRoot,
    expectedDigest: expectedGatewayCandidateDigest,
    expectedCount: expectedGatewayCandidateFiles,
  });
  const gatewayStudioRoot = resolve(gatewayRuntimeRoot, "apps/kcoder-studio");
  const gatewayRelayRoot = resolve(gatewayRuntimeRoot, "apps/kcoder-relay");
  const gatewayNodeModules = resolve(gatewayStudioRoot, "node_modules");
  await symlink(pinnedStudioDependencyRoot, gatewayNodeModules, "dir");
  const relayWsSource = resolve(gatewayRelayRoot, "node_modules/ws");
  const relayWs = await verifyCopiedRelayWs(relayWsSource);
  const pinnedStudioRuntime = await verifyPinnedStudioDependencies();

  const relayModule = await import(pathToFileURL(resolve(gatewayRelayRoot, "src/server.mjs")).href);
  const clientModule = await import(pathToFileURL(resolve(gatewayRelayRoot, "src/client.mjs")).href);
  const identityModule = await import(pathToFileURL(resolve(gatewayRelayRoot, "src/client-identity.mjs")).href);

  const registrationStorePath = context.pathInState("relay-registration-store.json");
  await copyPrivateFile(relayInputs.registrationStorePath, registrationStorePath);
  const relay = await relayModule.startRelay({
    gateways: [],
    sharedHosts: ["hyf2333.top"],
    registrationStoreFile: registrationStorePath,
    controlPort: 0,
    proxyPort: 0,
  });
  context.registerPort("public-no-reload-relay-control", relay.controlPort);
  context.registerPort("public-no-reload-relay-data", relay.proxyPort);
  context.addCleanup("close private in-process Relay and copied registration store", () => relay.close());

  const relayOrigin = `http://127.0.0.1:${relay.controlPort}`;
  const identities = {};
  for (const name of ["alpha", "beta"]) {
    const identityPath = context.pathInState(`relay-client-${name}.json`);
    await copyPrivateFile(relayInputs.identityPaths[name], identityPath);
    await updatePrivateIdentityRelayOrigin(identityPath, relayOrigin, relayInputs.fixtures[name].id);
    const authorized = await identityModule.readRegisteredClientIdentity({
      identityFile: identityPath,
      relayUrl: relayOrigin,
      pairingToken: relayInputs.fixtures[name].pairingToken,
    });
    assert.equal(authorized.id, relayInputs.fixtures[name].id, `${name} identity must match its private pairing fixture`);
    assert.equal(authorized.secret, relayInputs.registeredRecords[name].secret, `${name} identity must match its private registration record`);
    identities[name] = { path: identityPath, id: authorized.id, secret: authorized.secret };
    context.registerSecret(authorized.id);
    context.registerSecret(authorized.secret);
  }

  const workspaces = {};
  const gateways = {};
  const clients = {};
  for (const name of ["alpha", "beta"]) {
    workspaces[name] = (await materializeWorkspace(context, "minimal", { instanceId: `public-no-reload-${name}` })).path;
    const serverId = `public-fixture-${name}`;
    const workspaceLabel = `Public UX fixture ${name}`;
    const serversFile = await context.writeStateJson(`servers-${name}.json`, [{
      id: serverId,
      label: workspaceLabel,
      runtime: "kcoder",
      transport: "local",
      command: process.execPath,
      workspace: workspaces[name],
    }]);
    const serversStore = context.pathInState(`gateway-${name}/servers-store.json`);
    await mkdir(dirname(serversStore), { recursive: true, mode: 0o700 });
    const gateway = await startGateway(context, {
      label: `public-no-reload-gateway-${name}`,
      host: "127.0.0.1",
      auth: false,
      workspace: workspaces[name],
      serversFile,
      serversStore,
      gatewayRoot: gatewayStudioRoot,
      cwd: gatewayStudioRoot,
      env: {
        KCODER_CONFIG_DIR: context.pathInState(`gateway-${name}/config`),
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_PUBLIC_ORIGINS: publicOrigin,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: publicOrigin,
        KCODER_STUDIO_WEB_ROOT: mobileBundleRoot,
      },
    });
    gateways[name] = gateway;
    context.addCleanup(`stop run-owned mock Gateway ${name}`, async () => {
      const record = context.processes.get(`public-no-reload-gateway-${name}`);
      if (record && !record.stopped) await context.stopOwned(`public-no-reload-gateway-${name}`);
    });
  }

  const online = { alpha: false, beta: false };
  for (const name of ["alpha", "beta"]) {
    clients[name] = await clientModule.startRegisteredClient({
      url: relayOrigin,
      identityFile: identities[name].path,
      pairingToken: relayInputs.fixtures[name].pairingToken,
      gateway: gateways[name].baseUrl,
      allowInsecure: true,
      retryMs: 250,
      onOnline: () => { online[name] = true; },
    });
    context.addCleanup(`close run-owned Relay client ${name}`, () => clients[name].close());
  }
  await waitFor(() => online.alpha && online.beta ? true : null, 20_000, "both private Gateway clients online on the copied test Relay", 100, context.abortSignal);

  const remoteProbeLeft = `${expectedStaticRoot}.exchange-probe-${ownerMarker}-a`;
  const remoteProbeRight = `${expectedStaticRoot}.exchange-probe-${ownerMarker}-b`;
  const remoteStageRoot = `${expectedStaticRoot}.stage-${ownerMarker}`;
  let sshForward = null;
  const recoveryContext = await RunContext.create(import.meta.url, {
    testId: "mobile-high-latency-public-no-reload-remote-state-recovery",
    tier: "manual-live",
    modelPolicy: "model-independent; independently owned bounded recovery for this suite's isolated static-root transaction",
    processSignalTimeoutMs: 1_000,
    streamCloseTimeoutMs: 1_000,
    cleanupTimeoutMs: 10_000,
  });
  let expectedReplacementTree = null;
  let remoteStateRestorePromise;
  const remoteStateRestoreOptions = {
    remoteProbeLeft,
    remoteProbeRight,
    remoteStageRoot,
    ownerMarker,
    originalStaticTree,
    expectedBundleFiles: mobile.bundleFiles,
    expectedReplacementTree: () => expectedReplacementTree,
    parentRunRoot: context.runRoot,
    parentContext: context,
    remoteForwardPort: expectedRemoteForwardPort,
    getOwnedForward: () => sshForward,
  };
  const restoreRemoteStateOnce = () => {
    if (!remoteStateRestorePromise) {
      remoteStateRestorePromise = restoreRemoteStateWithDeadline(recoveryContext, remoteStateRestoreOptions, 35_000);
    }
    return remoteStateRestorePromise;
  };
  context.addCleanup("await the single independent remote-state recovery operation", async () => {
    await restoreRemoteStateOnce();
  });
  await context.writeArtifactJson("remote-state-recovery-context.json", {
    recoveryRunRoot: recoveryContext.runRoot,
    owner: "this suite; independent RunContext process registry",
    restoreDeadlineMs: 35_000,
    forwardStopElapsedIsSeparateAndIncludedInDeadline: true,
    recoveryRemoteTransactionMaxMs: 35_000,
    recoveryRemoteTransactionMinimumUsefulMs: 500,
    recoveryRemoteSshInvocationCount: 1,
    recoveryBudgetPlan: [
      { label: "stop-run-owned-reverse-forward", budget: "separately measured; shared parent stop promise; included in the same 35s deadline" },
      { label: "single-remote-owned-state-transaction", timeout: "actual remaining time until the original 35s deadline; no retry" },
    ],
    finalStaticRootVerificationReserved: true,
    insufficientStepBudgetMeans: "UNVERIFIED; skip the single remote transaction and retain failed recovery proof; never infer cleanup from timeout",
    remoteTransactionReceipts: "each internal action has its own bounded status, elapsed time, allowlisted receipt, and error kind",
    postAbortDrainPolicy: "await the shared restore operation after stopping recovery-owned children; timeout remains unverified and does not assert remote resources are clean",
    parentCleanupWaitBoundMs: 60_000,
    exchangeProbeCleanupIncluded: true,
    productionRelayPortTouched: false,
  });

  return await runWithRemoteStateRestoration(context, async () => {
    const probe = await remoteJson(context, "no-reload-renameat2-probe", {
      action: "probe-exchange",
      left: remoteProbeLeft,
      right: remoteProbeRight,
      owner: ownerMarker,
    });
    assert.equal(probe.firstExchangeReversed, true, "the first same-parent RENAME_EXCHANGE must reverse the two markers");
    assert.equal(probe.secondExchangeRestored, true, "the second same-parent RENAME_EXCHANGE must restore the original marker placement");
    assert.equal(probe.ownerMarkerVerifiedBeforeCleanup, true);

    await remoteJson(context, "no-reload-create-owned-static-stage", {
      action: "create-stage", path: remoteStageRoot, owner: ownerMarker,
    });
    const archivePath = context.pathInState("latest-mobile-web-bundle.tar.gz");
    const tar = context.spawnOwned("archive-latest-mobile-web-bundle", "tar", ["-C", mobileBundleRoot, "-czf", archivePath, "."], { cwd: repoRoot });
    await waitForOwnedExit(context, "archive-latest-mobile-web-bundle", tar, 30_000);
    await chmod(archivePath, 0o600);
    await uploadBundleArchive(context, archivePath, remoteStageRoot);
    const stagedTree = (await remoteJson(context, "verify-staged-mobile-web-root", {
      action: "manifest", path: remoteStageRoot,
    })).tree;
    assert.equal(stagedTree.files.some(file => file.path === ".kc-e2e-owner"), true);
    assert.deepEqual(bundleProjection(stagedTree.files.filter(file => file.path !== ".kc-e2e-owner")), mobile.bundleFiles);
    await remoteJson(context, "no-reload-remove-stage-owner-marker", {
      action: "remove-owner-marker", path: remoteStageRoot, owner: ownerMarker,
    });
    const stageBeforeExchange = (await remoteJson(context, "verify-clean-mobile-web-stage", {
      action: "manifest", path: remoteStageRoot,
    })).tree;
    assert.deepEqual(bundleProjection(stageBeforeExchange.files), mobile.bundleFiles);
    expectedReplacementTree = stageBeforeExchange;
    await remoteJson(context, "no-reload-atomic-mobile-root-exchange", {
      action: "exchange", left: expectedStaticRoot, right: remoteStageRoot,
    });
    const servedTree = (await remoteJson(context, "verify-exchanged-static-root", {
      action: "manifest", path: expectedStaticRoot,
    })).tree;
    assert.deepEqual(bundleProjection(servedTree.files), mobile.bundleFiles);
    await context.writeArtifactJson("served-static-root-after-manifest.json", servedTree);

    const fixturePath = context.pathInState("private-mobile-pairing-fixtures.json");
    await context.writeStateJson("private-mobile-pairing-fixtures.json", {
      alpha: {
        id: relayInputs.fixtures.alpha.id,
        pairingToken: relayInputs.fixtures.alpha.pairingToken,
        serverId: "public-fixture-alpha",
        workspaceLabel: "Public UX fixture alpha",
        workspacePath: workspaces.alpha,
      },
      beta: {
        id: relayInputs.fixtures.beta.id,
        pairingToken: relayInputs.fixtures.beta.pairingToken,
        serverId: "public-fixture-beta",
        workspaceLabel: "Public UX fixture beta",
        workspacePath: workspaces.beta,
      },
    });
    await chmod(fixturePath, 0o600);
    for (const fixture of Object.values(relayInputs.fixtures)) {
      context.registerSecret(fixture.id);
      context.registerSecret(fixture.pairingToken);
    }

    sshForward = context.spawnOwned("public-no-reload-ssh-data-forward", "ssh", [
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=2",
      "-R", `127.0.0.1:${expectedRemoteForwardPort}:127.0.0.1:${relay.proxyPort}`,
      cloudHost,
    ], { cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]) });
    context.addCleanup("await shared recovery operation for reverse SSH forward", async () => {
      await restoreRemoteStateOnce();
    });
    const forwardStatus = await waitFor(async () => {
      if (sshForward.exitCode !== null || sshForward.signalCode !== null) throw new Error("run-owned reverse SSH forward exited during startup");
      const status = await remoteJson(context, "no-reload-confirm-owned-remote-forward", { action: "port-status", port: expectedRemoteForwardPort });
      return status.free === false ? status : null;
    }, 20_000, "run-owned cloud loopback reverse-forward listener", 250, context.abortSignal);
    assert.equal(forwardStatus.ownerComm, "sshd");
    assert.equal(forwardStatus.free, false);
    assert.equal(forwardStatus.listeners.length, 1);
    await context.writeArtifactJson("run-owned-reverse-forward.json", {
      ownerLabel: "public-no-reload-ssh-data-forward",
      localOwnerPid: sshForward.pid,
      remoteListenerPid: forwardStatus.ownerPid,
      remoteListenerArgvSha256: forwardStatus.ownerArgvSha256,
      remoteLoopbackPort: expectedRemoteForwardPort,
      localRelayDataPort: relay.proxyPort,
      mappingProof: "the exact -R arguments belong to this RunContext child; remote listener appeared after start",
    });

    const uiEnv = context.isolatedEnvironment({
      KCODER_E2E_PUBLIC_MOBILE_UI: "1",
      KCODER_E2E_CHROMIUM_NO_SANDBOX: "1",
      KCODER_E2E_PUBLIC_UI_ORIGIN: `${publicOrigin}/`,
      KCODER_E2E_PUBLIC_UI_PARENT_RUN_ROOT: context.runRoot,
      KCODER_E2E_PUBLIC_UI_PAIRING_FIXTURES: fixturePath,
      KCODER_E2E_PUBLIC_UI_EXPECTED_SOURCE_DIGEST: mobile.sourceDigest,
      KCODER_E2E_PUBLIC_UI_EXPECTED_BUNDLE_SHA256: mobile.bundleSha256,
      KCODER_E2E_PUBLIC_UI_WEB_MANIFEST: mobileBundleManifestPath,
    });
    const uiChild = context.spawnOwned("latest-mobile-public-ui-child", process.execPath, [
      resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-ui.e2e.mjs"),
    ], { cwd: repoRoot, env: uiEnv });
    const uiOutput = await waitForOwnedExit(context, "latest-mobile-public-ui-child", uiChild, 180_000, { captureStdout: true });
    assert.match(uiOutput, /"stage":"public-mobile-ui-passed"/, "the existing public UI child must report its two-route PASS");
    await context.writeArtifactJson("public-no-reload-setup-result.json", {
      status: "public-ui-child-passed",
      mobileWebSourceDigest: mobile.sourceDigest,
      mobileWebBundleSha256: mobile.bundleSha256,
      gatewayRelaySourceDigest: gatewaySource.sourceDigest,
      gatewayRelayCopiedRuntimeFiles: copiedGatewayCandidate.fileCount,
      gatewayRelaySourceCommit: gatewaySource.sourceCommit,
      gatewayRelayGitSourceFiles: gatewaySource.gitSourceFiles,
      gatewayRelayRelayWsDependencyFiles: relayWs.fileCount,
      studioDependencyTreeSha256: pinnedStudioRuntime.dependencyTreeSha256,
      relayWsPackageSha256: relayWs.treeSha256,
      caddySidecarPid: expectedSidecarPid,
      caddySidecarConfigSha256: expectedSidecarConfigSha256,
      caddyReloadPerformed: false,
      productionRelayPortTouched: false,
      productionRelayPortForbidden: forbiddenProductionRelayPort,
      modelOrProviderCalls: false,
      routes: 2,
    });
    return { status: "public-ui-child-passed", routes: 2, modelOrProviderCalls: false };
  }, restoreRemoteStateOnce);
});

async function verifyMobileExport() {
  const [manifestBytes, metadataBytes, candidateManifestBytes] = await Promise.all([
    readFile(mobileBundleManifestPath),
    readFile(mobileCandidateMetadataPath),
    readFile(resolve(privateWebRoot, "mobile-web-export-after-f643bc69-20261008-candidate-sha256.json")),
  ]);
  assert.equal(sha256(manifestBytes), expectedMobileManifestSha256);
  assert.equal(sha256(metadataBytes), expectedMobileCandidateMetadataSha256);
  assert.equal(sha256(candidateManifestBytes), expectedMobileCandidateManifestSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.bundleSha256, expectedMobileBundleSha256);
  assert.equal(manifest.bundleFileCount, 37);
  assert.equal(manifest.sourceTreeSha256, expectedMobileSourceTreeSha256);
  assert.equal(metadata.status, "source-frozen-static");
  assert.equal(metadata.sourceDigest, expectedMobileSourceDigest);
  assert.equal(metadata.sourceFiles, 312);
  assert.equal(metadata.sourceRoots.find(root => root.name === "mobile")?.fileCount, 293);
  assert.equal(metadata.sourceRoots.find(root => root.name === "studio-shared")?.fileCount, 19);
  const files = await collectLocalRegularFiles(mobileBundleRoot);
  assert.deepEqual(files, manifest.bundleFiles);
  assert.equal(hashJson(files), manifest.bundleSha256);
  return {
    sourceDigest: metadata.sourceDigest,
    sourceTreeSha256: manifest.sourceTreeSha256,
    sourceFiles: metadata.sourceFiles,
    bundleSha256: manifest.bundleSha256,
    bundleFileCount: manifest.bundleFileCount,
    bundleFiles: manifest.bundleFiles,
    manifestPath: mobileBundleManifestPath,
    manifestSha256: sha256(manifestBytes),
  };
}

async function verifyGatewayCandidateSource() {
  const privateRoot = await realpath(privateWebRoot);
  const candidateRoot = await realpath(frozenGatewayCandidateRoot);
  assert.equal(candidateRoot, frozenGatewayCandidateRoot, "frozen Gateway/Relay input root must not resolve through a symlink");
  const candidateRelative = relative(privateRoot, candidateRoot);
  assert.ok(candidateRelative && candidateRelative !== ".." && !candidateRelative.startsWith(`..${sep}`) && !isAbsolute(candidateRelative), "frozen Gateway/Relay input must stay under the integration private root");
  const [metadataBytes, manifestBytes, gitObjectsBytes, runtimeInputsBytes, initialMetadataBytes, preCountMetadataBytes] = await Promise.all([
    readFile(resolve(candidateRoot, "metadata.json")),
    readFile(resolve(candidateRoot, "sha256.json")),
    readFile(resolve(candidateRoot, "git-source-objects.json")),
    readFile(resolve(candidateRoot, "runtime-inputs.json")),
    readFile(resolve(candidateRoot, "metadata-before-copy-helper-adaptation.json")),
    readFile(resolve(candidateRoot, "metadata-before-count-adaptation.json")),
  ]);
  assert.equal(sha256(metadataBytes), expectedGatewayMetadataSha256);
  assert.equal(sha256(initialMetadataBytes), expectedGatewayInitialMetadataSha256);
  assert.equal(sha256(preCountMetadataBytes), expectedGatewayPreCountMetadataSha256);
  assert.equal(sha256(manifestBytes), expectedGatewayManifestSha256);
  assert.equal(sha256(gitObjectsBytes), expectedGatewayGitObjectsSha256);
  assert.equal(sha256(runtimeInputsBytes), expectedGatewayRuntimeInputsSha256);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const gitObjects = JSON.parse(gitObjectsBytes.toString("utf8"));
  const runtimeInputs = JSON.parse(runtimeInputsBytes.toString("utf8"));
  assert.equal(metadata.freezeKind, "complete-static-runtime-input");
  assert.equal(metadata.status, undefined, "legacy copy helper must not interpret this source freeze as its auth-candidate status");
  assert.equal(metadata.sourceCommit, expectedGatewaySourceCommit);
  assert.equal(metadata.sourceDigest, expectedGatewayCandidateDigest);
  assert.equal(metadata.manifestSha256, expectedGatewayManifestSha256);
  assert.equal(metadata.files, expectedGatewayCandidateFiles);
  assert.equal(metadata.count, expectedGatewayCandidateFiles, "the existing copy helper returns the explicit count field");
  assert.equal(metadata.gitSourceFileCount, expectedGatewayGitSourceFiles);
  assert.equal(metadata.gitSourceTreeSha256, expectedGatewayGitSourceTreeSha256);
  assert.equal(metadata.dependencyFiles, expectedRelayWsPackageFiles);
  assert.equal(Object.keys(manifest).length, expectedGatewayCandidateFiles);
  assert.equal(gitObjects.sourceCommit, expectedGatewaySourceCommit);
  assert.equal(gitObjects.files.length, expectedGatewayGitSourceFiles);
  assert.equal(hashJson(gitObjects.files), expectedGatewayGitSourceTreeSha256);
  for (const entry of gitObjects.files) assert.equal(manifest[entry.path], entry.sha256, `Git source map differs at ${entry.path}`);
  assert.equal(manifest["apps/kcoder-studio/package.json"], expectedGatewayStudioPackageSha256);
  assert.equal(manifest["apps/kcoder-relay/package.json"], expectedGatewayRelayPackageSha256);
  assert.equal(metadata.dependencies.relayWs.treeSha256, expectedRelayWsPackageSha256);
  assert.equal(metadata.dependencies.relayWs.fileCount, expectedRelayWsPackageFiles);
  assert.equal(metadata.dependencies.relayWs.version, expectedRelayWsPackageVersion);
  assert.equal(metadata.dependencies.studio.dependencyTreeSha256, expectedStudioDependencyTreeSha256);
  assert.equal(metadata.dependencies.studio.entryCount, 1034);
  assert.equal(runtimeInputs.sourceCommit, expectedGatewaySourceCommit);
  assert.equal(runtimeInputs.sourceFileMapSha256, expectedGatewayManifestSha256);
  assert.equal(runtimeInputs.node.version, "v22.17.0");
  assert.equal(runtimeInputs.node.sha256, expectedGatewayNodeSha256);
  assert.equal(runtimeInputs.studioDependencies.root, pinnedStudioDependencyRoot);
  assert.equal(runtimeInputs.studioDependencies.freezeManifestSha256, expectedStudioDependencyManifestSha256);
  assert.equal(runtimeInputs.studioDependencies.dependencyTreeSha256, expectedStudioDependencyTreeSha256);
  assert.equal(runtimeInputs.relayDependencies.ws.treeSha256, expectedRelayWsPackageSha256);
  assert.equal(runtimeInputs.relayDependencies.ws.copiedIntoSourceRootAsRegularFiles, true);
  assert.equal(runtimeInputs.noCredentialsIncluded, true);
  const sidecars = new Set(["metadata.json", "metadata-before-copy-helper-adaptation.json", "metadata-before-count-adaptation.json", "sha256.json", "git-source-objects.json", "runtime-inputs.json"]);
  const actualFiles = await collectLocalRegularFiles(candidateRoot);
  const runtimeFiles = actualFiles.filter(entry => !sidecars.has(entry.path)).map(entry => ({ path: entry.path, sha256: entry.sha256 }));
  const expectedFiles = Object.entries(manifest).sort(([left],[right]) => left.localeCompare(right)).map(([path, digest]) => ({ path, sha256: digest }));
  assert.deepEqual(runtimeFiles, expectedFiles, "frozen Gateway/Relay input must contain exactly the pinned source and dependency files");
  return {
    sourceCommit: metadata.sourceCommit,
    sourceDigest: metadata.sourceDigest,
    sourceFiles: metadata.files,
    gitSourceFiles: metadata.gitSourceFileCount,
    gitSourceTreeSha256: metadata.gitSourceTreeSha256,
    relayWsTreeSha256: metadata.dependencies.relayWs.treeSha256,
    studioDependencyTreeSha256: metadata.dependencies.studio.dependencyTreeSha256,
    metadataSha256: sha256(metadataBytes),
    manifestSha256: sha256(manifestBytes),
    gitObjectsSha256: sha256(gitObjectsBytes),
    runtimeInputsSha256: sha256(runtimeInputsBytes),
    studioPackageSha256: manifest["apps/kcoder-studio/package.json"],
    relayPackageSha256: manifest["apps/kcoder-relay/package.json"],
  };
}

async function verifyPinnedStudioDependencies() {
  const rootInfo = await lstat(pinnedStudioDependencyRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  assert.equal(await realpath(pinnedStudioDependencyRoot), pinnedStudioDependencyRoot);
  const freezeBytes = await readFile(pinnedStudioRuntimeFreezePath);
  const relocationBytes = await readFile(pinnedStudioRuntimeRelocationPath);
  assert.equal(sha256(freezeBytes), expectedStudioDependencyManifestSha256);
  assert.equal(sha256(relocationBytes), expectedStudioDependencyRelocationSha256);
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  const relocation = JSON.parse(relocationBytes.toString("utf8"));
  assert.equal(freeze.status, "complete");
  assert.equal(freeze.sourceTreeSha256, expectedStudioRuntimeSourceTreeSha256);
  assert.equal(freeze.dependencyTreeSha256, expectedStudioDependencyTreeSha256);
  assert.equal(freeze.dependencyFiles.length, 1034);
  assert.equal(relocation.status, "complete");
  assert.equal(relocation.destinationDependencyTreeSha256, expectedStudioDependencyTreeSha256);
  assert.equal(relocation.dependencyEntryCount, 1034);
  assert.equal(relocation.binaryCopied, false);
  const actualDependencyFiles = await collectPinnedStudioDependencyFiles(pinnedStudioDependencyRoot);
  assert.deepEqual(actualDependencyFiles, freeze.dependencyFiles, "the mounted Studio dependency closure must match its complete per-entry manifest");
  assert.equal(hashJson(actualDependencyFiles), expectedStudioDependencyTreeSha256);
  const jsoncPackage = JSON.parse(await readFile(resolve(pinnedStudioDependencyRoot, "jsonc-parser/package.json"), "utf8"));
  const ssh2Package = JSON.parse(await readFile(resolve(pinnedStudioDependencyRoot, "ssh2/package.json"), "utf8"));
  assert.equal(jsoncPackage.version, "3.3.1");
  assert.equal(ssh2Package.version, "1.17.0");
  return {
    dependencyTreeSha256: freeze.dependencyTreeSha256,
    dependencyEntryCount: actualDependencyFiles.length,
    symlinkCount: actualDependencyFiles.filter(entry => "symlinkTarget" in entry).length,
    sourceTreeSha256: freeze.sourceTreeSha256,
    manifestSha256: sha256(freezeBytes),
    relocationSha256: sha256(relocationBytes),
    directPackages: { jsoncParser: jsoncPackage.version, ssh2: ssh2Package.version },
  };
}

async function collectPinnedStudioDependencyFiles(root) {
  const canonicalRoot = await realpath(root);
  assert.equal(canonicalRoot, root);
  const files = [];
  async function visit(directory, relativeRoot = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (dependencyEntryExcluded(entry.name, entry.isDirectory())) continue;
      const absolute = resolve(directory, entry.name);
      const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      let info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await realpath(absolute);
        assert.ok(target === canonicalRoot || target.startsWith(`${canonicalRoot}${sep}`), `Studio dependency symlink escaped its fixed root: ${path}`);
        files.push({ path, symlinkTarget: await readlink(absolute) });
        info = await stat(absolute);
      }
      if (info.isDirectory()) await visit(absolute, path);
      else if (info.isFile()) files.push({ path, size: info.size, sha256: sha256(await readFile(absolute)) });
      else assert.fail(`unsupported Studio dependency entry: ${path}`);
    }
  }
  await visit(canonicalRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function dependencyEntryExcluded(name, isDirectory) {
  if (isDirectory && [".vite", ".cache", "coverage", ".git"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

async function verifyCopiedRelayWs(sourceRoot) {
  const info = await lstat(sourceRoot);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(sourceRoot), sourceRoot);
  const files = await collectLocalRegularFiles(sourceRoot);
  assert.equal(files.length, expectedRelayWsPackageFiles);
  assert.equal(hashJson(files), expectedRelayWsPackageSha256);
  const pkg = JSON.parse(await readFile(resolve(sourceRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, expectedRelayWsPackageVersion);
  return { version: pkg.version, fileCount: files.length, treeSha256: hashJson(files) };
}

async function loadPrivateRelayInputs(context) {
  const fixturesPath = resolve(oldPublicFixtureRoot, "private-mobile-pairing-fixtures.json");
  const registrationStorePath = resolve(oldPublicFixtureRoot, "relay-registration-store.json");
  const identityPaths = {
    alpha: resolve(oldPublicFixtureRoot, "relay-client-alpha.json"),
    beta: resolve(oldPublicFixtureRoot, "relay-client-beta.json"),
  };
  const [fixturesBytes, storeBytes] = await Promise.all([
    readPrivateRegularFile(fixturesPath, oldPublicFixtureRoot),
    readPrivateRegularFile(registrationStorePath, oldPublicFixtureRoot),
  ]);
  const fixtures = JSON.parse(fixturesBytes.toString("utf8"));
  const store = JSON.parse(storeBytes.toString("utf8"));
  assert.deepEqual(Object.keys(fixtures).sort(), ["alpha", "beta"]);
  assert.equal(Array.isArray(store.gateways), true);
  const registeredRecords = {};
  for (const name of ["alpha", "beta"]) {
    assert.match(fixtures[name]?.id ?? "", /^[a-f0-9]{32}$/);
    assert.ok(typeof fixtures[name]?.pairingToken === "string" && fixtures[name].pairingToken.length >= 32);
    const record = store.gateways.find(candidate => candidate.id === fixtures[name].id);
    assert.ok(record, `${name} private fixture must match a record in the copied test Relay registry`);
    assert.equal(record.pairingToken, fixtures[name].pairingToken, `${name} pairing token must match its private registry authorization`);
    const identityBytes = await readPrivateRegularFile(identityPaths[name], oldPublicFixtureRoot);
    const identity = JSON.parse(identityBytes.toString("utf8"));
    assert.equal(identity.id, fixtures[name].id);
    assert.equal(identity.secret, record.secret);
    registeredRecords[name] = record;
    context.registerSecret(fixtures[name].id);
    context.registerSecret(fixtures[name].pairingToken);
    context.registerSecret(record.secret);
  }
  return { fixtures, registeredRecords, identityPaths, registrationStorePath };
}

async function updatePrivateIdentityRelayOrigin(path, relayOrigin, fixtureId) {
  const before = JSON.parse(await readFile(path, "utf8"));
  assert.equal(before.id, fixtureId);
  assert.equal(before.status ?? "registered", "registered");
  const after = { ...before, relayOrigin };
  const temporary = `${path}.rewrite-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(after)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  const check = JSON.parse(await readFile(path, "utf8"));
  assert.equal(check.relayOrigin, relayOrigin);
  for (const key of Object.keys(before)) {
    if (key !== "relayOrigin") assert.equal(check[key], before[key], `identity rewrite must preserve ${key}`);
  }
  assert.equal((await lstat(path)).mode & 0o077, 0);
}

async function copyPrivateFile(source, destination) {
  const bytes = await readPrivateRegularFile(source, oldPublicFixtureRoot);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  await chmod(destination, 0o600);
  assert.equal(sha256(await readFile(destination)), sha256(bytes));
}

async function readPrivateRegularFile(path, boundary) {
  const root = resolve(boundary);
  const canonicalRoot = await realpath(root);
  const canonicalPath = resolve(path);
  const rel = relative(canonicalRoot, canonicalPath);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  assert.equal(await realpath(canonicalPath), canonicalPath);
  const info = await lstat(canonicalPath);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o077, 0, "source identity and registry fixture must remain private");
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid());
  return readFile(canonicalPath);
}

async function runLocalRenameat2Probe(context) {
  const scratch = context.pathInState("renameat2-probe-scratch");
  await mkdir(scratch, { mode: 0o700 });
  const source = context.pathInArtifacts("renameat2-local-probe.py");
  const remoteSource = context.pathInArtifacts("remote-no-reload-agent.py");
  await writeFile(source, localRenameat2ProbePython, { flag: "wx", mode: 0o600 });
  await writeFile(remoteSource, remotePython, { flag: "wx", mode: 0o600 });
  await chmod(source, 0o600);
  await chmod(remoteSource, 0o600);
  const python = context.spawnOwned("local-renameat2-probe", "/usr/bin/python3.12", ["-B", source, scratch, remoteSource], {
    cwd: repoRoot,
    env: context.isolatedEnvironment(),
  });
  const output = await waitForOwnedExit(context, "local-renameat2-probe", python, 10_000, { captureStdout: true });
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, "the local renameat2 probe should emit one JSON result line");
  const proof = JSON.parse(lines[0]);
  assert.deepEqual(proof, {
    remoteAgentSyntaxCompiled: true,
    firstExchangeReversed: true,
    secondExchangeRestored: true,
  });
  const result = {
    status: "passed",
    scope: "local temporary directory only; no SSH, cloud, Caddy, route, or Browser access",
    pythonSourceSha256: sha256(Buffer.from(localRenameat2ProbePython)),
    remoteAgentSourceSha256: sha256(Buffer.from(remotePython)),
    firstExchangeReversed: proof.firstExchangeReversed,
    secondExchangeRestored: proof.secondExchangeRestored,
  };
  await context.writeArtifactJson("renameat2-local-probe-result.json", result);
  return result;
}

async function remoteJson(context, label, request, { timeoutMs = 25_000, recoveryBudget = null } = {}) {
  const args = [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    cloudHost,
    `python3 -c ${shellQuote(remotePython)}`,
  ];
  const startedAtEpochMs = Date.now();
  const capture = {};
  let envelopeParsed = false;
  let envelopeOk = null;
  let remoteErrorKind = null;
  let responseState = "not-observed";
  let safeReceipt = null;
  let result;
  let failure;
  try {
    const output = await runOwnedCapture(context, label, "ssh", args, {
      input: Buffer.from(JSON.stringify(request)),
      timeoutMs,
      env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
      observation: capture,
    });
    let envelope;
    try {
      envelope = JSON.parse(output);
      envelopeParsed = true;
    } catch {
      responseState = output.length ? "invalid-json" : "empty-response";
      throw new Error("remote operation returned an invalid response envelope");
    }
    envelopeOk = envelope?.ok === true;
    responseState = envelopeOk ? "success-envelope" : envelope?.ok === false ? "error-envelope" : "invalid-envelope";
    if (envelope?.ok === false) {
      remoteErrorKind = knownRemoteErrorKinds.has(envelope.errorType) ? envelope.errorType : "other";
    }
    if (!envelopeOk) throw new Error("remote operation did not return a successful envelope");
    result = envelope.result;
    safeReceipt = safeRemoteReceipt(request.action, result);
  } catch (error) {
    failure = error;
    if (responseState === "not-observed" && capture.timeoutTriggered) {
      responseState = capture.stdoutBytes > 0 ? "timeout-output-unparsed" : "timeout-no-output";
    } else if (responseState === "not-observed" && capture.stdoutBytes > 0) {
      responseState = "output-unparsed";
    }
  }

  const ordinal = (remoteJsonArtifactOrdinals.get(context) || 0) + 1;
  remoteJsonArtifactOrdinals.set(context, ordinal);
  const observation = {
    schemaVersion: 1,
    ordinal,
    operationLabel: context.redactText(label).slice(0, 128),
    remoteAction: knownRemoteActions.has(request?.action) ? request.action : "other",
    startedAtEpochMs,
    elapsedMs: capture.elapsedMs ?? Math.max(0, Date.now() - startedAtEpochMs),
    timeoutMs,
    timeoutTriggered: capture.timeoutTriggered ?? false,
    stdinBytes: capture.stdinBytes ?? 0,
    stdinWritableFinished: capture.stdinWritableFinished ?? false,
    stdoutBytes: capture.stdoutBytes ?? 0,
    stderrBytes: capture.stderrBytes ?? 0,
    closeCode: capture.closeCode ?? null,
    closeSignal: capture.closeSignal ?? null,
    processErrorKind: capture.processErrorKind ?? null,
    stopErrorKind: capture.stopErrorKind ?? null,
    processSpawned: capture.spawned === true,
    envelopeParsed,
    envelopeOk,
    remoteErrorKind,
    responseState,
    safeReceipt,
    errorKind: safeErrorKind(failure),
    recoveryBudget: recoveryBudget ? {
      ...recoveryBudget,
      remainingAfterMs: Math.max(0, recoveryBudget.deadlineAtEpochMs - Date.now()),
      result: failure ? (capture.timeoutTriggered ? "step-timeout" : "step-failed") : "response-received",
    } : null,
  };
  try {
    await context.writeArtifactJsonInternal(`remote-json-step-${String(ordinal).padStart(3, "0")}.json`, observation);
  } catch (artifactError) {
    if (failure) {
      const combined = new AggregateError([failure, artifactError], "remote operation and bounded diagnostic artifact both failed");
      combined.remoteStepSpawned = capture.spawned === true;
      throw combined;
    }
    artifactError.remoteStepSpawned = capture.spawned === true;
    throw artifactError;
  }
  if (failure) {
    failure.remoteStepSpawned = capture.spawned === true;
    throw failure;
  }
  return result;
}

function safeRemoteReceipt(action, result) {
  if (!result || typeof result !== "object") return null;
  if (action === "restore-owned-static-transaction") {
    const allowedStatuses = new Set(["completed", "failed", "skipped"]);
    const allowedActions = new Set([
      "cleanup-probe-exchange", "port-status", "manifest", "exchange", "remove-stage",
    ]);
    const steps = Array.isArray(result.steps) ? result.steps.slice(0, 24).map(step => ({
      ordinal: Number.isSafeInteger(step?.ordinal) ? step.ordinal : null,
      label: new Set([
        "initial-owned-probe-cleanup", "initial-forward-port-check", "initial-static-root-readback",
        "initial-stage-readback", "restore-static-root-exchange", "verify-static-root-before-stage-removal",
        "verify-stage-before-removal", "verify-original-root-before-stage-removal",
        "verify-owned-stage-before-removal", "remove-owned-static-stage", "final-owned-probe-check",
        "final-stage-readback", "final-static-root-readback", "final-forward-port-check",
      ]).has(step?.label) ? step.label : "other",
      action: allowedActions.has(step?.action) ? step.action : "other",
      status: allowedStatuses.has(step?.status) ? step.status : "other",
      elapsedMs: Number.isFinite(step?.elapsedMs) && step.elapsedMs >= 0 ? Math.floor(step.elapsedMs) : null,
      errorKind: knownRemoteErrorKinds.has(step?.errorKind) ? step.errorKind : step?.errorKind ? "other" : null,
      receipt: safeRecoveryTransactionStepReceipt(step?.action, step?.receipt),
    })) : [];
    const checks = result.checks && typeof result.checks === "object" ? result.checks : {};
    const allowedReceiptStates = new Set(["not-attempted", "not-needed", "acknowledged", "rejected", "unknown"]);
    return {
      status: result.status === "restored" ? "restored" : "unverified",
      restored: result.restored === true,
      checks: {
        initialPortFree: typeof checks.initialPortFree === "boolean" ? checks.initialPortFree : null,
        initialRootState: new Set(["original", "replacement", "owner-marked", "other", "missing", "unavailable"]).has(checks.initialRootState) ? checks.initialRootState : "other",
        initialStageState: new Set(["original", "replacement", "owner-marked", "other", "missing", "unavailable"]).has(checks.initialStageState) ? checks.initialStageState : "other",
        exchangeAcknowledged: allowedReceiptStates.has(checks.exchangeAcknowledged) ? checks.exchangeAcknowledged : "unknown",
        stageRemovalAcknowledged: allowedReceiptStates.has(checks.stageRemovalAcknowledged) ? checks.stageRemovalAcknowledged : "unknown",
        finalProbePathsRemoved: typeof checks.finalProbePathsRemoved === "boolean" ? checks.finalProbePathsRemoved : null,
        finalStageAbsent: typeof checks.finalStageAbsent === "boolean" ? checks.finalStageAbsent : null,
        finalStaticRootContentMatches: typeof checks.finalStaticRootContentMatches === "boolean" ? checks.finalStaticRootContentMatches : null,
        finalPortFree: typeof checks.finalPortFree === "boolean" ? checks.finalPortFree : null,
      },
      decisionErrorKind: knownRemoteErrorKinds.has(result.decisionErrorKind) ? result.decisionErrorKind : result.decisionErrorKind ? "other" : null,
      elapsedMs: Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 ? Math.floor(result.elapsedMs) : null,
      steps,
    };
  }
  if (action === "create-stage") return { created: result.created === true };
  if (action === "port-status") return {
    free: result.free === true,
    listenerCount: Array.isArray(result.listeners) ? result.listeners.length : null,
  };
  if (action === "cleanup-probe-exchange") return {
    removed: result.removed === true,
    remaining: result.remaining === false ? false : result.remaining === true ? true : null,
  };
  if (action === "exchange") return { exchanged: result.exchanged === true };
  if (action === "remove-stage" || action === "remove-owner-marker") return { removed: result.removed === true };
  if (action === "manifest") return {
    treePresent: result.tree !== null && result.tree !== undefined,
    fileCount: Array.isArray(result.tree?.files) ? result.tree.files.length : null,
  };
  if (action === "probe-exchange") return {
    firstExchangeReversed: result.firstExchangeReversed === true,
    secondExchangeRestored: result.secondExchangeRestored === true,
    ownerMarkerVerifiedBeforeCleanup: result.ownerMarkerVerifiedBeforeCleanup === true,
  };
  return { resultReceived: true };
}

function safeRecoveryTransactionStepReceipt(action, receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  if (action === "cleanup-probe-exchange") return {
    removed: receipt.removed === true,
    remaining: typeof receipt.remaining === "boolean" ? receipt.remaining : null,
  };
  if (action === "port-status") return {
    free: receipt.free === true,
    listenerCount: Number.isSafeInteger(receipt.listenerCount) ? receipt.listenerCount : null,
  };
  if (action === "manifest") return {
    treePresent: receipt.treePresent === true,
    fileCount: Number.isSafeInteger(receipt.fileCount) ? receipt.fileCount : null,
  };
  if (action === "exchange") {
    const skipReasons = new Set([
      "root-already-original", "forward-port-not-free", "initial-readback-unavailable",
      "state-ambiguous-or-foreign", "decision-incomplete",
    ]);
    if (skipReasons.has(receipt.reason)) return { reason: receipt.reason };
    return { exchanged: receipt.exchanged === true };
  }
  if (action === "remove-stage") {
    const skipReasons = new Set([
      "stage-absent", "pre-removal-ownership-not-proven", "post-exchange-ownership-not-proven",
      "forward-port-not-free", "initial-readback-unavailable", "state-ambiguous-or-foreign",
      "decision-incomplete",
    ]);
    if (skipReasons.has(receipt.reason)) return { reason: receipt.reason };
    return {
      removed: receipt.removed === true,
      method: receipt.method === "owner-marker" || receipt.method === "verified-bundle-manifest" ? receipt.method : null,
    };
  }
  return null;
}

function safeErrorKind(error) {
  if (!error) return null;
  const name = String(error?.name || "Error");
  return new Set(["Error", "AssertionError", "SyntaxError", "TypeError", "RangeError", "TimeoutError", "AbortError"]).has(name)
    ? name
    : "other";
}

async function uploadBundleArchive(context, archivePath, stagePath) {
  const archiveBytes = (await stat(archivePath)).size;
  const command = [
    "set -eu",
    `test -d ${shellQuote(dirname(stagePath))}`,
    `test -d ${shellQuote(stagePath)}`,
    `test -f ${shellQuote(`${stagePath}/.kc-e2e-owner`)}`,
    `tar --no-same-owner -xzf - -C ${shellQuote(stagePath)}`,
    `find ${shellQuote(stagePath)} -type d -exec chmod 700 {} +`,
    `find ${shellQuote(stagePath)} -type f -exec chmod 600 {} +`,
  ].join("; ");
  const child = context.spawnOwned("upload-latest-mobile-web-stage", "ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", cloudHost, command,
  ], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    stdin: "pipe",
  });
  const source = createReadStream(archivePath);
  const exit = childExit(child);
  const stderrCaptureLimit = 8 * 1024;
  const stderrChunks = [];
  let stderrObservedBytes = 0;
  let stderrRedactedBytesSeen = 0;
  let stderrCapturedBytes = 0;
  let stderrTruncated = false;
  let stderrCaptureErrorKind = null;
  const stderrRedactor = createRedactingStream(value => context.redactText(value), () => context.secrets);
  child.stderr.on("data", chunk => { stderrObservedBytes += Buffer.byteLength(chunk); });
  stderrRedactor.on("data", chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrRedactedBytesSeen += bytes.length;
    const remaining = stderrCaptureLimit - stderrCapturedBytes;
    if (remaining <= 0) {
      if (bytes.length) stderrTruncated = true;
      return;
    }
    const kept = bytes.subarray(0, remaining);
    if (kept.length) {
      stderrChunks.push(Buffer.from(kept));
      stderrCapturedBytes += kept.length;
    }
    if (bytes.length > kept.length) stderrTruncated = true;
  });
  stderrRedactor.on("error", error => { stderrCaptureErrorKind = safeTransferErrorKind(error); });
  child.stderr.pipe(stderrRedactor);
  const startedAt = Date.now();
  let timeoutTriggered = false;
  let stopPromise;
  let stopError;
  let pipelineError;
  let exitError;
  let exitResult;
  const stopUploadOnce = () => {
    if (!stopPromise) {
      stopPromise = context.stopOwned("upload-latest-mobile-web-stage").catch(error => {
        stopError = error;
      });
    }
    return stopPromise;
  };
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    void stopUploadOnce();
  }, 90_000);
  try {
    try {
      await pipeline(source, child.stdin);
    } catch (error) {
      pipelineError = error;
      await stopUploadOnce();
    }
    try {
      exitResult = await exit;
    } catch (error) {
      exitError = error;
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) await stopUploadOnce();
    if (stopPromise) await stopPromise;
  }

  let assertionError;
  if (!pipelineError && !exitError) {
    if (timeoutTriggered) {
      assertionError = new Error("owned SSH tar upload exceeded its 90-second bound");
    } else {
      try {
        assert.equal(exitResult?.code, 0, "owned SSH tar upload must complete");
      } catch (error) {
        assertionError = error;
      }
    }
  }
  const observation = {
    status: !pipelineError && !exitError && exitResult?.code === 0 && !timeoutTriggered && !stopError
      ? "completed"
      : "incomplete",
    boundMs: 90_000,
    elapsedMs: Date.now() - startedAt,
    timeoutTriggered,
    expectedArchiveBytes: archiveBytes,
    sourceBytesRead: source.bytesRead,
    sourceReachedEnd: source.readableEnded,
    sshStdinFinished: child.stdin.writableFinished,
    stderrObservedBytes,
    stderrRedactedBytesSeen,
    stderrCapturedBytes,
    stderrTruncated,
    stderrCaptureErrorKind,
    redactedStderrExcerpt: Buffer.concat(stderrChunks).toString("utf8"),
    pipelineStatus: pipelineError ? "rejected" : "fulfilled",
    pipelineErrorKind: pipelineError ? safeTransferErrorKind(pipelineError) : null,
    childExitCode: exitResult?.code ?? null,
    childExitSignal: exitResult?.signal ?? null,
    childExitErrorKind: exitError ? safeTransferErrorKind(exitError) : null,
    stopErrorKind: stopError ? safeTransferErrorKind(stopError) : null,
  };
  let evidenceError;
  try {
    await context.writeArtifactJsonInternal("upload-latest-mobile-web-stage-observation.json", observation);
  } catch (error) {
    evidenceError = error;
  }
  const transferErrors = [pipelineError, exitError, stopError, assertionError].filter(Boolean);
  const transferFailure = transferErrors.length > 1
    ? new AggregateError(transferErrors, "owned SSH tar upload did not complete")
    : transferErrors[0];
  if (transferFailure && evidenceError) {
    throw new AggregateError([transferFailure, evidenceError], "owned SSH tar upload and evidence recording both failed");
  }
  if (transferFailure) throw transferFailure;
  if (evidenceError) throw evidenceError;
}

function safeTransferErrorKind(error) {
  const knownCodes = new Set([
    "ABORT_ERR",
    "EPIPE",
    "EIO",
    "ENOENT",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_PREMATURE_CLOSE",
  ]);
  if (knownCodes.has(error?.code)) return error.code;
  if (error?.name === "AbortError") return "ABORT_ERR";
  return "OTHER";
}

async function runWithRemoteStateRestoration(context, action, restore) {
  let value;
  let actionError;
  let restoreError;
  try {
    value = await action();
  } catch (error) {
    actionError = error;
  } finally {
    try {
      await restore();
    } catch (error) {
      restoreError = error;
    }
  }
  let evidenceError;
  if (actionError || restoreError) {
    try {
      await context.writeArtifactJsonInternal("remote-state-primary-recovery-errors.json", {
        primaryFailure: safeErrorSummary(context, actionError),
        recoveryFailure: safeErrorSummary(context, restoreError),
        recoveryWasAttemptedInBodyFinally: true,
      });
    } catch (error) {
      evidenceError = error;
    }
  }
  if (evidenceError) {
    const failures = [actionError, restoreError, evidenceError].filter(Boolean);
    throw new AggregateError(failures, "public setup/recovery failure evidence could not be fully retained");
  }
  if (actionError && restoreError) {
    throw new AggregateError([actionError, restoreError], "public static-root setup and recovery both failed");
  }
  if (actionError) throw actionError;
  if (restoreError) throw restoreError;
  return value;
}

function safeErrorSummary(context, error, depth = 0) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const summary = {
    name: context.redactText(error?.name || "Error").slice(0, 128),
    message: context.redactText(message).slice(0, 2_048),
  };
  if (error instanceof AggregateError) {
    summary.causes = depth >= 3
      ? [{ truncated: true }]
      : [...error.errors].slice(0, 8).map(cause => safeErrorSummary(context, cause, depth + 1));
  }
  return summary;
}

async function restoreRemoteStateWithDeadline(context, options, deadlineMs) {
  const startedAt = Date.now();
  const deadlineAtEpochMs = startedAt + deadlineMs;
  let timedOut = false;
  let timeoutError;
  let abortPromise;
  let rejectDeadline;
  const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
  const restoreOperation = restoreRemoteState(context, { ...options, recoveryDeadlineAtEpochMs: deadlineAtEpochMs });
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutError = new Error(`isolated remote-state recovery exceeded ${deadlineMs}ms`);
    try {
      abortPromise = Promise.resolve(context.requestAbort(timeoutError));
    } catch (error) {
      abortPromise = Promise.reject(error);
    }
    rejectDeadline(timeoutError);
  }, deadlineMs);

  let restored;
  let operationError;
  let abortError;
  try {
    restored = await Promise.race([restoreOperation, deadlinePromise]);
  } catch (error) {
    operationError = error;
    restored = error?.recoveryResult || null;
  } finally {
    clearTimeout(timer);
  }
  if (abortPromise) {
    try {
      await abortPromise;
    } catch (error) {
      abortError = error;
    }
  }
  if (timedOut) {
    const [lateResult] = await Promise.allSettled([restoreOperation]);
    if (lateResult.status === "fulfilled") restored = lateResult.value;
    else restored = lateResult.reason?.recoveryResult || restored;
  }

  const outcome = {
    status: operationError || timedOut || abortError || restored?.restored !== true ? "unverified" : "restored",
    restoreOperationSettled: true,
    parentRunRoot: options.parentRunRoot,
    elapsedMs: Date.now() - startedAt,
    deadlineMs,
    deadlineExceeded: timedOut,
    remoteForwardPort: options.remoteForwardPort,
    reverseForwardLocalStopped: Boolean(restored?.reverseForward?.localStopped),
    reverseForwardRemotePortFree: typeof restored?.reverseForward?.remotePortFree === "boolean" ? restored.reverseForward.remotePortFree : null,
    probePathsRemoved: typeof restored?.probePathsRemoved === "boolean" ? restored.probePathsRemoved : null,
    staticRootRestored: Boolean(restored?.staticRoot?.restored),
    stageRemoved: Boolean(restored?.staticRoot?.stageRemoved),
    stageRemovalAcknowledged: restored?.staticRoot?.stageRemovalAcknowledged ?? "unknown",
    exchangeReversed: Boolean(restored?.staticRoot?.exchangeReversed),
    exchangeAcknowledged: restored?.staticRoot?.exchangeAcknowledged ?? "unknown",
    finalStaticRootVerificationAttempted: Boolean(restored?.staticRoot?.finalStaticRootVerificationAttempted),
    finalStaticRootContentMatches: restored?.staticRoot?.finalStaticRootContentMatches ?? null,
    finalStageAbsent: restored?.staticRoot?.finalStageAbsent ?? null,
    recoveryStepsRemainingMs: restored?.recoveryStepsRemainingMs ?? null,
    recoveryDeadlineAtEpochMs: deadlineAtEpochMs,
    remainingAtOutcomeMs: Math.max(0, deadlineAtEpochMs - Date.now()),
    budgetExhaustionMeans: "UNVERIFIED; timeout does not establish remote cleanup",
  };
  let evidenceError;
  try {
    await context.writeArtifactJsonInternal("remote-state-recovery-outcome.json", outcome);
  } catch (error) {
    evidenceError = error;
  }
  const primaryRecoveryError = [...new Set([timeoutError, operationError, abortError, evidenceError].filter(Boolean))];
  const recoveryFailure = primaryRecoveryError.length > 1
    ? new AggregateError(primaryRecoveryError, "isolated remote-state recovery failed")
    : primaryRecoveryError[0];
  let finishError;
  try {
    await context.finish(recoveryFailure ? "failed" : "passed", outcome, recoveryFailure);
  } catch (error) {
    finishError = error;
  }
  if (recoveryFailure && finishError && recoveryFailure !== finishError) {
    throw new AggregateError([recoveryFailure, finishError], "isolated remote-state recovery and recovery-context finalization failed");
  }
  if (recoveryFailure) throw recoveryFailure;
  if (finishError) throw finishError;
  return restored;
}

async function restoreRemoteState(context, options) {
  const errors = [];
  let localStopped = false;
  let probePathsRemoved = null;
  let remotePortFree = null;
  let staticRoot = null;

  const forward = options.getOwnedForward();
  const forwardRecord = options.parentContext.processes.get("public-no-reload-ssh-data-forward");
  const forwardStopStartedAtEpochMs = Date.now();
  const recoveryDeadlineMsBeforeForwardStop = Math.max(0, options.recoveryDeadlineAtEpochMs - forwardStopStartedAtEpochMs);
  let forwardStopFailure = null;
  let singleParentStopPromise = false;
  try {
    if (forward && forwardRecord && !forwardRecord.stopped) {
      const stopPromise = options.parentContext.stopOwned("public-no-reload-ssh-data-forward");
      const currentRecord = options.parentContext.processes.get("public-no-reload-ssh-data-forward");
      singleParentStopPromise = Boolean(currentRecord?.stopPromise && currentRecord.stopPromise === stopPromise);
      await stopPromise;
    }
    localStopped = !forward || !forwardRecord || forwardRecord.stopped;
  } catch (error) {
    forwardStopFailure = error;
    errors.push(error);
  } finally {
    try {
      await context.writeArtifactJsonInternal("remote-state-recovery-forward-stop.json", {
        step: "stop-run-owned-reverse-forward",
        startedAtEpochMs: forwardStopStartedAtEpochMs,
        elapsedMs: Date.now() - forwardStopStartedAtEpochMs,
        remainingBeforeMs: recoveryDeadlineMsBeforeForwardStop,
        remainingAfterMs: Math.max(0, options.recoveryDeadlineAtEpochMs - Date.now()),
        singleParentStopPromise,
        status: forwardStopFailure ? "failed" : localStopped ? "completed" : "unverified",
        errorKind: safeErrorKind(forwardStopFailure),
        localStopped,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (!localStopped && !forwardStopFailure) {
    errors.push(new Error("run-owned reverse SSH forward stop was not confirmed"));
  }

  const transactionBudget = allocateRecoveryStepBudget({
    deadlineAtMs: options.recoveryDeadlineAtEpochMs,
    nowMs: Date.now(),
    reserveMs: 0,
    maxStepMs: 35_000,
    minUsefulMs: 500,
  });
  const transactionBudgetEvidence = {
    ordinal: 1,
    label: "single-remote-owned-state-transaction",
    deadlineAtEpochMs: options.recoveryDeadlineAtEpochMs,
    remainingBeforeMs: transactionBudget.remainingMs,
    reserveAfterMs: 0,
    usableMs: transactionBudget.usableMs,
    allocatedTimeoutMs: transactionBudget.timeoutMs,
    status: transactionBudget.status,
  };
  try {
    await context.writeArtifactJsonInternal("remote-state-recovery-budget-step-01.json", {
      ...transactionBudgetEvidence,
      remainingAfterMs: Math.max(0, options.recoveryDeadlineAtEpochMs - Date.now()),
      result: transactionBudget.status === "scheduled"
        ? "scheduled; one SSH invocation carries every remote recovery action"
        : "UNVERIFIED; transaction was not started because less than the useful budget remained",
    });
  } catch (error) {
    errors.push(error);
  }

  if (transactionBudget.status === "scheduled") {
    try {
      const replacementTree = typeof options.expectedReplacementTree === "function"
        ? options.expectedReplacementTree()
        : options.expectedReplacementTree;
      const transaction = await remoteJson(context, "recovery-single-owned-state-transaction", {
        action: "restore-owned-static-transaction",
        staticRoot: expectedStaticRoot,
        stagePath: options.remoteStageRoot,
        probeLeft: options.remoteProbeLeft,
        probeRight: options.remoteProbeRight,
        owner: options.ownerMarker,
        remoteForwardPort: options.remoteForwardPort,
        originalProjection: staticTreeContentProjection(options.originalStaticTree),
        replacementProjection: replacementTree ? staticTreeContentProjection(replacementTree) : null,
        expectedBundleFiles: options.expectedBundleFiles,
      }, {
        timeoutMs: transactionBudget.timeoutMs,
        recoveryBudget: transactionBudgetEvidence,
      });
      const checks = transaction?.checks && typeof transaction.checks === "object" ? transaction.checks : {};
      const exchangeAcknowledged = recoveryAcknowledgementState(checks.exchangeAcknowledged);
      const stageRemovalAcknowledged = recoveryAcknowledgementState(checks.stageRemovalAcknowledged);
      probePathsRemoved = typeof checks.finalProbePathsRemoved === "boolean" ? checks.finalProbePathsRemoved : null;
      remotePortFree = typeof checks.finalPortFree === "boolean" ? checks.finalPortFree : null;
      const finalStageAbsent = typeof checks.finalStageAbsent === "boolean" ? checks.finalStageAbsent : null;
      const finalStaticRootContentMatches = typeof checks.finalStaticRootContentMatches === "boolean"
        ? checks.finalStaticRootContentMatches
        : null;
      const finalStaticRootVerificationAttempted = Array.isArray(transaction?.steps)
        && transaction.steps.some(step => step?.label === "final-static-root-readback" && step?.status === "completed");
      const terminalReadbacksPass = probePathsRemoved === true
        && finalStageAbsent === true
        && finalStaticRootContentMatches === true
        && remotePortFree === true;
      const restored = transaction?.status === "restored" && transaction?.restored === true && terminalReadbacksPass;
      staticRoot = {
        restored,
        stageRemoved: stageRemovalAcknowledged === "acknowledged",
        stageRemovalAcknowledged,
        exchangeReversed: exchangeAcknowledged === "acknowledged",
        exchangeAcknowledged,
        finalStaticRootVerificationAttempted,
        finalStaticRootContentMatches,
        finalStageAbsent,
        internalStepCount: Array.isArray(transaction?.steps) ? transaction.steps.length : null,
      };
      if (!restored) errors.push(new Error("single remote recovery transaction did not confirm every terminal readback"));
    } catch (error) {
      errors.push(error);
      staticRoot = {
        restored: false,
        stageRemoved: false,
        stageRemovalAcknowledged: "unknown",
        exchangeReversed: false,
        exchangeAcknowledged: "unknown",
        finalStaticRootVerificationAttempted: false,
        finalStaticRootContentMatches: null,
        finalStageAbsent: null,
        internalStepCount: null,
      };
    }
  } else {
    errors.push(new Error("single remote recovery transaction skipped because its remaining budget was not useful"));
    staticRoot = {
      restored: false,
      stageRemoved: false,
      stageRemovalAcknowledged: "unknown",
      exchangeReversed: false,
      exchangeAcknowledged: "unknown",
      finalStaticRootVerificationAttempted: false,
      finalStaticRootContentMatches: null,
      finalStageAbsent: null,
      internalStepCount: null,
    };
  }

  const result = {
    restored: errors.length === 0 && localStopped && staticRoot?.restored === true,
    remoteForwardPort: options.remoteForwardPort,
    reverseForward: { localStopped, remotePortFree },
    probePathsRemoved,
    staticRoot: staticRoot || {
      restored: false,
      stageRemoved: false,
      stageRemovalAcknowledged: "unknown",
      exchangeReversed: false,
      exchangeAcknowledged: "unknown",
      finalStaticRootVerificationAttempted: false,
      finalStaticRootContentMatches: null,
      finalStageAbsent: null,
      internalStepCount: null,
    },
    recoveryStepsRemainingMs: Math.max(0, options.recoveryDeadlineAtEpochMs - Date.now()),
    failures: errors.map(error => safeErrorSummary(context, error)),
  };
  let evidenceError;
  try {
    await context.writeArtifactJsonInternal("remote-state-recovery-proof.json", result);
  } catch (error) {
    evidenceError = error;
  }
  const stepFailure = errors.length > 1
    ? new AggregateError(errors, "isolated remote-state recovery did not complete cleanly")
    : errors[0];
  const failures = [stepFailure, evidenceError].filter(Boolean);
  if (failures.length) {
    const recoveryFailure = failures.length > 1
      ? new AggregateError(failures, "isolated remote-state recovery was not fully verified")
      : failures[0];
    recoveryFailure.recoveryResult = result;
    throw recoveryFailure;
  }
  return result;
}

function recoveryAcknowledgementState(value) {
  return new Set(["not-attempted", "not-needed", "acknowledged", "rejected", "unknown"]).has(value)
    ? value
    : "unknown";
}

async function runOwnedCapture(context, label, command, args, { input, timeoutMs = 30_000, env, observation } = {}) {
  const startedAt = Date.now();
  const child = context.spawnOwned(label, command, args, {
    cwd: repoRoot,
    env: env || context.isolatedEnvironment(),
    ...(input ? { stdin: "pipe" } : {}),
  });
  if (observation) observation.spawned = true;
  const chunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdinBytes = 0;
  child.stdout.on("data", chunk => {
    const buffer = Buffer.from(chunk);
    stdoutBytes += buffer.length;
    chunks.push(buffer);
  });
  child.stderr.on("data", chunk => { stderrBytes += Buffer.byteLength(chunk); });
  const exit = childExit(child);
  let timedOut = false;
  let stop = Promise.resolve();
  let closeResult = null;
  let processErrorKind = null;
  let stopErrorKind = null;
  const timer = setTimeout(() => {
    timedOut = true;
    stop = context.stopOwned(label);
  }, timeoutMs);
  try {
    if (input) {
      stdinBytes = Buffer.byteLength(input);
      child.stdin.end(input);
    }
    let result;
    try {
      result = await exit;
      closeResult = result;
    } catch (error) {
      processErrorKind = safeErrorKind(error);
      throw error;
    }
    await stop;
    if (timedOut) throw new Error(`${label} exceeded its bounded runtime`);
    assert.equal(result.code, 0, `${label} must exit successfully`);
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    clearTimeout(timer);
    try {
      await stop;
    } catch (error) {
      stopErrorKind = safeErrorKind(error);
      throw error;
    } finally {
      if (observation) {
        Object.assign(observation, {
          elapsedMs: Date.now() - startedAt,
          timeoutTriggered: timedOut,
          stdinBytes,
          stdinWritableFinished: input ? child.stdin.writableFinished === true : false,
          stdoutBytes,
          stderrBytes,
          closeCode: closeResult?.code ?? null,
          closeSignal: closeResult?.signal ?? null,
          processErrorKind,
          stopErrorKind,
        });
      }
    }
  }
}

async function waitForOwnedExit(context, label, child, timeoutMs, { captureStdout = false } = {}) {
  const chunks = [];
  if (captureStdout) child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const exit = childExit(child);
  let timedOut = false;
  let stop = Promise.resolve();
  const timer = setTimeout(() => {
    timedOut = true;
    stop = context.stopOwned(label);
  }, timeoutMs);
  try {
    const result = await exit;
    await stop;
    if (timedOut) throw new Error(`${label} exceeded its bounded runtime`);
    assert.equal(result.code, 0, `${label} must exit successfully`);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    await stop;
  }
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

async function collectLocalRegularFiles(root) {
  const canonical = await realpath(root);
  const rows = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, `symlink forbidden in pinned static input: ${entry.name}`);
      if (info.isDirectory()) await visit(path);
      else {
        assert.ok(info.isFile(), `only regular files allowed in pinned static input: ${entry.name}`);
        const bytes = await readFile(path);
        rows.push({ path: relative(canonical, path).split(sep).join("/"), size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(canonical);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyRegularTree(sourceRoot, destinationRoot) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.equal(info.isSymbolicLink(), false, "pinned package copy cannot contain symlinks");
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: false, mode: 0o700 });
      await copyRegularTree(source, destination);
    } else {
      assert.ok(info.isFile());
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }
  }
}

function bundleProjection(files) {
  return files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFileSha256(path) {
  const digest = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return digest.digest("hex");
}
