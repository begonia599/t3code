/** Runs inside the instance sandbox, so the CLI's terminal has the same identity and network. */
export const providerLoginPty = String.raw`
import errno, fcntl, os, pty, selectors, signal, struct, sys, termios

pid, master = pty.fork()
if pid == 0:
    attrs = termios.tcgetattr(0)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(0, termios.TCSANOW, attrs)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 4096, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

def stop(signum, frame):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
status = None
try:
    while True:
        for key, _ in selector.select():
            try:
                data = os.read(key.fd, 65536)
            except OSError as error:
                if key.fd == master and error.errno == errno.EIO:
                    data = b""
                else:
                    raise
            if not data:
                if key.fd == master:
                    _, status = os.waitpid(pid, 0)
                    sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
                selector.unregister(0)
                stop(signal.SIGTERM, None)
                continue
            target = 1 if key.fd == master else master
            while data:
                data = data[os.write(target, data):]
finally:
    selector.close()
    os.close(master)
    if status is None:
        stop(signal.SIGKILL, None)
        os.waitpid(pid, 0)
`;
