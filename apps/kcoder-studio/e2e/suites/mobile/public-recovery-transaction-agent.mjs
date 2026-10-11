export const remoteRecoveryTransactionPython = String.raw`
def _r4_projection_map(projection):
    if not isinstance(projection, dict):
        raise TypeError("static-projection-not-object")
    root = projection.get("root")
    directories = projection.get("directories")
    files = projection.get("files")
    if not isinstance(root, dict) or not isinstance(directories, list) or not isinstance(files, list):
        raise TypeError("static-projection-shape-invalid")
    root_row = tuple(root.get(key) for key in ("mode", "uid", "gid"))
    directory_rows = {}
    for row in directories:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
            raise TypeError("static-projection-directory-invalid")
        path = row["path"]
        if path in directory_rows:
            raise ValueError("static-projection-duplicate-directory")
        directory_rows[path] = tuple(row.get(key) for key in ("mode", "uid", "gid"))
    file_rows = {}
    for row in files:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
            raise TypeError("static-projection-file-invalid")
        path = row["path"]
        if path in file_rows:
            raise ValueError("static-projection-duplicate-file")
        file_rows[path] = tuple(row.get(key) for key in ("mode", "uid", "gid", "size", "sha256"))
    return root_row, directory_rows, file_rows

def _r4_tree_matches(tree_value, expected_projection):
    if tree_value is None or expected_projection is None:
        return False
    try:
        actual_projection = {
            "root": {
                "mode": tree_value["root"]["mode"],
                "uid": tree_value["root"]["uid"],
                "gid": tree_value["root"]["gid"],
            },
            "directories": [
                {key: row[key] for key in ("path", "mode", "uid", "gid")}
                for row in tree_value["directories"]
            ],
            "files": [
                {key: row[key] for key in ("path", "mode", "uid", "gid", "size", "sha256")}
                for row in tree_value["files"]
            ],
        }
        return _r4_projection_map(actual_projection) == _r4_projection_map(expected_projection)
    except (KeyError, TypeError, ValueError):
        return False

def _r4_has_owner_marker(tree_value):
    if not isinstance(tree_value, dict) or not isinstance(tree_value.get("files"), list):
        return False
    return any(isinstance(row, dict) and row.get("path") == ".kc-e2e-owner" for row in tree_value["files"])

def _r4_classify_tree(tree_value, original_projection, replacement_projection):
    if tree_value is None:
        return "missing"
    if _r4_tree_matches(tree_value, original_projection):
        return "original"
    if _r4_tree_matches(tree_value, replacement_projection):
        return "replacement"
    if _r4_has_owner_marker(tree_value):
        return "owner-marked"
    return "other"

def _r4_safe_error_kind(error):
    name = type(error).__name__
    allowed = {
        "AssertionError", "FileExistsError", "FileNotFoundError", "IsADirectoryError",
        "KeyError", "NotADirectoryError", "OSError", "PermissionError", "RuntimeError",
        "TimeoutExpired", "TimeoutError", "TypeError", "ValueError",
    }
    return name if name in allowed else "other"

def _r4_step_receipt(action, result):
    if not isinstance(result, dict):
        return {"resultReceived": True}
    if action == "cleanup-probe-exchange":
        return {
            "removed": result.get("removed") is True,
            "remaining": result.get("remaining") if isinstance(result.get("remaining"), bool) else None,
        }
    if action == "port-status":
        listeners = result.get("listeners")
        return {
            "free": result.get("free") is True,
            "listenerCount": len(listeners) if isinstance(listeners, list) else None,
        }
    if action == "manifest":
        tree_value = result.get("tree")
        return {
            "treePresent": tree_value is not None,
            "fileCount": len(tree_value.get("files", [])) if isinstance(tree_value, dict) and isinstance(tree_value.get("files"), list) else None,
        }
    if action == "exchange":
        return {"exchanged": result.get("exchanged") is True}
    if action == "remove-stage":
        method = result.get("by")
        return {
            "removed": result.get("removed") is True,
            "method": method if method in ("owner-marker", "verified-bundle-manifest") else None,
        }
    return {"resultReceived": True}

def _r4_skip_step_reason_allowed(action, reason):
    allowed = {
        "exchange": {
            "root-already-original", "forward-port-not-free", "initial-readback-unavailable",
            "state-ambiguous-or-foreign", "decision-incomplete",
        },
        "remove-stage": {
            "stage-absent", "pre-removal-ownership-not-proven", "post-exchange-ownership-not-proven",
            "forward-port-not-free", "initial-readback-unavailable", "state-ambiguous-or-foreign",
            "decision-incomplete",
        },
    }
    return reason in allowed.get(action, set())

def _r4_validate_request(request):
    owner = request.get("owner")
    if not isinstance(owner, str) or re.fullmatch(r"[0-9a-f]{16}", owner) is None:
        raise ValueError("recovery-owner-invalid")
    expected_stage = STATIC_ROOT + ".stage-" + owner
    expected_probe_left = STATIC_ROOT + ".exchange-probe-" + owner + "-a"
    expected_probe_right = STATIC_ROOT + ".exchange-probe-" + owner + "-b"
    if request.get("staticRoot") != STATIC_ROOT or request.get("stagePath") != expected_stage:
        raise ValueError("recovery-static-path-scope-invalid")
    if request.get("probeLeft") != expected_probe_left or request.get("probeRight") != expected_probe_right:
        raise ValueError("recovery-probe-path-scope-invalid")
    if request.get("remoteForwardPort") != REMOTE_PORT:
        raise ValueError("recovery-port-scope-invalid")
    _r4_projection_map(request.get("originalProjection"))
    replacement = request.get("replacementProjection")
    if replacement is not None:
        _r4_projection_map(replacement)
    expected_files = request.get("expectedBundleFiles")
    if not isinstance(expected_files, list):
        raise TypeError("recovery-bundle-projection-invalid")
    for row in expected_files:
        if not isinstance(row, dict) or set(row) != {"path", "size", "sha256"}:
            raise TypeError("recovery-bundle-file-invalid")
        path = row["path"]
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("recovery-bundle-path-invalid")
        if not isinstance(row["size"], int) or not isinstance(row["sha256"], str) or re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is None:
            raise ValueError("recovery-bundle-file-hash-invalid")
    return owner, expected_stage, expected_probe_left, expected_probe_right, expected_files

def run_recovery_transaction(request, action_dispatcher):
    owner, stage_path, probe_left, probe_right, expected_files = _r4_validate_request(request)
    started = time.monotonic()
    steps = []

    def step(label, action, fields):
        ordinal = len(steps) + 1
        began = time.monotonic()
        receipt = None
        error_kind = None
        try:
            result = action_dispatcher({"action": action, **fields})
            status = "completed"
            receipt = _r4_step_receipt(action, result)
        except Exception as error:
            status = "failed"
            error_kind = _r4_safe_error_kind(error)
            result = None
        steps.append({
            "ordinal": ordinal,
            "label": label,
            "action": action,
            "status": status,
            "elapsedMs": max(0, int((time.monotonic() - began) * 1000)),
            "errorKind": error_kind,
            "receipt": receipt,
        })
        return status == "completed", result

    def skip_step(label, action, reason):
        if not _r4_skip_step_reason_allowed(action, reason):
            raise ValueError("recovery-skip-reason-invalid")
        steps.append({
            "ordinal": len(steps) + 1,
            "label": label,
            "action": action,
            "status": "skipped",
            "elapsedMs": 0,
            "errorKind": None,
            "receipt": {"reason": reason},
        })

    def has_action_step(action):
        return any(item.get("action") == action for item in steps)

    def read_tree(label, path):
        ok, result = step(label, "manifest", {"path": path})
        if not ok or not isinstance(result, dict) or "tree" not in result:
            return False, None
        return True, result["tree"]

    original_projection = request["originalProjection"]
    replacement_projection = request.get("replacementProjection")
    checks = {
        "initialPortFree": None,
        "initialRootState": "unavailable",
        "initialStageState": "unavailable",
        "exchangeAcknowledged": "not-attempted",
        "stageRemovalAcknowledged": "not-attempted",
        "finalProbePathsRemoved": None,
        "finalStageAbsent": None,
        "finalStaticRootContentMatches": None,
        "finalPortFree": None,
    }
    decision_error_kind = None

    try:
        step("initial-owned-probe-cleanup", "cleanup-probe-exchange", {
            "left": probe_left, "right": probe_right, "owner": owner,
        })
        port_ok, port_result = step("initial-forward-port-check", "port-status", {"port": REMOTE_PORT})
        checks["initialPortFree"] = bool(port_ok and isinstance(port_result, dict) and port_result.get("free") is True)
        root_ok, root_tree = read_tree("initial-static-root-readback", STATIC_ROOT)
        stage_ok, stage_tree = read_tree("initial-stage-readback", stage_path)
        checks["initialRootState"] = _r4_classify_tree(root_tree, original_projection, replacement_projection) if root_ok else "unavailable"
        checks["initialStageState"] = _r4_classify_tree(stage_tree, original_projection, replacement_projection) if stage_ok else "unavailable"

        if checks["initialPortFree"] and root_ok and stage_ok:
            root_is_original = _r4_tree_matches(root_tree, original_projection)
            root_is_replacement = _r4_tree_matches(root_tree, replacement_projection)
            stage_is_original = _r4_tree_matches(stage_tree, original_projection)
            stage_is_replacement = _r4_tree_matches(stage_tree, replacement_projection)
            stage_is_owner_marked = _r4_has_owner_marker(stage_tree)

            if root_is_replacement and stage_is_original:
                exchange_ok, exchange_result = step("restore-static-root-exchange", "exchange", {
                    "left": STATIC_ROOT, "right": stage_path,
                })
                if exchange_ok and isinstance(exchange_result, dict):
                    checks["exchangeAcknowledged"] = "acknowledged" if exchange_result.get("exchanged") is True else "rejected"
                else:
                    checks["exchangeAcknowledged"] = "unknown"

                root_ok, root_tree = read_tree("verify-static-root-before-stage-removal", STATIC_ROOT)
                stage_ok, stage_tree = read_tree("verify-stage-before-removal", stage_path)
                root_is_original = root_ok and _r4_tree_matches(root_tree, original_projection)
                stage_is_replacement = stage_ok and _r4_tree_matches(stage_tree, replacement_projection)
                stage_is_owner_marked = stage_ok and _r4_has_owner_marker(stage_tree)
                if root_is_original and (stage_is_replacement or stage_is_owner_marked):
                    remove_ok, remove_result = step("remove-owned-static-stage", "remove-stage", {
                        "path": stage_path, "owner": owner, "expectedFiles": expected_files,
                    })
                    if remove_ok and isinstance(remove_result, dict):
                        checks["stageRemovalAcknowledged"] = "acknowledged" if remove_result.get("removed") is True else "rejected"
                    else:
                        checks["stageRemovalAcknowledged"] = "unknown"
                else:
                    skip_step("remove-owned-static-stage", "remove-stage", "post-exchange-ownership-not-proven")
            elif root_is_original and stage_tree is None:
                skip_step("restore-static-root-exchange", "exchange", "root-already-original")
                checks["stageRemovalAcknowledged"] = "not-needed"
                skip_step("remove-owned-static-stage", "remove-stage", "stage-absent")
            elif root_is_original and stage_tree is not None and (stage_is_replacement or stage_is_owner_marked):
                skip_step("restore-static-root-exchange", "exchange", "root-already-original")
                verify_root_ok, verify_root = read_tree("verify-original-root-before-stage-removal", STATIC_ROOT)
                verify_stage_ok, verify_stage = read_tree("verify-owned-stage-before-removal", stage_path)
                root_still_original = verify_root_ok and _r4_tree_matches(verify_root, original_projection)
                stage_still_removable = verify_stage_ok and (
                    _r4_tree_matches(verify_stage, replacement_projection) or _r4_has_owner_marker(verify_stage)
                )
                if root_still_original and stage_still_removable:
                    remove_ok, remove_result = step("remove-owned-static-stage", "remove-stage", {
                        "path": stage_path, "owner": owner, "expectedFiles": expected_files,
                    })
                    if remove_ok and isinstance(remove_result, dict):
                        checks["stageRemovalAcknowledged"] = "acknowledged" if remove_result.get("removed") is True else "rejected"
                    else:
                        checks["stageRemovalAcknowledged"] = "unknown"
                else:
                    skip_step("remove-owned-static-stage", "remove-stage", "pre-removal-ownership-not-proven")
            else:
                # Any other root/stage combination is ambiguous. Do not exchange or delete it.
                skip_step("restore-static-root-exchange", "exchange", "state-ambiguous-or-foreign")
                skip_step("remove-owned-static-stage", "remove-stage", "state-ambiguous-or-foreign")
        else:
            initial_skip_reason = (
                "forward-port-not-free"
                if port_ok and isinstance(port_result, dict) and port_result.get("free") is False
                else "initial-readback-unavailable"
            )
            skip_step("restore-static-root-exchange", "exchange", initial_skip_reason)
            skip_step("remove-owned-static-stage", "remove-stage", initial_skip_reason)
    except Exception as error:
        decision_error_kind = _r4_safe_error_kind(error)
    finally:
        if not has_action_step("exchange"):
            skip_step("restore-static-root-exchange", "exchange", "decision-incomplete")
        if not has_action_step("remove-stage"):
            skip_step("remove-owned-static-stage", "remove-stage", "decision-incomplete")
        probe_ok, probe_result = step("final-owned-probe-check", "cleanup-probe-exchange", {
            "left": probe_left, "right": probe_right, "owner": owner,
        })
        checks["finalProbePathsRemoved"] = bool(
            probe_ok and isinstance(probe_result, dict)
            and probe_result.get("removed") is True and probe_result.get("remaining") is False
        )

        final_stage_ok, final_stage = read_tree("final-stage-readback", stage_path)
        checks["finalStageAbsent"] = final_stage is None if final_stage_ok else None

        final_root_ok, final_root = read_tree("final-static-root-readback", STATIC_ROOT)
        checks["finalStaticRootContentMatches"] = (
            _r4_tree_matches(final_root, original_projection) if final_root_ok else None
        )

        final_port_ok, final_port = step("final-forward-port-check", "port-status", {"port": REMOTE_PORT})
        checks["finalPortFree"] = bool(final_port_ok and isinstance(final_port, dict) and final_port.get("free") is True)

    restored = all(checks[key] is True for key in (
        "finalProbePathsRemoved", "finalStageAbsent", "finalStaticRootContentMatches", "finalPortFree",
    ))
    return {
        "status": "restored" if restored else "unverified",
        "restored": restored,
        "checks": checks,
        "decisionErrorKind": decision_error_kind,
        "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
        "steps": steps,
    }
`;
