#!/usr/bin/python3 -I
"""Unprivileged namespace init: forward signals and reap orphaned task processes."""
import os
import signal
import sys


def main():
    child = os.fork()
    if child == 0:
        os.setsid()
        # This PID is later compared with /proc identities by nested shells.
        with open("/proc/self/status") as status:
            pid = next(line.split(":", 1)[1].strip() for line in status if line.startswith("Pid:"))
        os.environ["T3_CREDENTIAL_COMMAND_PID"] = pid
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    def forward(signum, _frame):
        try:
            os.killpg(child, signum)
        except ProcessLookupError:
            pass
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGWINCH):
        signal.signal(signum, forward)
    while True:
        pid, status = os.waitpid(-1, 0)
        if pid == child:
            return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    code = main()
    sys.exit(code if code >= 0 else 128 - code)
