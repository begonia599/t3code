#!/usr/bin/python3 -I
"""Privileged OCI launcher. Install a root-owned copy; never sudo the checkout."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import tempfile
import uuid
import importlib.util
import shutil

_policy_spec = importlib.util.spec_from_file_location("t3_policy", Path(__file__).with_name("t3code_resource_policy.py"))
resource_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(resource_policy)

CONFIG_DIR = Path("/etc/t3code/sandboxes")
STATE_DIR = Path("/var/lib/t3code-sandboxes")
RUNTIME_DIR = Path("/run/t3code-sandboxes")
RUNC = "/usr/sbin/runc"
SHELL_BRIDGE = Path("/usr/local/libexec/t3code-shell-bridge.py")
HARNESS_INIT = Path("/usr/local/libexec/t3code-harness-init.py")
PROVIDER_INSTALL = Path("/usr/local/libexec/t3code-provider-install.py")
GH_BRIDGE = Path("/usr/local/libexec/t3code-gh.py")
DRIVERS = {"claudeAgent", "codex", "grok"}
SLUG = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def checked_slug(value):
    require(isinstance(value, str) and SLUG.fullmatch(value), "Invalid profile or instance name")
    return value


def trusted_path(path):
    """Reject writable parents too: a root-owned file in /tmp is not trusted."""
    path = Path(path)
    for parent in [path, *path.parents]:
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode), "Trusted paths cannot contain symlinks")
        require(info.st_uid == 0 and not info.st_mode & 0o022, "Host configuration must be root-owned")
    return path


def read_json_file(path, owner, max_size=1024 * 1024, *, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode), "Expected a regular JSON file")
        require(info.st_uid == owner, "Incorrect file owner")
        require(not info.st_mode & 0o022, "JSON file cannot be writable by other users")
        require(not private or not info.st_mode & 0o077, "Launch requests must be private")
        require(info.st_size <= max_size, "JSON file is too large")
        with os.fdopen(fd, "r") as stream:
            fd = -1
            result = json.load(stream)
        require(isinstance(result, dict), "Expected a JSON object")
        return result
    finally:
        if fd != -1:
            os.close(fd)


def load_profile(name, caller_uid):
    path = trusted_path(CONFIG_DIR / f"{checked_slug(name)}.json")
    profile = read_json_file(path, 0)
    require(caller_uid in (0, profile["ownerUid"]), "Profile belongs to another T3 host user")
    require(profile["driver"] in DRIVERS, "Unsupported provider")
    require(profile["uid"] > 0 and profile["gid"] > 0, "Providers cannot run as root")
    require(profile["uid"] != profile["ownerUid"], "Provider and T3 identities must differ")
    return profile


def description(profile):
    return {key: profile[key] for key in (
        "instanceId", "driver", "uid", "gid", "home", "providerHome", "defaultCwd", "path",
    )} | {"visiblePaths": list(dict.fromkeys([profile["home"], profile["providerHome"], *profile["workspaces"], *profile["readonlyPaths"], *([profile["softwareDirectory"]] if profile.get("softwareDirectory") else [])]))} | ({"mcpHost": profile["mcpHost"]} if profile.get("mcpHost") else {}) | ({"credentialBrokerDirectory": profile["credentialBrokerDirectory"]} if profile.get("credentialBrokerDirectory") else {}) | ({"softwareDirectory": profile["softwareDirectory"]} if profile.get("softwareDirectory") else {})


def inside(path, root):
    return path == root or root in path.parents


def validate_request(profile, request):
    require(request.get("instanceId") == profile["instanceId"], "Incorrect provider instance")
    require(request.get("driver") == profile["driver"], "Incorrect provider driver")
    argv = request.get("argv")
    require(isinstance(argv, list) and argv, "Expected non-empty argv")
    require(all(isinstance(value, str) and "\0" not in value for value in argv), "Invalid argv")
    cwd = request.get("cwd")
    require(isinstance(cwd, str) and os.path.isabs(cwd), "Expected an absolute working directory")
    resolved = Path(cwd).resolve(strict=True)
    require(resolved.is_dir(), "Working directory is not a directory")
    roots = [Path(path).resolve() for path in [profile["home"], profile["providerHome"], *profile["workspaces"]]]
    require(any(inside(resolved, root) for root in roots), "Working directory is outside the profile")
    env = request.get("env")
    require(isinstance(env, dict), "Expected explicit environment")
    require(all(ENV_NAME.fullmatch(key) and (value is None or isinstance(value, str) and "\0" not in value)
                for key, value in env.items()), "Invalid environment")
    require(env.get("HOME") == profile["home"], "HOME must match the profile")
    provider_key = {"codex": "CODEX_HOME", "claudeAgent": "CLAUDE_CONFIG_DIR", "grok": "GROK_HOME"}[profile["driver"]]
    require(env.get(provider_key) == profile["providerHome"], "Provider home must match the profile")
    return {**request, "cwd": str(resolved)}


def bind_mount(source, destination=None, *, profile=None, readonly=False):
    mount = {
        "source": source, "destination": destination or source, "type": "none",
        "options": ["rbind", "rprivate", "rro" if readonly else "rw", "nosuid", "nodev"],
    }
    if profile:
        # Without a process user namespace, the mount maps on-disk T3 IDs to
        # real execution IDs. This direction differs from a container UID map.
        mount["options"].append("ridmap")
        mount["uidMappings"] = [{"containerID": profile["ownerUid"], "hostID": profile["uid"], "size": 1}]
        mount["gidMappings"] = [{"containerID": profile["ownerGid"], "hostID": profile["gid"], "size": 1}]
    return mount


def make_config(profile, request, rootfs):
    rootfs = Path(rootfs)
    mounts = []
    for path in ("/usr", "/bin", "/sbin", "/lib", "/lib64"):
        if not os.path.exists(path):
            continue
        target = rootfs / path.lstrip("/")
        if os.path.islink(path):
            target.symlink_to(os.readlink(path))
        else:
            mounts.append(bind_mount(path, readonly=True))
    etc = rootfs / "etc"
    etc.mkdir(parents=True, exist_ok=True)
    (etc / "passwd").write_text(f"root:x:0:0:root:/root:/usr/sbin/nologin\nt3h-{profile['uid']}:x:{profile['uid']}:{profile['gid']}:Harness:{profile['home']}:/bin/bash\n")
    (etc / "group").write_text(f"root:x:0:\nt3h-{profile['gid']}:x:{profile['gid']}:\n")
    for path in ("/etc/ssl/certs", "/etc/ssl/openssl.cnf", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/localtime",
                 "/etc/alternatives", "/etc/fonts", "/etc/services", "/etc/protocols", "/etc/java-21-openjdk", "/etc/python3.14"):
        if path == "/etc/resolv.conf" and profile["network"]["mode"] == "namespace":
            # The host's loopback DNS stub is unreachable in a separate netns.
            mounts.append(bind_mount(profile["network"]["resolvConf"], path, readonly=True))
            continue
        if os.path.exists(path):
            mounts.append(bind_mount(str(Path(path).resolve()), path, readonly=True))
    mounts.extend([
        {"destination": "/proc", "type": "proc", "source": "proc", "options": ["nosuid", "nodev", "noexec"]},
        {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "mode=755"]},
        {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]},
        {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "nodev", "mode=1777", "size=256m"]},
        {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777"]},
        {"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755"]},
    ])
    mounts.append(bind_mount(str(HARNESS_INIT), "/t3-harness-init.py", readonly=True))
    for path in profile["readonlyPaths"]:
        # Preserve root-managed software identities and group execute rights.
        # User-owned installations need the T3-to-harness ownership mapping.
        mounts.append(bind_mount(path, profile=profile if Path(path).stat().st_uid != 0 else None, readonly=True))
    for path in dict.fromkeys([profile["home"], profile["providerHome"], *profile["workspaces"]]):
        mounts.append(bind_mount(path, profile=profile))
    if profile.get("softwareDirectory"):
        # Software belongs to the execution user. Project mounts continue to
        # map T3's ownership; the writable install prefix must keep its real UID.
        mounts.append(bind_mount(profile["softwareDirectory"]))
        if profile["driver"] == "grok":
            # Grok installs native binaries under GROK_HOME/bin. Keep its
            # authentication/configuration home on T3's mapped mount while
            # the binary subdirectory retains the execution user's ownership.
            mounts.append(bind_mount(str(Path(profile["softwareDirectory"]) / "native-bin"),
                                     str(Path(profile["providerHome"]) / "bin")))
    if profile.get("credentialBrokerDirectory"):
        mounts.append(bind_mount(profile["credentialBrokerDirectory"], profile=profile, readonly=True))
        native_gh = shutil.which("gh", path=profile["path"])
        if native_gh and GH_BRIDGE.exists():
            mounts.append(bind_mount(str(Path(native_gh).resolve()), "/t3-native-tools/gh", readonly=True))
            mounts.append(bind_mount(str(GH_BRIDGE), "/t3-tools/gh", readonly=True))
            for transport in ("/usr/lib/git-core/git-remote-http", "/usr/libexec/git-core/git-remote-http"):
                if Path(transport).is_file():
                    trusted_path(transport)
                    mounts.append(bind_mount(transport, "/t3-native-tools/git-remote-http", readonly=True))
                    break
        for shell in ("bash", "dash", "sh"):
            original = Path("/usr/bin") / shell
            if original.exists():
                mounts.append(bind_mount(str(original.resolve()), f"/t3-native-shells/{shell}", readonly=True))
        # Bash and sh may be aliases of the same inode. Mount each canonical
        # target once, retaining argv[0] to preserve native shell semantics.
        for target in dict.fromkeys(str((Path("/usr/bin") / shell).resolve()) for shell in ("bash", "dash", "sh") if (Path("/usr/bin") / shell).exists()):
            name = Path(target).name
            shim = rootfs / "t3-shell-bridges" / f"{name}.py"
            shim.parent.mkdir(exist_ok=True)
            shim.write_text(SHELL_BRIDGE.read_text().replace("NATIVE_SHELL_NAME = None", f"NATIVE_SHELL_NAME = {name!r}"))
            shim.chmod(0o755)
            mounts.append(bind_mount(str(shim), target, readonly=True))
    # Overlay protected children after every writable parent mount. Keeping
    # the source checkout under /src must not give a managed Harness authority
    # to replace its own controlling framework.
    policy = resource_policy.load_policy(profile["ownerUid"])
    visible = [profile["home"], profile["providerHome"], *profile["workspaces"], *profile["readonlyPaths"]]
    for index, (path, visibility) in enumerate(resource_policy.protected_mounts(visible, policy, [profile["home"], profile["providerHome"], *profile["workspaces"]])):
        if visibility == "read":
            mounts.append(bind_mount(str(path), profile=profile if path.stat().st_uid != 0 else None, readonly=True))
        else:
            blank = rootfs / "t3-protected" / str(index)
            blank.parent.mkdir(exist_ok=True)
            blank.mkdir() if path.is_dir() else blank.touch()
            mounts.append(bind_mount(str(blank), str(path), readonly=True))
    for mount in mounts:
        target = rootfs / mount["destination"].lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        if mount["type"] == "none" and Path(mount["source"]).is_file():
            target.touch()
        else:
            target.mkdir(exist_ok=True)
    (rootfs / "dev/fd").symlink_to("/proc/self/fd")
    (rootfs / "dev/stdin").symlink_to("/proc/self/fd/0")
    (rootfs / "dev/stdout").symlink_to("/proc/self/fd/1")
    (rootfs / "dev/stderr").symlink_to("/proc/self/fd/2")
    (rootfs / "dev/ptmx").symlink_to("pts/ptmx")
    namespaces = [{"type": kind} for kind in ("mount", "pid", "ipc", "uts")]
    if profile["network"]["mode"] == "namespace":
        namespaces.append({"type": "network", "path": profile["network"]["path"]})
    runtime_roots = [profile["softwareDirectory"]] if profile.get("softwareDirectory") else []
    entry = Path(request["argv"][0])
    if entry.is_absolute() and not any(inside(entry, Path(root)) for root in ("/usr", "/bin", "/sbin", "/lib", "/lib64")):
        runtime_roots.append(str(entry.parent))
    environment = {**request["env"], "T3_CREDENTIAL_RUNTIME_ROOTS": json.dumps(runtime_roots)}
    if profile.get("credentialBrokerDirectory") and shutil.which("gh", path=profile["path"]) and GH_BRIDGE.exists():
        environment["PATH"] = "/t3-tools:" + environment["PATH"]
        # This contains no secret. Resolve the binding only when Git asks its
        # helper, overriding stale native-gh helpers from auth setup-git.
        count = int(environment.get("GIT_CONFIG_COUNT") or "0")
        require(0 <= count <= 256, "Invalid inherited Git configuration count")
        for index, value in enumerate(("", "!/t3-tools/gh auth git-credential"), count):
            environment[f"GIT_CONFIG_KEY_{index}"] = "credential.https://github.com.helper"
            environment[f"GIT_CONFIG_VALUE_{index}"] = value
        environment["GIT_CONFIG_COUNT"] = str(count + 2)
    return {
        "ociVersion": "1.3.0", "root": {"path": str(rootfs), "readonly": True},
        "hostname": "t3-harness",
        "process": {
            "terminal": False, "user": {"uid": profile["uid"], "gid": profile["gid"]},
            "args": ["/usr/bin/python3", "-I", "/t3-harness-init.py", *request["argv"]], "cwd": request["cwd"],
            "env": [f"{key}={value}" for key, value in environment.items() if value is not None],
            "noNewPrivileges": True,
            "capabilities": {key: [] for key in ("bounding", "effective", "inheritable", "permitted", "ambient")},
            "rlimits": [{"type": "RLIMIT_CORE", "soft": 0, "hard": 0}],
        },
        "mounts": mounts,
        "linux": {
            "namespaces": namespaces,
            "resources": {"devices": [
                {"allow": False, "access": "rwm"},
                *[{"allow": True, "type": "c", "major": 1, "minor": minor, "access": "rw"} for minor in (3, 5, 7, 8, 9)],
                {"allow": True, "type": "c", "major": 5, "minor": 2, "access": "rw"},
                {"allow": True, "type": "c", "major": 136, "access": "rw"},
            ]},
            "devices": [{"path": f"/dev/{name}", "type": "c", "major": 1, "minor": minor, "fileMode": 0o666, "uid": 0, "gid": 0}
                        for name, minor in (("null", 3), ("zero", 5), ("full", 7), ("random", 8), ("urandom", 9))],
            "maskedPaths": ["/proc/kcore", "/proc/keys", "/proc/timer_list", "/proc/sched_debug", "/proc/acpi", "/proc/scsi"],
            "readonlyPaths": ["/proc/sys", "/proc/sysrq-trigger", "/proc/irq", "/proc/bus"],
        },
    }


def run_profile(profile, request, runtime_dir=RUNTIME_DIR):
    request = validate_request(profile, request)
    trusted_path(HARNESS_INIT)
    for path in [profile["home"], profile["providerHome"], *profile["workspaces"], *profile["readonlyPaths"]]:
        require(str(Path(path).resolve(strict=True)) == path, "Mount roots must stay canonical")
    if profile["network"]["mode"] == "namespace":
        trusted_path(profile["network"]["path"])
        resolver = trusted_path(profile["network"]["resolvConf"])
        require(resolver.is_file(), "Namespace DNS configuration must be a regular file")
    if profile.get("credentialBrokerDirectory"):
        trusted_path(SHELL_BRIDGE)
        require(Path(profile["credentialBrokerDirectory"]).resolve(strict=True) == Path(profile["credentialBrokerDirectory"]), "Broker directory must stay canonical")
    if profile.get("softwareDirectory"):
        software = Path(profile["softwareDirectory"])
        require(software.resolve(strict=True) == software and software.is_dir(), "Software directory must stay canonical")
        require(software.stat().st_uid == profile["uid"] and not software.stat().st_mode & 0o022,
                "Software must belong exclusively to the execution user")
        require(not any(inside(software, Path(root)) or inside(Path(root), software)
                        for root in [profile["home"], profile["providerHome"], *profile["workspaces"], *profile["readonlyPaths"]]),
                "Software cannot overlap shared or read-only mounts")
        if profile["driver"] == "grok":
            native_bin = software / "native-bin"
            require(native_bin.resolve(strict=True) == native_bin and native_bin.is_dir()
                    and native_bin.stat().st_uid == profile["uid"], "Grok binaries must stay in the instance software directory")
    # Installed CLI aliases often live outside the mounted software tree.
    # Resolve the entry point; its target still has to exist inside the sandbox.
    if os.path.isabs(request["argv"][0]):
        request = {**request, "argv": [str(Path(request["argv"][0]).resolve(strict=True)), *request["argv"][1:]]}
    runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    container_id = f"t3-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="bundle-", dir=runtime_dir) as directory:
        bundle = Path(directory)
        rootfs = bundle / "rootfs"
        rootfs.mkdir()
        if profile["driver"] == "claudeAgent":
            argv = list(request["argv"])
            for index, argument in enumerate(argv[:-1]):
                if argument != "--mcp-config" or not argv[index + 1].lstrip().startswith("{"):
                    continue
                # The official SDK accepts a config file as well as inline
                # JSON. Keep session authorization out of `ps` output.
                config = json.loads(argv[index + 1])
                if not isinstance(config, dict) or "mcpServers" not in config:
                    continue
                target = rootfs / "t3-provider-mcp.json"
                target.write_text(argv[index + 1])
                os.chown(target, profile["uid"], profile["gid"])
                target.chmod(0o600)
                argv[index + 1] = "/t3-provider-mcp.json"
            request = {**request, "argv": argv}
        (bundle / "config.json").write_text(json.dumps(make_config(profile, request, rootfs)))
        command = [RUNC, "--root", str(runtime_dir / "state")]
        child = subprocess.Popen([*command, "run", "--bundle", str(bundle), container_id])
        stopping = False
        def force_stop(_signum, _frame):
            subprocess.run([*command, "kill", "--all", container_id, "SIGKILL"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if child.poll() is None:
                child.kill()
        def stop(signum, _frame):
            nonlocal stopping
            if stopping:
                force_stop(signum, _frame)
                return
            stopping = True
            subprocess.run([*command, "kill", "--all", container_id, signal.Signals(signum).name],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            # PID 1 can ignore default SIGTERM. Finish before the caller's
            # force-kill deadline so the supervisor survives to clean up.
            signal.setitimer(signal.ITIMER_REAL, 1)
        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        previous[signal.SIGALRM] = signal.signal(signal.SIGALRM, force_stop)
        try:
            return child.wait()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            subprocess.run([*command, "delete", "--force", container_id], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def provision(args):
    owner = pwd.getpwnam(args.owner)
    require(owner.pw_uid > 0, "T3 must use a non-root host user")
    name = checked_slug(args.profile)
    instance = checked_slug(args.instance)
    CONFIG_DIR.mkdir(parents=True, mode=0o755, exist_ok=True)
    path = CONFIG_DIR / f"{name}.json"
    existing = None
    if path.exists():
        existing = load_profile(name, 0)
        require(existing["instanceId"] == instance and existing["ownerUid"] == owner.pw_uid and existing["driver"] == args.driver,
                "Cannot rebind an existing profile")
    username = args.execution_user or (pwd.getpwuid(existing["uid"]).pw_name if existing else
        "t3h_" + hashlib.sha256(f"{owner.pw_uid}:{name}".encode()).hexdigest()[:16])
    try:
        identity = pwd.getpwnam(username)
    except KeyError:
        require(not args.execution_user, "The selected execution user must already exist")
        subprocess.run(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", username], check=True)
        identity = pwd.getpwnam(username)
    require(identity.pw_uid > 0 and identity.pw_uid != owner.pw_uid, "Choose an independent non-root execution user")
    if existing:
        require(existing["uid"] == identity.pw_uid and existing["gid"] == identity.pw_gid, "Cannot change an existing profile identity")
    for other in CONFIG_DIR.glob("*.json"):
        if other != path:
            require(read_json_file(trusted_path(other), 0)["uid"] != identity.pw_uid, "Execution users cannot be shared by profiles")
    personal = STATE_DIR / str(owner.pw_uid) / "home"
    private = STATE_DIR / str(owner.pw_uid) / "instances" / name
    broker = STATE_DIR / str(owner.pw_uid) / "bridges" / name
    for directory in (personal, private, broker):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(directory.resolve() == directory, "State directories cannot contain symlinks")
        os.chown(directory, owner.pw_uid, owner.pw_gid)
        directory.chmod(0o700)
    software_parent = STATE_DIR / "software"
    software_parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    trusted_path(software_parent)
    software = software_parent / name
    software.mkdir(exist_ok=True, mode=0o755)
    require(software.resolve() == software, "Software directories cannot contain symlinks")
    require(software.stat().st_uid in (0, identity.pw_uid), "Software belongs to a different execution user")
    os.chown(software, identity.pw_uid, identity.pw_gid)
    software.chmod(0o755)
    native_bin = software / "native-bin"
    native_bin.mkdir(exist_ok=True, mode=0o755)
    require(native_bin.resolve() == native_bin, "Native binary directory cannot contain symlinks")
    os.chown(native_bin, identity.pw_uid, identity.pw_gid)
    workspaces = args.workspace or (existing["workspaces"] if existing else [])
    readonly_paths = args.readonly or (existing["readonlyPaths"] if existing else [])
    for root in workspaces + readonly_paths:
        require(Path(root).is_absolute() and Path(root).is_dir(), "Mount roots must be existing absolute directories")
        require(Path(root).resolve() != Path("/"), "Cannot expose the host root")
    # Re-provisioning for a new bridge/toolchain must not replace a fixed
    # egress namespace with host networking when no network flags were given.
    network = existing["network"] if existing else {"mode": "host"}
    mcp_host = args.mcp_host or (existing.get("mcpHost") if existing else None)
    if args.network_namespace:
        namespace = Path(args.network_namespace)
        require(namespace.parent == Path("/run/netns"), "Use a named network namespace in /run/netns")
        trusted_path(namespace)
        require(mcp_host, "An isolated network requires a reachable T3 MCP host")
        resolver = trusted_path(args.resolv_conf or Path("/etc/netns") / namespace.name / "resolv.conf")
        require(resolver.is_file(), "Namespace DNS configuration must be a regular file")
        network = {"mode": "namespace", "path": str(namespace), "resolvConf": str(resolver)}
    else:
        require(not args.resolv_conf, "A separate resolver requires a network namespace")
    if mcp_host:
        require(re.fullmatch(r"[A-Za-z0-9.-]+", mcp_host), "MCP host must be a hostname or IPv4 address")
    base_path = args.path or (existing["path"] if existing else "/usr/local/bin:/usr/bin:/bin")
    instance_path = ":".join(dict.fromkeys([str(software / "bin"), str(software / "toolchain/bin"), *base_path.split(":")]))
    profile = {
        "instanceId": instance, "driver": args.driver, "ownerUid": owner.pw_uid, "ownerGid": owner.pw_gid,
        "uid": identity.pw_uid, "gid": identity.pw_gid, "home": str(personal), "providerHome": str(private),
        "defaultCwd": existing["defaultCwd"] if existing and not args.workspace else str(personal),
        "workspaces": [str(Path(root).resolve()) for root in workspaces],
        "readonlyPaths": [str(Path(root).resolve()) for root in readonly_paths],
        "softwareDirectory": str(software),
        "path": instance_path,
        "network": network, **({"mcpHost": mcp_host} if mcp_host else {}),
        "credentialBrokerDirectory": str(broker),
    }
    fd, temporary = tempfile.mkstemp(dir=CONFIG_DIR, prefix=".profile-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(profile, stream)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps(description(profile)))


def main():
    require(os.geteuid() == 0, "The launcher requires root; T3 itself must remain unprivileged")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    describe = sub.add_parser("describe")
    describe.add_argument("profile")
    describe.add_argument("instance")
    describe.add_argument("driver")
    run = sub.add_parser("run")
    run.add_argument("profile")
    run.add_argument("request")
    install = sub.add_parser("install")
    install.add_argument("profile")
    install.add_argument("--version", default="latest")
    setup = sub.add_parser("provision")
    setup.add_argument("profile")
    setup.add_argument("--owner", required=True)
    setup.add_argument("--execution-user", help="Reuse an existing independent Linux user")
    setup.add_argument("--instance", required=True)
    setup.add_argument("--driver", required=True, choices=sorted(DRIVERS))
    setup.add_argument("--workspace", action="append", default=[])
    setup.add_argument("--readonly", action="append", default=[])
    setup.add_argument("--path", help="Keep the existing PATH by default, or use system tools for a new profile")
    setup.add_argument("--network-namespace")
    setup.add_argument("--resolv-conf", help="Root-owned DNS file; defaults to /etc/netns/NAME/resolv.conf")
    setup.add_argument("--mcp-host")
    args = parser.parse_args()
    if args.action == "provision":
        provision(args)
        return 0
    caller = int(os.environ.get("SUDO_UID", os.getuid()))
    profile = load_profile(args.profile, caller)
    if args.action == "describe":
        require(profile["instanceId"] == args.instance and profile["driver"] == args.driver, "Incorrect provider instance")
        print(json.dumps(description(profile)))
        return 0
    if args.action == "install":
        trusted_path(PROVIDER_INSTALL)
        require(profile.get("softwareDirectory"), "Provision an instance-owned software directory first")
        require(re.fullmatch(r"latest|[0-9]+\.[0-9]+\.[0-9]+", args.version), "Invalid provider version")
        software = profile["softwareDirectory"]
        provider_key = {"codex": "CODEX_HOME", "claudeAgent": "CLAUDE_CONFIG_DIR", "grok": "GROK_HOME"}[profile["driver"]]
        environment = {"HOME": profile["home"], provider_key: profile["providerHome"], "PATH": profile["path"],
                       "NPM_CONFIG_PREFIX": software, "NPM_CONFIG_CACHE": software + "/.npm-cache",
                       "NPM_CONFIG_USERCONFIG": profile["providerHome"] + "/npmrc", "LANG": "C.UTF-8"}
        return run_profile(profile, {"instanceId": profile["instanceId"], "driver": profile["driver"],
            "argv": ["/usr/bin/python3", "-I", str(PROVIDER_INSTALL), profile["driver"], args.version],
            "cwd": profile["defaultCwd"], "env": environment})
    return run_profile(profile, read_json_file(args.request, caller, private=True))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, PermissionError, OSError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError):
        # Never echo request values, argv or an inherited credential in validation errors.
        print("T3 sandbox launch failed. Check the host profile, mounts and runtime.", file=sys.stderr)
        sys.exit(125)
