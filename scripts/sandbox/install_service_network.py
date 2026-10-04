#!/usr/bin/python3
"""Install a root-managed service network from an administrator's JSON configuration."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Run as the host administrator")
    spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install.py"))
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    config = json.loads(args.config.read_text())
    owner = config["owner"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*[$]?", owner) or pwd.getpwnam(owner).pw_uid == 0:
        raise ValueError("Choose an ordinary T3 host user")
    dependencies = config.get("networkDependencies", [])
    if not all(re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", name) for name in dependencies):
        raise ValueError("Invalid network dependency")
    mcp_port = config.get("mcpPort", 3773)
    if type(mcp_port) is not int or not 1024 <= mcp_port <= 65535:
        raise ValueError("Invalid T3 MCP port")
    config["reservedPorts"] = sorted(set([*config.get("reservedPorts", []), mcp_port]))
    target = Path("/usr/local/libexec/t3code-service-network")
    installer.install_file(target, Path(__file__).with_name("t3code-service-network.py").read_bytes(), 0o755)
    installer.install_file(Path("/etc/t3code/service-network.json"), json.dumps(config).encode(), 0o644)
    rules = f"{owner} ALL=(root) NOPASSWD: {target} request *\n".encode()
    installer.install_file(Path("/etc/sudoers.d/t3code-service-network"), rules, 0o440)
    subprocess.run(["visudo", "-cf", "/etc/sudoers.d/t3code-service-network"], check=True)
    units = Path("/etc/systemd/system")
    required = " ".join(dependencies)
    unit = f"""[Unit]
Description=T3 Harness private service networks
Requires={required}
After=network-online.target ufw.service {required}
Wants=network-online.target
[Service]
Type=oneshot
ExecStart={target} setup
RemainAfterExit=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
"""
    installer.install_file(units / "t3code-service-network.service", unit.encode(), 0o644)
    relay = "/usr/local/libexec/t3code-mcp-relay.py"
    host_unit = f"""[Unit]
Description=T3 private MCP host relay
After=network.target
[Service]
User={owner}
RuntimeDirectory=t3code-mcp-relay
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=/usr/bin/python3 -I {relay} --listen-unix /run/t3code-mcp-relay/mcp.sock --connect-tcp {mcp_port}
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
"""
    installer.install_file(units / "t3code-mcp-relay-host.service", host_unit.encode(), 0o644)
    relay_units = []
    for profile, network in config["profiles"].items():
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile):
            raise ValueError("Invalid profile name")
        namespace = network["namespace"]
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", namespace):
            raise ValueError("Invalid namespace")
        existing_relay = network.get("relayUnit")
        if existing_relay:
            if not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", existing_relay) or not (units / existing_relay).exists():
                raise ValueError("Existing MCP relay unit is unavailable")
            relay_units.append(existing_relay)
            continue
        name = f"t3code-mcp-relay-{profile}.service"
        contents = f"""[Unit]
Description=T3 private MCP relay for {profile}
Requires=t3code-service-network.service t3code-mcp-relay-host.service
After=t3code-service-network.service t3code-mcp-relay-host.service
[Service]
User={owner}
NetworkNamespacePath=/run/netns/{namespace}
UMask=0077
ExecStart=/usr/bin/python3 -I {relay} --listen-tcp {mcp_port} --connect-unix /run/t3code-mcp-relay/mcp.sock
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
"""
        installer.install_file(units / name, contents.encode(), 0o644)
        relay_units.append(name)
    # A namespace without its authenticated MCP relay is unusable for provider sessions.
    environment = dict(os.environ)
    environment.pop("SUDO_UID", None)
    subprocess.run([str(target), "setup", "--configure-caddy"], env=environment, check=True)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "t3code-service-network.service",
                    "t3code-mcp-relay-host.service", *relay_units], check=True)
    print("Private networks are ready. Add the network and relay units to your T3 server's Requires/After dependencies.")


if __name__ == "__main__":
    main()
