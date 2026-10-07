# Native agent configuration

Open **Settings → Providers**, choose the environment and Codex or Claude instance,
then open **Native configuration**. On mobile, open the environment in Settings and
use the same action under its provider. Choose a project to include its files.

The editor reads and writes the agent's native settings, instructions, rules,
Skills and text memories on that environment. The displayed home and resolved file
paths help distinguish accounts and shared files. Credentials and conversation
databases are not part of this editor. Managed policy files are read-only.

Use graphical settings for the supported fields or the raw editor for other
options. Removing a graphical override restores inheritance; opening a file does
not fill it with defaults. Graphical changes enter the same draft as raw edits.
Use the raw editor for native values outside a graphical control's displayed range.
**Save** writes the draft directly. **Preview changes** is optional. Invalid JSON
or TOML is rejected without replacing the file.

If another editor changes the file, saving stops and preserves your draft. Reload
the saved file and compare the differences before saving again. **Undo save**
restores the previous contents, or removes a file created by that save. Undo stops
if the file changed again. Undo records are temporary: they expire after a server
restart or when displaced by newer saves. Unsaved drafts stay in this editor and
are not synchronized between devices.

Saved does not mean loaded by a running agent. T3 session options, environment
variables, native project trust and policy can override file settings. Start a new
session when needed by the native setting. After editing Skills, refresh the
provider's skills with **Refresh agent skills**. The editor does not restart
the agent or change its login or network settings automatically.

Discovery is bounded to 500 files and text editing to 256 KiB per file. Memory
folders are shown by their native directory names; their presence does not prove
that the selected project loads them. Parent instruction files are candidates too.
Additional-directory imports, plugin-owned sources and dynamic policy sources may
not all appear. The graphical catalog is an initial subset verified against Codex
0.160.1 and Claude Code 2.1.291; field and model support can differ by installed
version. Other settings remain accessible as raw text.

For native field definitions, consult the [Codex configuration schema](https://learn.chatgpt.com/docs/config-schema.json)
and [Claude Code environment variable reference](https://code.claude.com/docs/en/env-vars).
