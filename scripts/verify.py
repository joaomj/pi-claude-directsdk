#!/usr/bin/env python3
"""Run verification through the user's installed Pi, never provider internals."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=("startup", "fresh", "session"))
    parser.add_argument("--pi", default=os.environ.get("PI_VERIFY_PI", "pi"), help="Installed Pi executable")
    parser.add_argument("--extension", type=Path, default=ROOT / "extensions/claude-directsdk/index.ts")
    parser.add_argument("--model", default="claude-directsdk/claude-haiku-5-5")
    parser.add_argument("--session", type=Path, help="Existing session to snapshot and fork")
    parser.add_argument("--paid", action="store_true", help="Approve real model requests and subscription usage")
    parser.add_argument("--timeout", type=float, default=120, help="Scenario deadline in seconds")
    args = parser.parse_args()
    if args.scenario != "startup" and not args.paid:
        parser.error("fresh and session require --paid; they make real model requests")
    if args.scenario == "session" and args.session is None:
        parser.error("session requires --session PATH")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def run(args):
    # npm prepends repository dependencies to PATH. They are not the user's Pi.
    installed_path = os.pathsep.join(part for part in os.environ.get("PATH", "").split(os.pathsep)
                                    if "node_modules" not in Path(part).parts)
    executable = shutil.which(args.pi, path=installed_path)
    if executable is None:
        raise RuntimeError(f"Pi executable not found: {args.pi}; set --pi to your installed executable")
    extension = args.extension.resolve(strict=True)
    directory = Path(tempfile.mkdtemp(prefix="pi-directsdk-verify-"))
    os.chmod(directory, 0o700)
    log = directory / "summary.jsonl"

    def report(data):
        line = json.dumps(data, ensure_ascii=False)
        print(line, flush=True)
        with log.open("a") as output:
            output.write(line + "\n")
        os.chmod(log, 0o600)

    report({"scenario": args.scenario, "pi": executable, "artifacts": str(directory)})
    try:
        env = dict(os.environ)
        # Pi loads CLI extensions before configured packages. A configured installed
        # copy would overwrite the working checkout. Select only one DirectSDK copy.
        original_agent = Path(env.get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent")).expanduser().resolve(strict=True)
        agent = directory / "agent"
        agent.mkdir()
        for source in original_agent.iterdir():
            if source.name in ("sessions", "state"):
                continue
            target = agent / source.name
            if source.is_file():
                shutil.copyfile(source, target)
                os.chmod(target, 0o600)
            else:
                target.symlink_to(source, target_is_directory=source.is_dir())
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        def is_directsdk(resource):
            source = resource.get("source", "") if isinstance(resource, dict) else resource
            return isinstance(source, str) and "pi-claude-directsdk" in source
        settings["packages"] = [resource for resource in settings.get("packages", []) if not is_directsdk(resource)]
        settings["extensions"] = [resource for resource in settings.get("extensions", []) if not is_directsdk(resource)]
        settings["extensions"].append(str(extension))
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
        os.chmod(settings_path, 0o600)
        env["PI_CODING_AGENT_DIR"] = str(agent)
        env["PI_VERIFY_TRACE"] = str(directory / "native.jsonl")
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --import " +
                               shlex.quote(str(ROOT / "scripts/trace-native.mjs"))).strip()
        command = [executable]
        if args.scenario == "startup":
            command += ["--offline", "--list-models", "claude-directsdk"]
        else:
            sessions = directory / "sessions"
            sessions.mkdir()
            command += ["--mode", "json", "--print", "--model", args.model,
                        "--thinking", "minimal", "--session-dir", str(sessions)]
            if args.scenario == "session":
                session_source = args.session.resolve(strict=True)
                snapshot = directory / "input-session.jsonl"
                # All entries remain intact; no selected errors or synthetic history.
                data = session_source.read_bytes()
                for line in data.split(b"\n"):
                    if line:
                        json.loads(line)
                snapshot.write_bytes(data)
                os.chmod(snapshot, 0o600)
                command += ["--fork", str(snapshot)]
                report({"session_snapshot_bytes": len(data), "source_session": str(session_source)})
            command += ["--", "For this verification only, reply exactly hi. Do not call tools."]

        # Use the real working folder, copied settings/credentials, and tools.
        # Only the DirectSDK extension source changes; no provider is fabricated.
        started = time.monotonic()
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env, start_new_session=True)
        state = {"assistant": None, "stderr_bytes": 0, "stdout_lines": 0}
        failures = []

        def consume_stdout():
            try:
                for line in process.stdout:
                    state["stdout_lines"] += 1
                    if args.scenario == "startup" or not line.startswith(b"{"):
                        continue
                    event = json.loads(line)
                    if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                        state["assistant"] = event["message"]
            except Exception as error:
                failures.append(error)

        def consume_stderr():
            try:
                while chunk := process.stderr.read(8192):
                    state["stderr_bytes"] += len(chunk)
            except Exception as error:
                failures.append(error)

        threads = [threading.Thread(target=consume_stdout), threading.Thread(target=consume_stderr)]
        for thread in threads:
            thread.start()
        timed_out = False
        try:
            process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # Give Pi a chance to abort its supervised Claude process first.
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                trace_path = directory / "native.jsonl"
                records = [json.loads(line) for line in trace_path.read_text().splitlines()] if trace_path.exists() else []
                started_pids = {row["pid"] for row in records if row.get("kind") == "claude-spawn" and row.get("pid")}
                exited_pids = {row["pid"] for row in records if row.get("kind") == "claude-exit" and row.get("pid")}
                for pid in started_pids - exited_pids:
                    try:
                        if os.getpgid(pid) == pid:
                            os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # The observed child has already exited.
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        finally:
            for thread in threads:
                thread.join(timeout=5)
            process.stdout.close()
            process.stderr.close()
        if any(thread.is_alive() for thread in threads):
            raise RuntimeError("Pi descendants kept output streams open after the deadline")
        if failures:
            raise RuntimeError(f"Cannot read Pi protocol: {failures[0]}") from failures[0]

        trace = directory / "native.jsonl"
        records = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
        # Replay acknowledgments are counted, but only final results need details.
        final_results = [row for row in records if row.get("kind") == "native-result" and row.get("turns") != 0]
        message = state["assistant"]
        success = process.returncode == 0 and not timed_out
        if args.scenario == "startup":
            success = success and not any(row.get("kind", "").startswith("claude-") for row in records)
        else:
            text = "".join(block.get("text", "") for block in (message or {}).get("content", [])
                           if block.get("type") == "text")
            success = success and message is not None and message.get("stopReason") == "stop" and text.strip().lower() == "hi"
        report({"success": success, "exit_code": process.returncode, "timed_out": timed_out,
                "seconds": round(time.monotonic() - started, 3), "stderr_bytes": state["stderr_bytes"],
                "assistant_stop": (message or {}).get("stopReason"),
                "assistant_error": (message or {}).get("errorMessage"),
                "usage": (message or {}).get("usage"),
                "replay_acknowledgments": sum(row.get("kind") == "native-result" and row.get("turns") == 0 for row in records),
                "native_final_results": final_results})
        if not success:
            raise RuntimeError(f"{args.scenario} failed; inspect {log} and {trace}")
    finally:
        # Pi-generated forks can contain private transcript data. Remove them and
        # the input snapshot after the run; retain only bounded diagnostic summaries.
        for path in (directory / "sessions", directory / "input-session.jsonl", directory / "agent"):
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()


if __name__ == "__main__":
    os.umask(0o077)
    try:
        run(arguments())
    except Exception as error:
        print(f"Verification failed: {error}", flush=True)
        raise SystemExit(1)
