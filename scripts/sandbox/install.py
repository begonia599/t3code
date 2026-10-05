#!/usr/bin/python3
"""Install the root-owned launcher and a narrow sudo rule for the T3 host user."""

import argparse
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile


def install_file(target, contents, mode):
    for parent in [target.parent, *target.parent.parents]:
        info = parent.lstat()
        if parent.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Installation parents must be root-owned and not writable by others")
    descriptor, temporary = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Run the installer as root")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*[$]?", args.owner) or pwd.getpwnam(args.owner).pw_uid == 0:
        raise ValueError("Choose a non-root T3 host user")
    subprocess.run(["/usr/sbin/runc", "--version"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["/usr/bin/python3", "-I", "-c", "from cryptography.hazmat.primitives.ciphers.aead import AESGCM"], check=True)
    target = Path("/usr/local/libexec/t3code-sandbox")
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    rules = f"{args.owner} ALL=(root) NOPASSWD: {target} describe *, {target} run *, {target} install *\n".encode()
    with tempfile.NamedTemporaryFile() as temporary:
        temporary.write(rules)
        temporary.flush()
        subprocess.run(["/usr/sbin/visudo", "-cf", temporary.name], check=True, stdout=subprocess.DEVNULL)
    install_file(target, Path(__file__).with_name("t3code-sandbox.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code_resource_policy.py"), Path(__file__).with_name("t3code_resource_policy.py").read_bytes(), 0o644)
    install_file(Path("/usr/local/libexec/t3code-gh.py"), Path(__file__).with_name("t3code-gh.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code-applications"), Path(__file__).with_name("t3code-applications.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code_systemd.py"), Path(__file__).with_name("t3code_systemd.py").read_bytes(), 0o644)
    install_file(Path("/usr/local/libexec/t3code-shell-bridge.py"), Path(__file__).with_name("t3code-shell-bridge.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code-harness-init.py"), Path(__file__).with_name("t3code-harness-init.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/bin/t3-resource"), Path(__file__).with_name("t3-resource.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code-mcp-relay.py"), Path(__file__).with_name("t3code-mcp-relay.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code-provider-install.py"), Path(__file__).with_name("t3code-provider-install.py").read_bytes(), 0o755)
    install_file(Path("/usr/local/libexec/t3code-service-network"), Path(__file__).with_name("t3code-service-network.py").read_bytes(), 0o755)
    service_rules = f"{args.owner} ALL=(root) NOPASSWD: /usr/local/libexec/t3code-service-network request *\n".encode()
    with tempfile.NamedTemporaryFile() as temporary:
        temporary.write(service_rules)
        temporary.flush()
        subprocess.run(["/usr/sbin/visudo", "-cf", temporary.name], check=True, stdout=subprocess.DEVNULL)
    install_file(Path("/etc/sudoers.d/t3code-service-network"), service_rules, 0o440)
    application_rules = f"{args.owner} ALL=(root) NOPASSWD: /usr/local/libexec/t3code-applications request *\n".encode()
    with tempfile.NamedTemporaryFile() as temporary:
        temporary.write(application_rules)
        temporary.flush()
        subprocess.run(["/usr/sbin/visudo", "-cf", temporary.name], check=True, stdout=subprocess.DEVNULL)
    install_file(Path("/etc/sudoers.d/t3code-applications"), application_rules, 0o440)
    install_file(Path("/etc/sudoers.d/t3code-sandbox"), rules, 0o440)
    print(f"Installed {target}. Provision a profile before enabling sandbox execution in Settings.")


if __name__ == "__main__":
    main()
