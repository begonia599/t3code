export const WIN_AGENT_INSTRUCTIONS = `A \`win\` command is on PATH. It runs commands on the user's Windows desktop (the T3 desktop app) when one is connected:
\`win -- <program> [args...]\` (argv, no shell), \`win ps '<PowerShell script>'\`, \`win status\`, \`win log [-n N]\`.
Options: --cwd <Windows path>, --timeout <seconds> (default 600), --no-sync, --env K=V, --host <name|id>.
Use it only when the task needs Windows (e.g. Unity, Windows builds or tools). The working directory is mapped to the Windows copy of the project automatically; the user approves each session on Windows.
Exit codes 120-127 and 130 come from the launcher (details on stderr): 120 unauthorized, 121 no Windows host available, 122 connection lost so the result is unknown (check \`win log\`), 123 rejected by host policy, 124 timeout, 125 usage error, 126 denied by the user, 127 program not found, 130 cancelled.`;
