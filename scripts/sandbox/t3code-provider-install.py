#!/usr/bin/python3 -I
"""Bootstrap official provider packages inside their unprivileged instance environment."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

PACKAGES = {"claudeAgent": "@anthropic-ai/claude-code", "codex": "@openai/codex", "grok": "@xai-official/grok"}


def main():
    driver, version = sys.argv[1:]
    if driver not in PACKAGES or not re.fullmatch(r"latest|[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Choose a supported provider version")
    prefix = Path(os.environ["NPM_CONFIG_PREFIX"])
    if os.geteuid() == 0 or prefix.stat().st_uid != os.geteuid():
        raise ValueError("Install as the instance user in its own software directory")
    os.umask(0o022)
    toolchain = prefix / "toolchain"
    binaries = toolchain / "bin"
    binaries.mkdir(parents=True, exist_ok=True)
    node = binaries / "node"
    if not node.exists():
        source = shutil.which("node")
        if not source:
            raise ValueError("Expose an installed Node runtime in the sandbox PATH first")
        shutil.copy2(source, node)
    npm_directory = toolchain / "lib/node_modules/npm"
    if not (npm_directory / "bin/npm-cli.js").exists():
        with urllib.request.urlopen("https://registry.npmjs.org/npm/latest", timeout=30) as response:
            metadata = json.load(response)
        with urllib.request.urlopen(metadata["dist"]["tarball"], timeout=60) as response:
            archive = response.read()
        integrity = metadata["dist"]["integrity"]
        if not integrity.startswith("sha512-") or base64.b64encode(hashlib.sha512(archive).digest()).decode() != integrity[7:]:
            raise ValueError("npm archive integrity check failed")
        npm_directory.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=npm_directory.parent) as stage:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as packed:
                packed.extractall(stage, filter="data")
            os.replace(Path(stage) / "package", npm_directory)
        for name, script in (("npm", "npm-cli.js"), ("npx", "npx-cli.js")):
            (binaries / name).symlink_to(f"../lib/node_modules/npm/bin/{script}")
    if not (binaries / "pnpm").exists():
        subprocess.run([str(binaries / "npm"), "install", "-g", "--prefix", str(toolchain),
                        "--registry=https://registry.npmjs.org", "pnpm@11.10.0"], check=True)
    package = PACKAGES[driver]
    print(f"Installing {package}@{version} as uid {os.geteuid()}", flush=True)
    subprocess.run([str(binaries / "npm"), "install", "-g", "--prefix", str(prefix),
                    "--registry=https://registry.npmjs.org", f"--allow-scripts={package}",
                    f"{package}@{version}"], check=True)


if __name__ == "__main__":
    main()
