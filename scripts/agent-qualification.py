#!/usr/bin/env python3
"""Replayable, non-prompting agent inventory and ACP health qualification."""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "qualification-artifacts/agent-health/report.json"
STATIC_REPORT = ROOT / "qualification-artifacts/agent-health/static-report.json"
DAEMON = ROOT / "internal/daemon/daemon.go"
CONFIG = ROOT / "internal/daemon/config.go"
FRONTEND = ROOT / "studio-frontend/src/components/studio/terminal-panel-view.tsx"

EXPECTED_DIRECT = ["opencode", "claude", "codex", "kilo", "qwen", "pi"]
EXPECTED_ADVERTISED_ONLY: list[str] = []
EXPECTED_MENU_ONLY = ["kimi", "copilot", "cursor", "openclaw"]

PATH_COMMANDS = {
    "claude": ["claude"], "codex": ["codex"], "gemini": ["gemini"],
    "cursor": ["cursor-agent", "cursor"], "copilot": ["copilot"], "qwen": ["qwen"],
    "opencode": ["opencode"], "openclaw": ["openclaw"], "pi": ["pi"],
    "kilocode": ["kilocode", "kilo"], "kimi": ["kimi"], "kiro": ["kiro"],
    "antigravity": ["agy"],
}
SECRET_NAME = r"(?:token|access[_-]?token|api[_-]?key|authorization|password|client[_-]?secret|secret|credential|private[_-]?key)"
AUTHORIZATION_PATTERN = re.compile(r"(?im)(\bauthorization\s*[:=]\s*)[^\r\n]*")
JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
PROVIDER_SECRET_PATTERN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,})\b")
SECRET_PATTERNS = [
    re.compile(rf"(?i)({SECRET_NAME})(\s*[:=]\s*)([^\s,;]+)"),
    re.compile(rf'(?i)("{SECRET_NAME}"\s*:\s*")[^"]+(\")'),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(rf"(?i)([?&]{SECRET_NAME}=)[^&#\s]+"),
    re.compile(r"(?i)(https?://)[^/\s:@]+:[^@/\s]+@"),
]
SECRET_SCAN_PATTERNS = [
    re.compile(rf'(?i)"{SECRET_NAME}"\s*:\s*"(?!\[REDACTED\])[^\"]+"'),
    re.compile(r"(?im)\bauthorization\s*[:=](?!\s*\[REDACTED\])\s*[^\r\n]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(rf"(?i)[?&]{SECRET_NAME}=(?!\[REDACTED\])[^&#\s]+"),
    re.compile(r"(?i)https?://(?!\[REDACTED\]:\[REDACTED\]@)[^/\s:@]+:[^@/\s]+@"),
    JWT_PATTERN,
    PROVIDER_SECRET_PATTERN,
]


def run_process(
    argv: list[str], timeout: float, cwd: Path = ROOT, stdin: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            argv, cwd=cwd, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, env=env,
        )
    except FileNotFoundError:
        return {"status": "BLOCKED", "reason": "executable_not_found", "duration_ms": 0}
    except OSError as exc:
        return {"status": "FAIL", "reason": sanitize(f"process_start: {exc}"), "duration_ms": 0}
    try:
        out, err = proc.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_process_group(proc.pid)
        out, err = proc.communicate()
        return {"status": "BLOCKED", "reason": "hard_timeout", "duration_ms": int((time.monotonic() - started) * 1000)}
    result = {
        "status": "PASS" if proc.returncode == 0 else "FAIL",
        "exit_code": proc.returncode,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    if proc.returncode != 0:
        result["reason"] = sanitize((err or out).splitlines()[0] if (err or out).splitlines() else "nonzero_exit")
    result["stdout"] = out
    return result


def sanitize(text: str) -> str:
    text = AUTHORIZATION_PATTERN.sub(r"\1[REDACTED]", text)
    text = SECRET_PATTERNS[0].sub(r"\1\2[REDACTED]", text)
    text = SECRET_PATTERNS[1].sub(r"\1[REDACTED]\2", text)
    text = SECRET_PATTERNS[2].sub("[REDACTED]", text)
    text = SECRET_PATTERNS[3].sub(r"\1[REDACTED]", text)
    text = SECRET_PATTERNS[4].sub(r"\1[REDACTED]:[REDACTED]@", text)
    text = JWT_PATTERN.sub("[REDACTED]", text)
    text = PROVIDER_SECRET_PATTERN.sub("[REDACTED]", text)
    return text[:240]


def sanitize_argv(argv: list[str]) -> list[str]:
    sanitized = []
    redact_values = 0
    redact_authorization_values = False
    for arg in argv:
        if redact_authorization_values:
            if not arg.startswith("-"):
                sanitized.append("[REDACTED]")
                continue
            redact_authorization_values = False
        if redact_values:
            sanitized.append("[REDACTED]")
            redact_values = 0
            continue
        lowered = arg.lower().lstrip("-").split("=", 1)[0]
        if re.search(r"token|key|auth|secret|password|credential", lowered):
            if "=" in arg:
                sanitized.append(sanitize(arg))
            else:
                sanitized.append(arg)
                if "authorization" in lowered or lowered in {"auth", "auth-header"}:
                    redact_authorization_values = True
                else:
                    redact_values = 1
        else:
            sanitized.append(sanitize(arg))
    return sanitized


def secret_findings(text: str) -> list[str]:
    return [pattern.pattern for pattern in SECRET_SCAN_PATTERNS if pattern.search(text)]


def kill_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass


def source_inventory() -> dict[str, Any]:
    daemon = DAEMON.read_text()
    frontend = FRONTEND.read_text()
    names_block = re.search(r"names := \[\]string\{(.*?)\n\s*\}", daemon, re.S)
    daemon_candidates = re.findall(r'"([a-z-]+)"', names_block.group(1)) if names_block else []
    menu_block = re.search(r"function agentMenuItems.*?const items = \[(.*?)\] as const", frontend, re.S)
    menu_agents = re.findall(r'agent: "([a-z]+)"', menu_block.group(1)) if menu_block else []
    direct_match = re.search(r'directACPMenuItems.*?new Set\(\[(.*?)\]\)', frontend, re.S)
    direct_supported = re.findall(r'"([a-z_]+)"', direct_match.group(1)) if direct_match else []

    advertised = []
    executables = {}
    for name in daemon_candidates:
        choices = PATH_COMMANDS.get(name, [])
        path = next((shutil.which(choice) for choice in choices if shutil.which(choice)), None)
        if path:
            advertised.append(name)
            executables[name] = path
    direct = [agent for agent in menu_agents if agent in direct_supported]
    advertised_only: list[str] = []
    menu_only = [agent for agent in menu_agents if agent not in direct_supported]
    return {
        "source_files": [str(DAEMON.relative_to(ROOT)), str(FRONTEND.relative_to(ROOT)), str(CONFIG.relative_to(ROOT))],
        "daemon_candidates": daemon_candidates,
        "menu_agents": menu_agents,
        "direct_supported": direct_supported,
        "path_advertised": advertised,
        "advertised_executables": executables,
        "ui_selectable": {"direct_acp": direct, "total": len(direct)},
        "advertised_not_selectable": advertised_only,
        "menu_defined_not_advertised": menu_only,
    }


def load_effective_agents() -> dict[str, dict[str, Any]]:
    result = run_process(["go", "run", "./cmd/qualification-config"], 30)
    if result["status"] != "PASS":
        raise RuntimeError(result.get("reason", "qualification_config_failed"))
    try:
        agents = json.loads(result["stdout"])
    except json.JSONDecodeError as exc:
        raise RuntimeError("qualification_config_invalid_json") from exc
    if not isinstance(agents, dict):
        raise RuntimeError("qualification_config_invalid_agents")
    return agents


def effective_command(config: dict[str, Any]) -> list[str]:
    command = str(config.get("command", ""))
    return [shutil.which(command) or command, *[str(arg) for arg in (config.get("args") or [])]]


def command_record(config: dict[str, Any]) -> dict[str, Any]:
    command = effective_command(config)
    executable = shutil.which(command[0]) or command[0]
    package = next((arg for arg in command[1:] if not arg.startswith("-") and ("@" in arg or arg.endswith("latest"))), None)
    manifest = executable_package(executable)
    if package:
        version = ""
    else:
        package = manifest.get("name")
        version = manifest.get("version", "")
        if not package:
            version_probe = run_process([executable, "--version"], 4) if Path(executable).exists() or shutil.which(executable) else {"status": "BLOCKED"}
            version = sanitize(version_probe.get("stdout", "").splitlines()[0]) if version_probe.get("stdout", "").splitlines() else version
    return {
        "executable": sanitize(executable),
        "launcher_version": version,
        "adapter_version": None,
        "effective_command": sanitize_argv([Path(executable).name, *command[1:]]),
        "package": sanitize(package) if package else None,
        "source": config.get("source", "built_in_default"),
        "env_keys": [str(key) for key in (config.get("env_keys") or [])],
    }


def executable_package(executable: str) -> dict[str, str]:
    try:
        current = Path(executable).resolve().parent
    except OSError:
        return {}
    for directory in [current, *list(current.parents)[:4]]:
        manifest = directory / "package.json"
        if not manifest.is_file():
            continue
        try:
            value = json.loads(manifest.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        return {key: str(value[key]) for key in ("name", "version") if value.get(key)}
    return {}


def raw_acp_probe(
    agent: str, command: list[str], workspace: Path, env: dict[str, str],
) -> dict[str, Any]:
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {}}, "clientInfo": {"name": "agent-qualification", "version": "1"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": str(workspace), "mcpServers": []}},
    ]
    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            command, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, start_new_session=True, bufsize=1, env=env,
        )
    except FileNotFoundError:
        return {"status": "BLOCKED", "reason": "executable_not_found", "duration_ms": 0}
    except OSError as exc:
        return {"status": "FAIL", "reason": sanitize(f"process_start: {exc}"), "duration_ms": 0}
    responses: dict[str, Any] = {}
    timeout = 60 if agent in {"codex", "kilo", "opencode"} else 15
    deadline = started + timeout
    try:
        for message in messages:
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            wanted = str(message["id"])
            while wanted not in responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                assert proc.stdout is not None
                readable, _, _ = select.select([proc.stdout], [], [], remaining)
                if not readable:
                    raise TimeoutError
                line = proc.stdout.readline()
                if not line:
                    raise BrokenPipeError("peer disconnected before ACP response")
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and "id" in item and "method" not in item and ("result" in item or "error" in item):
                    responses[str(item["id"])] = item
    except TimeoutError:
        return {"status": "BLOCKED", "reason": "hard_timeout", "duration_ms": int((time.monotonic() - started) * 1000)}
    except (BrokenPipeError, OSError) as exc:
        return {"status": "FAIL", "reason": sanitize(f"peer_disconnect: {exc}"), "duration_ms": int((time.monotonic() - started) * 1000)}
    finally:
        kill_process_group(proc.pid)
        proc.wait()
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
    result: dict[str, Any] = {"status": "PASS", "duration_ms": int((time.monotonic() - started) * 1000)}
    if "1" not in responses or "2" not in responses:
        result.update(status="FAIL", reason="missing_initialize_or_session_response")
        return result
    if responses["1"].get("error") or responses["2"].get("error"):
        result.update(status="FAIL", reason="acp_error_response")
        return result
    initialize_result = responses["1"].get("result") or {}
    if not isinstance(initialize_result, dict) or not initialize_result.get("protocolVersion"):
        result.update(status="FAIL", reason="initialize_failed", initialized=False)
        return result
    session_result = responses["2"].get("result") or {}
    if not isinstance(session_result, dict):
        result.update(status="FAIL", reason="invalid_session_response")
        return result
    startup = (((session_result.get("_meta") or {}).get("piAcp") or {}).get("startupInfo"))
    agent_info = initialize_result.get("agentInfo") or {}
    result.update(
        initialized=True,
        agent_name=sanitize(str(agent_info.get("name", ""))) if isinstance(agent_info, dict) else "",
        adapter_version=sanitize(str(agent_info.get("version", ""))) if isinstance(agent_info, dict) else "",
        session_created=bool(session_result.get("sessionId")),
        pi_startup_info_meta=isinstance(startup, str),
    )
    if not result["session_created"]:
        result.update(status="FAIL", reason="session_not_created")
    return result


def static_errors(static: dict[str, Any]) -> list[str]:
    matrix = static["ui_selectable"]
    errors = []
    for key, expected in (("direct_acp", EXPECTED_DIRECT),):
        if matrix[key] != expected:
            errors.append(f"{key}={matrix[key]!r}, want {expected!r}")
    if matrix["total"] != len(EXPECTED_DIRECT):
        errors.append(f"total={matrix['total']}, want {len(EXPECTED_DIRECT)}")
    if static["advertised_not_selectable"] != EXPECTED_ADVERTISED_ONLY:
        errors.append("advertised_not_selectable mismatch")
    if static["menu_defined_not_advertised"] != EXPECTED_MENU_ONLY:
        errors.append("menu_defined_not_advertised mismatch")
    return errors


def dynamic_failures(probes: dict[str, Any]) -> list[str]:
    failures = []
    for runtime, agents in probes.items():
        if not isinstance(agents, dict):
            continue
        for agent, result in agents.items():
            if isinstance(result, dict) and result.get("status") in {"FAIL", "BLOCKED"}:
                failures.append(f"{runtime}.{agent}")
    return failures


def retryable_probe_failure(result: dict[str, Any]) -> bool:
    if result.get("status") == "PASS":
        return False
    detail = " ".join(str(result.get(key, "")) for key in ("reason", "error")).lower()
    return "hard_timeout" in detail or "context deadline exceeded" in detail


def probe_with_retry(probe: Any, backoff_seconds: float = 1) -> dict[str, Any]:
    first = probe()
    first["attempts"] = 1
    if not retryable_probe_failure(first):
        return first
    first_failure = {
        key: sanitize(str(first[key])) if isinstance(first.get(key), str) else first[key]
        for key in ("status", "reason", "error", "duration_ms")
        if key in first
    }
    time.sleep(backoff_seconds)
    result = probe()
    result["attempts"] = 2
    result["first_failure"] = first_failure
    return result


def check_exit_code(check: bool, static_failures: list[str], dynamic_errors: list[str]) -> int:
    return 1 if check and (static_failures or dynamic_errors) else 0


def report_path(static_only: bool) -> Path:
    return STATIC_REPORT if static_only else REPORT


def inventory_record(
    agent: str, static: dict[str, Any], effective_agents: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if agent in effective_agents:
        return command_record(effective_agents[agent])
    capability = {"kilo": "kilocode"}.get(agent, agent)
    executable = static["advertised_executables"].get(capability, "")
    version = ""
    if executable:
        probe = run_process([executable, "--version"], 4)
        lines = probe.get("stdout", "").splitlines()
        version = sanitize(lines[0]) if lines else ""
    return {"executable": executable, "launcher_version": version, "adapter_version": None, "effective_command": [], "package": None}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--static-only", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    static = source_inventory()
    errors = static_errors(static)
    effective_agents = load_effective_agents()
    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "static" if args.static_only else "dynamic",
        "static": static,
        "static_check": {"status": "PASS" if not errors else "FAIL", "errors": errors},
        "inventory": {
            agent: inventory_record(agent, static, effective_agents)
            for agent in dict.fromkeys([*static["menu_agents"], *static["advertised_not_selectable"]])
        },
        "probes": {"direct_acp": {}},
        "safety": {"prompt_calls": 0, "model_calls": 0, "hard_timeout_process_groups": True},
    }
    if not args.static_only:
        with tempfile.TemporaryDirectory(prefix="agent-qualification-") as temp:
            workspace = Path(temp)
            config_helper = workspace / "qualification-config"
            config_build = run_process(["go", "build", "-o", str(config_helper), "./cmd/qualification-config"], 30)
            for agent in EXPECTED_DIRECT:
                command = [str(config_helper), "--exec-agent", agent]
                if config_build["status"] != "PASS":
                    report["probes"]["direct_acp"][agent] = {"status": "BLOCKED", "reason": "config_helper_build_failed"}
                else:
                    report["probes"]["direct_acp"][agent] = probe_with_retry(
                        lambda: raw_acp_probe(agent, command, workspace, os.environ.copy())
                    )
                direct_result = report["probes"]["direct_acp"][agent]
                if direct_result.get("status") == "PASS" and direct_result.get("adapter_version"):
                    report["inventory"][agent]["adapter_version"] = direct_result["adapter_version"]
                    report["inventory"][agent]["adapter_name"] = direct_result.get("agent_name", "")
    dynamic_errors = [] if args.static_only else dynamic_failures(report["probes"])
    report["dynamic_check"] = {
        "status": "SKIPPED" if args.static_only else ("FAIL" if dynamic_errors else "PASS"),
        "failures": dynamic_errors,
    }
    report["safety"]["secret_scan"] = {"status": "PASS", "findings": 0}
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    findings = secret_findings(serialized)
    if findings:
        print(json.dumps({"error": "report_secret_scan_failed", "findings": findings}), file=sys.stderr)
        return 1
    output = report_path(args.static_only)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(serialized)
    print(json.dumps({"report": str(output.relative_to(ROOT)), "static_check": report["static_check"], "mode": report["mode"]}))
    return check_exit_code(args.check, errors, dynamic_errors)


if __name__ == "__main__":
    raise SystemExit(main())
