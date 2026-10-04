#!/usr/bin/python3
"""Root-owned private networking and publication broker for T3 Harness instances."""

import argparse
import copy
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tempfile
import time

CONFIG = Path("/etc/t3code/service-network.json")
STATE = Path("/var/lib/t3code-service-network/state.json")
APPLICATIONS = Path("/var/lib/t3code-applications/apps")
PROFILES = Path("/etc/t3code/sandboxes")
SLUG = re.compile(r"[a-z][a-z0-9_-]{0,63}")
DOMAIN = re.compile(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(*args, input=None):
    return subprocess.run(args, input=input, text=True, capture_output=True, check=True).stdout


def trusted_json(path):
    require(not path.is_symlink(), "Configuration cannot be a symlink")
    for parent in (path, *path.parents):
        info = parent.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "Configuration must be root-owned")
    return json.loads(path.read_text())


def atomic_write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    require(not path.is_symlink(), "Cannot replace a symlink")
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(contents)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_config():
    config = trusted_json(CONFIG)
    owner = pwd.getpwnam(config["owner"])
    require(owner.pw_uid > 0, "T3 owner must be a normal user")
    config["ownerUid"] = owner.pw_uid
    config["caddyUid"] = pwd.getpwnam(config.get("caddyUser", "caddy")).pw_uid
    subnet = ipaddress.ip_network(config["privateSubnet"])
    require(subnet.version == 4 and any(subnet.subnet_of(ipaddress.ip_network(cidr))
            for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")),
            "Private service routes must remain inside RFC1918 address space")
    addresses = set()
    namespaces = set()
    for name, network in config["profiles"].items():
        require(SLUG.fullmatch(name), "Invalid profile name")
        profile = trusted_json(PROFILES / f"{name}.json")
        require(profile["ownerUid"] == owner.pw_uid and profile["uid"] > 0, "Incorrect profile owner")
        interface = ipaddress.ip_interface(network["address"])
        require(interface.version == 4 and interface.network.prefixlen == 30 and interface.ip.is_private,
                "Use private IPv4 /30 links")
        require(interface.network.subnet_of(subnet), "Private link must belong to the service subnet")
        gateway = ipaddress.ip_address(network["gateway"])
        require(gateway in interface.network and gateway != interface.ip, "Incorrect private gateway")
        require(str(interface.network) not in addresses, "Private links must not overlap")
        addresses.add(str(interface.network))
        require(SLUG.fullmatch(network["namespace"]) and network["namespace"] not in namespaces,
                "Each profile requires a distinct namespace")
        namespaces.add(network["namespace"])
        network["profile"] = profile
        network["ip"] = str(interface.ip)
        network["hostInterface"] = "t3h-" + hashlib.sha256(name.encode()).hexdigest()[:8]
        network["preserveEgress"] = bool(network.get("preserveEgress", False))
        if network["preserveEgress"]:
            require(profile["network"]["mode"] == "namespace" and
                    profile["network"]["path"] == f"/run/netns/{network['namespace']}",
                    "Preserved egress must already belong to this profile")
    require(DOMAIN.fullmatch(config["publicHost"]), "Invalid public hostname")
    return config


def port(value):
    require(type(value) is int and 1024 <= value <= 65535, "Use an integer port between 1024 and 65535")
    return value


def instance(config, instance_id):
    matches = [(name, entry) for name, entry in config["profiles"].items()
               if entry["profile"]["instanceId"] == instance_id]
    require(len(matches) == 1, "Provider instance has no private service network")
    return matches[0]


def active_shares(state, now):
    return [share for share in state["shares"] if share["expiresAt"] > now]


def mutate(config, state, name, action, payload, now):
    require(isinstance(payload, dict), "Expected a JSON object")
    updated = copy.deepcopy(state)
    updated["shares"] = active_shares(updated, now)
    network = config["profiles"][name]
    if action == "publish":
        require(set(payload) <= {"name", "port", "hostname"}, "Unexpected publication fields")
        require(isinstance(payload.get("name"), str) and SLUG.fullmatch(payload["name"]), "Invalid service name")
        selected_port = port(payload.get("port"))
        require(selected_port not in config.get("reservedPorts", []), "Port belongs to a T3 internal service")
        hostname = payload.get("hostname")
        require(isinstance(hostname, str) and DOMAIN.fullmatch(hostname),
                "Specify a dedicated hostname with DNS pointing to this server")
        require(any(hostname.endswith("." + suffix) for suffix in config.get("allowedDomainSuffixes", [])),
                "Hostname is outside the configured publication domains")
        require(hostname != config["publicHost"] and hostname not in config.get("reservedHosts", []),
                "Hostname belongs to an existing service")
        require(not any(trusted_json(path).get("hostname") == hostname
                        for path in APPLICATIONS.glob("*/application.json")),
                "Hostname belongs to a managed application")
        key = hashlib.sha256(f"{name}/{payload['name']}".encode()).hexdigest()[:32]
        require(not any(item["hostname"] == hostname and item["id"] != key
                        for item in updated["publications"]),
                "Hostname is already published by another service")
        prefix = "/"
        publication = {"id": key, "profile": name, "instanceId": network["profile"]["instanceId"],
                       "name": payload["name"], "port": selected_port, "hostname": hostname,
                       "pathPrefix": prefix, "privateUrl": f"http://{network['ip']}:{selected_port}",
                       "url": f"https://{hostname}{prefix}"}
        updated["publications"] = [item for item in updated["publications"] if item["id"] != key]
        updated["publications"].append(publication)
    elif action == "unpublish":
        require(set(payload) == {"id"}, "Expected a publication id")
        selected = next((item for item in updated["publications"] if item["id"] == payload["id"]), None)
        require(selected is None or selected["profile"] == name, "Cannot remove another instance's publication")
        updated["publications"] = [item for item in updated["publications"] if item["id"] != payload["id"]]
    elif action == "share":
        require(set(payload) <= {"port", "targetInstanceId", "durationMinutes"}, "Unexpected sharing fields")
        selected_port = port(payload.get("port"))
        require(selected_port not in config.get("reservedPorts", []), "Port belongs to a T3 internal service")
        target, _ = instance(config, payload.get("targetInstanceId"))
        require(target != name, "Service is already available to its own instance")
        duration = payload.get("durationMinutes", 60)
        require(type(duration) is int and 1 <= duration <= 1440, "Share for 1 to 1440 minutes")
        key = hashlib.sha256(f"{name}/{target}/{selected_port}".encode()).hexdigest()[:32]
        updated["shares"] = [item for item in updated["shares"] if item["id"] != key]
        updated["shares"].append({"id": key, "profile": name, "targetProfile": target,
                                  "instanceId": network["profile"]["instanceId"],
                                  "targetInstanceId": payload["targetInstanceId"], "port": selected_port,
                                  "privateUrl": f"http://{network['ip']}:{selected_port}",
                                  "expiresAt": now + duration * 60})
    elif action == "unshare":
        require(set(payload) == {"id"}, "Expected a sharing id")
        selected = next((item for item in updated["shares"] if item["id"] == payload["id"]), None)
        require(selected is None or selected["profile"] == name, "Cannot revoke another instance's sharing")
        updated["shares"] = [item for item in updated["shares"] if item["id"] != payload["id"]]
    else:
        require(action == "list" and not payload, "Unknown service operation")
    return updated


def visible(config, state, name, now):
    return {
        "instanceId": config["profiles"][name]["profile"]["instanceId"],
        "privateIp": config["profiles"][name]["ip"],
        "instances": [{"instanceId": entry["profile"]["instanceId"], "profile": other}
                      for other, entry in config["profiles"].items()],
        "publications": [item for item in state["publications"] if item["profile"] == name],
        "shares": [item for item in active_shares(state, now)
                   if item["profile"] == name or item["targetProfile"] == name],
    }


def nft_exists(*args):
    return subprocess.run(["/usr/sbin/nft", "list", *args], capture_output=True).returncode == 0


def ensure_chain(family, table, chain, definition=""):
    if not nft_exists("chain", family, table, chain):
        command("/usr/sbin/nft", "-f", "-", input=f"add chain {family} {table} {chain} {definition}\n")


def ensure_set(family, table, name, type_, timed=False):
    if not nft_exists("set", family, table, name):
        flags = "flags timeout;" if timed else ""
        command("/usr/sbin/nft", "-f", "-", input=f"add set {family} {table} {name} {{ type {type_}; {flags} }}\n")


def ensure_jump(family, table, chain, target):
    listing = command("/usr/sbin/nft", "list", "chain", family, table, chain)
    if f"jump {target}" not in listing:
        command("/usr/sbin/nft", "-f", "-", input=f"insert rule {family} {table} {chain} jump {target}\n")


def share_elements(config, state, now):
    return [f"{config['profiles'][share['targetProfile']]['ip']} . "
            f"{config['profiles'][share['profile']]['ip']} . {share['port']} timeout {max(1, int(share['expiresAt'] - now))}s"
            for share in active_shares(state, now)]


def host_rules(config, state, now):
    lines = ["flush chain ip filter t3_services_forward", "flush chain ip filter t3_services_input",
             "flush chain ip filter t3_services_output", "flush set ip filter t3_services_shares"]
    elements = share_elements(config, state, now)
    if elements:
        lines.append("add element ip filter t3_services_shares { " + ", ".join(elements) + " }")
    forward = "add rule ip filter t3_services_forward "
    # Validate the interface identity before a packet can match a sharing grant.
    for entry in config["profiles"].values():
        lines.append(forward + f'iifname "{entry["hostInterface"]}" ip saddr != {entry["ip"]} drop')
    lines += [forward + 'iifname "t3h-*" oifname "t3h-*" ip saddr . ip daddr . tcp dport @t3_services_shares accept',
              forward + 'iifname "t3h-*" oifname "t3h-*" ip daddr . ip saddr . tcp sport @t3_services_shares accept',
              forward + 'iifname "t3h-*" oifname "t3h-*" drop']
    for entry in config["profiles"].values():
        iface = entry["hostInterface"]
        if entry["preserveEgress"]:
            lines.append(forward + f'iifname "{iface}" drop')
        else:
            # Host metadata, LAN and other private networks are reached through T3 resources.
            lines.append(forward + f'iifname "{iface}" ip daddr {{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, '
                         '127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 } drop')
            lines.append(forward + f'iifname "{iface}" accept')
            lines.append(forward + f'oifname "{iface}" ct state established,related accept')
        lines.append(forward + f'oifname "{iface}" drop')
    lines += ['add rule ip filter t3_services_input iifname "t3h-*" ct state established,related accept',
              'add rule ip filter t3_services_input iifname "t3h-*" drop']
    allowed_users = sorted({0, config.get("ownerUid", 0), config.get("caddyUid", 0)})
    lines += ['add rule ip filter t3_services_output oifname "t3h-*" meta skuid { ' +
              ", ".join(map(str, allowed_users)) + ' } accept',
              'add rule ip filter t3_services_output oifname "t3h-*" drop']
    lines.append("flush chain ip nat t3_services_nat")
    for entry in config["profiles"].values():
        if not entry["preserveEgress"]:
            lines.append(f'add rule ip nat t3_services_nat ip saddr {entry["ip"]} oifname "{config["egressInterface"]}" masquerade')
    return "\n".join(lines) + "\n"


def namespace_rules(config, state, name, now):
    entry = config["profiles"][name]
    table = "claude_guard" if entry["preserveEgress"] else "t3_private"
    prefix = f"inet {table}"
    lines = [f"flush chain {prefix} t3_services_input", f"flush chain {prefix} t3_services_output",
             f"flush set {prefix} t3_services_shares", f"flush set {prefix} t3_services_ports"]
    elements = share_elements(config, state, now)
    if elements:
        lines.append(f"add element {prefix} t3_services_shares {{ " + ", ".join(elements) + " }")
    ports = sorted({item["port"] for item in state["publications"] if item["profile"] == name})
    if ports:
        lines.append(f"add element {prefix} t3_services_ports {{ " + ", ".join(map(str, ports)) + " }")
    for direction in ("input", "output"):
        rule = f"add rule {prefix} t3_services_{direction} "
        lines.append(rule + 'iifname "t3net" ip saddr . ip daddr . tcp dport @t3_services_shares accept' if direction == "input"
                     else rule + 'oifname "t3net" ip saddr . ip daddr . tcp dport @t3_services_shares accept')
        lines.append(rule + ('iifname' if direction == "input" else 'oifname') +
                     ' "t3net" ip daddr . ip saddr . tcp sport @t3_services_shares accept')
        if direction == "input":
            lines.append(rule + f'iifname "t3net" ip saddr {entry["gateway"]} tcp dport @t3_services_ports accept')
            # Replies to explicitly permitted outbound connections.
            lines.append(rule + 'iifname "t3net" ct state established,related accept')
        else:
            lines.append(rule + f'oifname "t3net" ip daddr {entry["gateway"]} ct state established,related accept')
            if not entry["preserveEgress"]:
                lines.append(rule + 'oifname "t3net" meta nfproto ipv4 accept')
        lines.append(rule + ('iifname' if direction == "input" else 'oifname') + ' "t3net" drop' if entry["preserveEgress"]
                     else rule + "return")
    return "\n".join(lines) + "\n"


def apply_firewall(config, state, now):
    require(nft_exists("chain", "ip", "filter", "FORWARD") and nft_exists("chain", "ip", "filter", "INPUT"),
            "Host requires nftables-compatible INPUT and FORWARD chains")
    ensure_chain("ip", "filter", "t3_services_forward")
    ensure_chain("ip", "filter", "t3_services_input")
    ensure_chain("ip", "filter", "t3_services_output", "{ type filter hook output priority -20; policy accept; }")
    ensure_set("ip", "filter", "t3_services_shares", "ipv4_addr . ipv4_addr . inet_service", True)
    ensure_chain("ip", "nat", "t3_services_nat")
    command("/usr/sbin/nft", "-f", "-", input=host_rules(config, state, now))
    ensure_jump("ip", "filter", "FORWARD", "t3_services_forward")
    ensure_jump("ip", "filter", "INPUT", "t3_services_input")
    ensure_jump("ip", "nat", "POSTROUTING", "t3_services_nat")
    for name, entry in config["profiles"].items():
        ns = entry["namespace"]
        def nft(*args, input=None):
            return command("/usr/sbin/ip", "netns", "exec", ns, "/usr/sbin/nft", *args, input=input)
        table = "claude_guard" if entry["preserveEgress"] else "t3_private"
        if not entry["preserveEgress"]:
            listing = subprocess.run(["/usr/sbin/ip", "netns", "exec", ns, "/usr/sbin/nft", "list", "table", "inet", table],
                                     capture_output=True)
            if listing.returncode:
                nft("-f", "-", input=f'table inet {table} {{\n chain input {{ type filter hook input priority 0; policy drop; '
                    'iifname "lo" accept; }\n chain output { type filter hook output priority 0; policy drop; '
                    'oifname "lo" accept; }\n}\n')
        listing = nft("list", "table", "inet", table)
        for direction in ("input", "output"):
            if f"chain t3_services_{direction}" not in listing:
                nft("add", "chain", "inet", table, f"t3_services_{direction}")
        if "set t3_services_shares" not in listing:
            nft("-f", "-", input=f"add set inet {table} t3_services_shares {{ type ipv4_addr . ipv4_addr . inet_service; flags timeout; }}\n")
        if "set t3_services_ports" not in listing:
            nft("-f", "-", input=f"add set inet {table} t3_services_ports {{ type inet_service; }}\n")
        nft("-f", "-", input=namespace_rules(config, state, name, now))
        for direction in ("input", "output"):
            listing = nft("list", "chain", "inet", table, direction)
            if f"jump t3_services_{direction}" not in listing:
                nft("-f", "-", input=f"insert rule inet {table} {direction} jump t3_services_{direction}\n")


def provision_network(config):
    for name, entry in config["profiles"].items():
        ns = entry["namespace"]
        if not Path(f"/run/netns/{ns}").exists():
            require(not entry["preserveEgress"], "Existing fixed egress namespace is unavailable")
            command("/usr/sbin/ip", "netns", "add", ns)
        iface = entry["hostInterface"]
        if not Path(f"/sys/class/net/{iface}").exists():
            command("/usr/sbin/ip", "link", "add", iface, "type", "veth", "peer", "name", "t3np-" + iface[4:])
            command("/usr/sbin/ip", "link", "set", "t3np-" + iface[4:], "netns", ns)
            command("/usr/sbin/ip", "-n", ns, "link", "set", "t3np-" + iface[4:], "name", "t3net")
        command("/usr/sbin/ip", "addr", "replace", entry["gateway"] + "/30", "dev", iface)
        command("/usr/sbin/ip", "link", "set", iface, "up")
        command("/usr/sbin/ip", "-n", ns, "addr", "replace", entry["address"], "dev", "t3net")
        command("/usr/sbin/ip", "-n", ns, "link", "set", "lo", "up")
        command("/usr/sbin/ip", "-n", ns, "link", "set", "t3net", "up")
        command("/usr/sbin/ip", "-n", ns, "route", "replace", config["privateSubnet"], "via", entry["gateway"], "dev", "t3net")
        if not entry["preserveEgress"]:
            command("/usr/sbin/ip", "-n", ns, "route", "replace", "default", "via", entry["gateway"], "dev", "t3net")
            command("/usr/sbin/ip", "netns", "exec", ns, "/usr/sbin/sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1")
            resolver = Path(f"/etc/netns/{ns}/resolv.conf")
            atomic_write(resolver, "nameserver 1.1.1.1\nnameserver 9.9.9.9\n")
            profile = copy.deepcopy(entry["profile"])
            profile["network"] = {"mode": "namespace", "path": f"/run/netns/{ns}", "resolvConf": str(resolver)}
            profile["mcpHost"] = "127.0.0.1"
            atomic_write(PROFILES / f"{name}.json", json.dumps(profile))
    # Only explicitly permitted namespace flows bypass the host's existing forward policy.
    command("/usr/sbin/sysctl", "-q", "-w", "net.ipv4.ip_forward=1")


def caddy_fragment(config, state):
    domains = []
    for publication in state["publications"]:
        upstream = publication["privateUrl"].removeprefix("http://")
        require(publication["hostname"] != config["publicHost"] and
                publication["hostname"] not in config.get("reservedHosts", []),
                "Public services must use a separate hostname from T3 and existing services")
        domains.append(f'{publication["hostname"]} {{\n reverse_proxy {upstream}\n}}\n')
    # Caddy rejects a completely empty file imported by an explicit filename.
    header = "# T3 managed publications\n"
    return header + "\n".join(domains)


def apply_caddy(config, state):
    targets = [(Path("/etc/caddy/t3code-domains.caddy"), caddy_fragment(config, state))]
    previous = [(path, path.read_text() if path.exists() else "") for path, _ in targets]
    if all(path.exists() and path.read_text() == contents for path, contents in targets):
        return
    try:
        for path, contents in targets:
            atomic_write(path, contents)
        command("/usr/bin/caddy", "validate", "--config", "/etc/caddy/Caddyfile")
        command("/usr/bin/systemctl", "reload", "caddy.service")
    except Exception:
        for path, contents in previous:
            atomic_write(path, contents)
        raise


def configure_caddy(config):
    path = Path("/etc/caddy/Caddyfile")
    original = path.read_text()
    require(original.count(config["publicHost"] + " {") == 1, "Expected one public T3 Caddy site")
    updated = original
    if "import /etc/caddy/t3code-domains.caddy" not in updated:
        updated = "import /etc/caddy/t3code-domains.caddy\n\n" + updated
    updated = re.sub(r"^[ \t]*import /etc/caddy/t3code-paths\.caddy\n", "", updated, flags=re.MULTILINE)
    for target in (Path("/etc/caddy/t3code-domains.caddy"),):
        if not target.exists():
            atomic_write(target, "# T3 managed publications\n")
    if updated == original:
        return
    atomic_write(path, updated)
    try:
        command("/usr/bin/caddy", "validate", "--config", str(path))
        command("/usr/bin/systemctl", "reload", "caddy.service")
    except Exception:
        atomic_write(path, original)
        raise


def main():
    require(os.geteuid() == 0, "Use the installed root-owned broker")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    setup = sub.add_parser("setup")
    setup.add_argument("--configure-caddy", action="store_true")
    sub.add_parser("reconcile")
    request = sub.add_parser("request")
    request.add_argument("instance")
    request.add_argument("action", choices=["list", "publish", "unpublish", "share", "unshare"])
    request.add_argument("payload")
    args = parser.parse_args()
    caller = int(os.environ.get("SUDO_UID", "0"))
    if args.operation != "request":
        require(caller == 0, "Network setup requires direct administrator execution")
    config = load_config()
    require(caller in (0, pwd.getpwnam(config["owner"]).pw_uid), "Incorrect T3 host identity")
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE.parent / "broker.lock").open("w") as lock, open("/run/t3code-publications.lock", "a") as route_lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fcntl.flock(route_lock, fcntl.LOCK_EX)
        state = trusted_json(STATE) if STATE.exists() else {"publications": [], "shares": []}
        now = int(time.time())
        if args.operation == "setup":
            provision_network(config)
            if args.configure_caddy:
                configure_caddy(config)
        if args.operation == "request":
            name, _ = instance(config, args.instance)
            require(len(args.payload) <= 16384, "Request is too large")
            updated = mutate(config, state, name, args.action, json.loads(args.payload), now)
        else:
            updated = {**state, "shares": active_shares(state, now)}
        try:
            apply_firewall(config, updated, now)
            apply_caddy(config, updated)
            atomic_write(STATE, json.dumps(updated), 0o600)
        except Exception:
            apply_firewall(config, state, now)
            raise
        if args.operation == "request":
            print(json.dumps(visible(config, updated, name, now)))
        else:
            print(json.dumps({"configured": True, "instances": len(config["profiles"])}))


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(125)
    except (OSError, KeyError, subprocess.CalledProcessError, json.JSONDecodeError):
        print(json.dumps({"error": "Private service networking failed; check the installed host configuration."}), file=sys.stderr)
        sys.exit(125)
