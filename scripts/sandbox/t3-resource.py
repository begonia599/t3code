#!/usr/bin/python3 -I
"""Small script client for a T3-issued, restricted MCP context."""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request


class ClientError(Exception):
    """Messages written by this client, with no context-file contents."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    mcp = commands.add_parser("mcp").add_subparsers(dest="operation", required=True)
    for name in ("tools", "call"):
        command = mcp.add_parser(name)
        command.add_argument("--context", required=True, type=Path)
        command.add_argument("--timeout", type=int, default=300)
        if name == "call":
            command.add_argument("tool")
            command.add_argument("--json-file", type=Path)
    args = parser.parse_args()
    context = json.loads(args.context.read_text())
    if context["expiresAt"] <= time.time() * 1000:
        raise ClientError("Script access expired. Request new access through T3 MCP.")
    if args.operation == "call" and args.tool not in context["tools"]:
        raise ClientError("This tool is outside the script authorization.")
    opener = urllib.request.build_opener(NoRedirect())
    session = None
    version = "2025-06-18"
    def request(method, params=None, identifier=1, http_method="POST"):
        nonlocal session, version
        headers = {"Authorization": context["authorization"], "Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": version}
        if session:
            headers["Mcp-Session-Id"] = session
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if identifier is not None:
            payload["id"] = identifier
        data = json.dumps(payload).encode() if http_method == "POST" else None
        try:
            with opener.open(urllib.request.Request(context["endpoint"], data=data, headers=headers, method=http_method), timeout=args.timeout) as response:
                session = response.headers.get("mcp-session-id", session)
                body = response.read()
        except urllib.error.HTTPError as error:
            if error.code in (401, 403): raise ClientError("Script access is not allowed or has been revoked. Request access through T3 MCP.") from None
            if error.code == 404: raise ClientError("The script MCP session ended. Run the command again or request new access.") from None
            raise ClientError(f"T3 MCP returned HTTP {error.code}.") from None
        except urllib.error.URLError:
            raise ClientError("Cannot reach T3 MCP. Check the sandbox relay and the harness shell network permission; script authorization does not override the harness's native network policy.") from None
        if not body:
            return {}
        message = json.loads(body)
        if "error" in message:
            raise ClientError("The hosted MCP rejected the request. Check the tool name and its argument schema.")
        return message.get("result", {})
    try:
        result = request("initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "t3-resource", "version": "1"}})
        version = result["protocolVersion"]
        request("notifications/initialized", identifier=None)
        if args.operation == "tools":
            result = request("tools/list")
        else:
            arguments = json.loads(args.json_file.read_text() if args.json_file else sys.stdin.read())
            if not isinstance(arguments, dict): raise ClientError("Tool arguments must be a JSON object.")
            result = request("tools/call", {"name": args.tool, "arguments": arguments})
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get("isError") else 0
    finally:
        if session:
            try: request("", http_method="DELETE")
            except (OSError, ValueError, ClientError): pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ClientError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError):
        # Context files contain a capability token. Never echo their contents,
        # a Request object or HTTP headers in diagnostics.
        print("T3 resource call failed. Check access expiry, the requested tool and its JSON arguments.", file=sys.stderr)
        sys.exit(1)
