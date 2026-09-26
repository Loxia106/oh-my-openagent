#!/usr/bin/env python3
"""Drive a pinned OpenCode TUI under a real PTY and save a bounded capture."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import termios
import time
from pathlib import Path


def strip_ansi(value: str) -> str:
    value = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", value)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--rows", type=int, default=48)
    parser.add_argument("--columns", type=int, default=160)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        parser.error("expected command after --")

    os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)
        raise AssertionError("execvpe returned")

    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.columns, 0, 0))
    os.set_blocking(terminal, False)
    captured = bytearray()
    exit_status: int | None = None
    terminal_closed = False

    def drain(seconds: float) -> None:
        nonlocal exit_status, terminal_closed
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if exit_status is not None:
                break
            ready, _, _ = select.select([terminal], [], [], min(0.15, max(0.0, deadline - time.monotonic())))
            if ready:
                try:
                    chunk = os.read(terminal, 65_536)
                    if chunk:
                        captured.extend(chunk)
                        if len(captured) > 4_000_000:
                            del captured[:-2_000_000]
                    else:
                        terminal_closed = True
                except OSError as error:
                    if error.errno == errno.EIO:
                        terminal_closed = True
                    elif error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                        raise
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                exit_status = status
                break

    def text() -> str:
        return strip_ansi(captured.decode("utf-8", errors="replace"))

    def send(value: bytes) -> None:
        try:
            os.write(terminal, value)
        except OSError as error:
            if error.errno != errno.EIO:
                raise

    initial_deadline = time.monotonic() + 18.0
    while time.monotonic() < initial_deadline and exit_status is None:
        current = text().lower()
        if "omo" in current and "sisyphus" in current:
            break
        drain(0.2)
    initial_text = text().lower()
    sidebar_omo = "omo" in initial_text
    sidebar_agent = "sisyphus" in initial_text
    sidebar_status = bool(re.search(r"sisyphus\s*·\s*idle", initial_text))
    plugin_load_failed = bool(re.search(r"plugin failed\s*:", initial_text, flags=re.IGNORECASE))

    status_dialog = False
    status_palette_entry = False
    status_palette_opened = False
    status_enter_sent = False
    status_escape_sent = False
    btw_dialog = False
    btw_suggestion = False
    btw_tab_sent = False
    btw_enter_sent = False
    btw_escape_sent = False
    if exit_status is None and sidebar_agent:
        send(b"\x10")
        drain(0.6)
        send(b"OMO status")
        palette_deadline = time.monotonic() + 5.0
        while time.monotonic() < palette_deadline and exit_status is None:
            current = text().lower()
            if "omo status" in current and "show the active opencode session" in current:
                status_palette_entry = True
                break
            drain(0.2)
        status_palette_opened = status_palette_entry
        if status_palette_entry and exit_status is None:
            send(b"\r")
            status_enter_sent = True
        dialog_deadline = time.monotonic() + 8.0
        while time.monotonic() < dialog_deadline and exit_status is None:
            current = text().lower()
            if "omo status" in current and "state: idle" in current:
                status_dialog = True
                break
            drain(0.2)
        if status_dialog:
            send(b"\x1b")
            status_escape_sent = True
            drain(0.6)

    if exit_status is None and status_escape_sent:
        send(b"/omo-btw")
        btw_suggestion_deadline = time.monotonic() + 5.0
        while time.monotonic() < btw_suggestion_deadline and exit_status is None:
            current = text().lower()
            if "btw side conversation" in current and "fork the current session" in current:
                btw_suggestion = True
                break
            drain(0.2)
        if btw_suggestion and exit_status is None:
            send(b"\t")
            btw_tab_sent = True
            drain(0.3)
            send(b"\r")
            btw_enter_sent = True
        btw_deadline = time.monotonic() + 10.0
        while time.monotonic() < btw_deadline and exit_status is None:
            current = text().lower()
            if "start a btw side conversation" in current or "what would you like to ask?" in current:
                btw_dialog = True
                break
            drain(0.2)
        if not btw_dialog and btw_suggestion and exit_status is None:
            send(b"\r")
            btw_enter_sent = True
            retry_deadline = time.monotonic() + 5.0
            while time.monotonic() < retry_deadline and exit_status is None:
                current = text().lower()
                if "start a btw side conversation" in current or "what would you like to ask?" in current:
                    btw_dialog = True
                    break
                drain(0.2)
        if btw_dialog:
            send(b"\x1b")
            btw_escape_sent = True
            drain(0.8)

    if exit_status is None:
        send(b"\x03")
        drain(4.0)
    if exit_status is None:
        os.kill(pid, signal.SIGTERM)
        drain(2.0)
    if exit_status is None:
        os.kill(pid, signal.SIGKILL)
        _, exit_status = os.waitpid(pid, 0)

    try:
        while True:
            ready, _, _ = select.select([terminal], [], [], 0.1)
            if not ready:
                break
            chunk = os.read(terminal, 65_536)
            if not chunk:
                break
            captured.extend(chunk)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
    finally:
        os.close(terminal)

    capture = text()
    for secret_name in ("OMO_TUI_QA_PASSWORD", "OMO_TUI_QA_API_KEY"):
        secret = os.environ.get(secret_name)
        if secret:
            capture = capture.replace(secret, "[redacted-test-secret]")
    result = {
        "command": command,
        "terminal": {"rows": args.rows, "columns": args.columns, "term": os.environ["TERM"]},
        "sidebar": {"omoHeading": sidebar_omo, "agentVisible": sidebar_agent, "statusVisible": sidebar_status},
        "pluginLoadFailedDiagnostic": plugin_load_failed,
        "omoStatusDialogRendered": status_dialog,
        "omoStatusPaletteEntryVisible": status_palette_entry,
        "omoStatusPaletteOpened": status_palette_opened,
        "omoStatusEnterSent": status_enter_sent,
        "btwDialogRendered": btw_dialog,
        "btwSuggestionVisible": btw_suggestion,
        "btwTabSent": btw_tab_sent,
        "btwEnterSent": btw_enter_sent,
        "statusEscapeSent": status_escape_sent,
        "btwEscapeSent": btw_escape_sent,
        "childExited": exit_status is not None,
        "childExitStatus": os.waitstatus_to_exitcode(exit_status) if exit_status is not None else None,
        "terminalClosed": terminal_closed,
        "capture": capture,
    }
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
