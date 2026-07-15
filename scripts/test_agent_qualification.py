import importlib.util
import os
import signal
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "agent_qualification", Path(__file__).with_name("agent-qualification.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class DynamicFailuresTest(unittest.TestCase):
    def test_collects_fail_and_blocked_leaf_probes(self) -> None:
        probes = {
            "direct_acp": {"pi": {"status": "FAIL"}, "qwen": {"status": "BLOCKED"}},
        }
        self.assertEqual(
            MODULE.dynamic_failures(probes),
            ["direct_acp.pi", "direct_acp.qwen"],
        )

    def test_all_pass_has_no_failures(self) -> None:
        self.assertEqual(
            MODULE.dynamic_failures({"direct_acp": {"codex": {"status": "PASS"}}}),
            [],
        )

    def test_retry_diagnostic_does_not_fail_successful_cell(self) -> None:
        result = MODULE.probe_with_retry(
            iter([
                {"status": "BLOCKED", "reason": "hard_timeout"},
                {"status": "PASS", "session_created": True},
            ]).__next__,
            backoff_seconds=0,
        )
        self.assertEqual(
            MODULE.dynamic_failures({"direct_acp": {"codex": result}}),
            [],
        )

    def test_check_exit_code_fails_for_static_or_dynamic_failures(self) -> None:
        self.assertEqual(MODULE.check_exit_code(True, ["static"], []), 1)
        self.assertEqual(MODULE.check_exit_code(True, [], ["direct_acp.pi"]), 1)
        self.assertEqual(MODULE.check_exit_code(True, [], ["direct_acp.qwen"]), 1)
        self.assertEqual(MODULE.check_exit_code(True, [], []), 0)
        self.assertEqual(MODULE.check_exit_code(False, ["static"], ["dynamic"]), 0)

    def test_sanitizes_secret_shapes_and_command_values(self) -> None:
        command = MODULE.sanitize_argv([
            "agent", "--token", "secret-value", "--url=https://user:pass@x.test/?api_key=hidden",
            "--client-secret", "client-value", "--authorization", "Bearer",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123", "ghp_abcdefghijklmnopqrstuvwxyz",
            "sk-abcdefgh1234",
        ])
        text = " ".join(command)
        self.assertNotIn("secret-value", text)
        self.assertNotIn("hidden", text)
        self.assertNotIn("user:pass", text)
        self.assertNotIn("client-value", text)
        self.assertNotIn("eyJhbGci", text)
        self.assertNotIn("ghp_", text)
        self.assertNotIn("sk-abcdefgh1234", text)
        self.assertEqual(MODULE.secret_findings(text), [])

    def test_sanitizes_authorization_header_scheme_and_credential(self) -> None:
        hostile = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"
        sanitized = MODULE.sanitize(hostile)
        self.assertEqual(sanitized, "Authorization: [REDACTED]")
        self.assertEqual(MODULE.secret_findings(sanitized), [])

    def test_sanitizes_non_bearer_authorization_and_credential_args(self) -> None:
        hostile = (
            "request failed\nAuthorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE "
            "SignedHeaders=host Signature=deadbeef\nresponse failed"
        )
        sanitized = MODULE.sanitize(hostile)
        self.assertEqual(
            sanitized,
            "request failed\nAuthorization: [REDACTED]\nresponse failed",
        )
        argv = MODULE.sanitize_argv([
            "agent", "--authorization", "AWS4-HMAC-SHA256", "Credential=AKIAEXAMPLE",
            "--model", "test-model", "--private-key", "private-value",
        ])
        self.assertEqual(
            argv,
            ["agent", "--authorization", "[REDACTED]", "[REDACTED]", "--model", "test-model", "--private-key", "[REDACTED]"],
        )
        self.assertEqual(MODULE.secret_findings(" ".join(argv)), [])

    def test_static_and_dynamic_reports_are_isolated(self) -> None:
        self.assertNotEqual(MODULE.report_path(True), MODULE.report_path(False))
        self.assertEqual(MODULE.report_path(True).name, "static-report.json")
        self.assertEqual(MODULE.report_path(False).name, "report.json")

    def test_raw_probe_contains_early_peer_disconnect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.raw_acp_probe(
                "codex", [sys.executable, "-c", "pass"], Path(directory), os.environ.copy()
            )
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("peer_disconnect", result["reason"])

    def test_raw_probe_requires_created_session(self) -> None:
        program = """
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    result = {"protocolVersion": 1} if message["id"] == 1 else {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
    if message["id"] == 2:
        break
"""
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.raw_acp_probe(
                "codex", [sys.executable, "-u", "-c", program], Path(directory), os.environ.copy()
            )
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["reason"], "session_not_created")

    def test_cleanup_kills_descendant_after_parent_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            child_pid_path = Path(directory) / "child.pid"
            program = """
import pathlib, subprocess, sys
child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(30)"],
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
"""
            result = MODULE.raw_acp_probe(
                "codex",
                [sys.executable, "-c", program, str(child_pid_path)],
                Path(directory),
                os.environ.copy(),
            )
            self.assertEqual(result["status"], "FAIL")
            child_pid = int(child_pid_path.read_text())
            deadline = __import__("time").monotonic() + 2
            while __import__("time").monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                __import__("time").sleep(0.01)
            else:
                os.kill(child_pid, signal.SIGKILL)
                self.fail(f"descendant {child_pid} survived early-parent cleanup")

    def test_kill_process_group_ignores_exit_race(self) -> None:
        process = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        process.wait()
        MODULE.kill_process_group(process.pid)

    def test_retry_records_first_transient_failure_then_passes(self) -> None:
        results = iter([
            {"status": "BLOCKED", "reason": "hard_timeout", "duration_ms": 100},
            {"status": "PASS", "session_created": True},
        ])
        result = MODULE.probe_with_retry(lambda: next(results), backoff_seconds=0)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["first_failure"]["reason"], "hard_timeout")

    def test_retry_leaves_persistent_failure_failed(self) -> None:
        calls = []

        def fail() -> dict[str, object]:
            calls.append(1)
            return {"status": "FAIL", "error": "context deadline exceeded"}

        result = MODULE.probe_with_retry(fail, backoff_seconds=0)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(len(calls), 2)

    def test_retry_does_not_repeat_non_transient_failure(self) -> None:
        result = MODULE.probe_with_retry(
            lambda: {"status": "FAIL", "reason": "session_not_created"},
            backoff_seconds=0,
        )
        self.assertEqual(result["attempts"], 1)


if __name__ == "__main__":
    unittest.main()
