const WIN_SEARCH_INSTRUCTIONS = `\`rg\` (ripgrep) is on the Windows PATH: prefer it for file contents and \`rg --files\` for file lists; avoid \`Get-ChildItem -Recurse\` / \`Select-String\` scans of large directories.
For whole-PC filename searches use \`es <keyword>\`; it requires Everything to be running. On errors such as "Everything IPC not found", fall back to \`rg --files <directory> | rg <keyword>\`. Run these on Windows through \`win -- rg ...\`, \`win -- es ...\` or \`win ps '...'\` for pipelines.`;

export const WIN_AGENT_INSTRUCTIONS = `A \`win\` command is on PATH. It runs commands on the user's Windows desktop (the T3 desktop app) when one is connected:
\`win -- <program> [args...]\` (argv, no shell), \`win ps '<PowerShell script>'\`, \`win status\`, \`win log [-n N]\`.
Options: --cwd <Windows path>, --timeout <seconds> (default 600), --no-sync, --env K=V, --host <name|id>.
Use it only when the task needs Windows (e.g. Unity, Windows builds or tools). Without --cwd the working directory is translated through the user's path mappings; if none covers it, pass --cwd with a Windows folder the user allowed (listed by \`win status\`). Single-quote Windows paths and other arguments containing backslashes (\`--cwd 'D:\\proj'\`), since the shell strips unquoted backslashes. The user approves each session on Windows.
${WIN_SEARCH_INSTRUCTIONS}
If a Windows local MCP the task needs is not connected, run \`win mcp list\`. \`win mcp add <key>\` adds one already set up in another app on the PC; \`win mcp add --json '<config>'\` adds a new one from its install docs, config \`{"name":"…","transport":{"type":"stdio","command":"…","args":[…],"env":{…}}}\` or \`{"name":"…","transport":{"type":"http","url":"…","headers":{…}}}\`. The user confirms each add on the PC; after a denial (exit 126) do not ask again.
Windows local MCP tools have names like \`mcp__t3-win__<server>__<tool>\`; they execute on the user's Windows computer and may need to be loaded with ToolSearch first.
Exit codes 120-127 and 130 come from the launcher (details on stderr): 120 unauthorized, 121 no Windows host available, 122 connection lost so the result is unknown (check \`win log\`), 123 rejected by host policy, 124 timeout, 125 usage error, 126 denied by the user, 127 program not found, 130 cancelled.`;

/** Values are display text in a prompt, never instructions supplied by a client. */
export function buildWindowsProjectInstructions(input: {
  hostName: string;
  winPath: string;
  serverPath: string;
}): string {
  // oxlint-disable-next-line no-control-regex -- Strip control characters from interpolated prompt values.
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, "");
  const host = clean(input.hostName).replaceAll('"', "").slice(0, 64);
  const winPath = clean(input.winPath).slice(0, 260);
  const serverPath = clean(input.serverPath);
  return `This is a Windows project. Its files live on the user's Windows PC "${host}" in ${winPath}, and this directory (${serverPath}) is a two-way synced copy. Windows is where the project runs.
- Read, search and edit files here with your normal tools. Edits reach Windows within seconds, and edits made on Windows show up here.
- Run, build, test and install dependencies on Windows with the \`win\` command, e.g. \`win -- python main.py\`, \`win ps 'Get-ChildItem'\`. Run it from this directory or a subdirectory: it runs in the matching folder under ${winPath}, so you don't need --cwd. \`win\` waits for pending edits to finish syncing first.
- Use this server's shell only to read and search files. Do not run, build, test or install anything with it: it is a different OS, and build output and dependency folders (bin/, obj/, node_modules/, Library/, ...) are not synced.
- The user's git repository is on Windows: use \`win -- git ...\`. The git repository in this directory is T3's internal change history, not the user's; do not commit, branch or push in it.
- Write code and instructions for Windows: Windows paths (${winPath}\\...), PowerShell or cmd syntax, and keep each file's existing line endings.
- If \`win\` exits 121 the PC is offline, and 123 means remote control is turned off on the PC: tell the user and wait. Never fall back to running on the server. If \`win\` reports a sync conflict, tell the user which file instead of overwriting it.
\`win\` reference: \`win -- <program> [args...]\` (argv, no shell), \`win ps '<PowerShell script>'\`, \`win status\`, \`win log [-n N]\`. Options: --cwd <Windows path>, --timeout <seconds> (default 600), --no-sync, --env K=V. Single-quote arguments containing backslashes (\`'C:\\path'\`), since the shell strips unquoted backslashes.
${WIN_SEARCH_INSTRUCTIONS}
If a Windows local MCP the task needs is not connected, run \`win mcp list\`. \`win mcp add <key>\` adds one already set up in another app on the PC; \`win mcp add --json '<config>'\` adds a new one from its install docs, config \`{"name":"…","transport":{"type":"stdio","command":"…","args":[…],"env":{…}}}\` or \`{"name":"…","transport":{"type":"http","url":"…","headers":{…}}}\`. The user confirms each add on the PC; after a denial (exit 126) do not ask again.
Windows local MCP tools have names like \`mcp__t3-win__<server>__<tool>\`; they execute on the user's Windows computer and may need to be loaded with ToolSearch first.
Exit codes 120-127 and 130 come from the launcher (details on stderr): 120 unauthorized, 121 PC offline, 122 connection lost so the result is unknown (check \`win log\`), 123 rejected by host policy, 124 timeout, 125 usage error, 126 denied by the user, 127 program not found, 130 cancelled. Any other exit code is the program's own.`;
}
