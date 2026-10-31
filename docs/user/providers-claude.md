# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Sign in with a Claude subscription

Open **Settings → Providers**, choose the environment and Claude instance, and
start sign-in from its account section. Open the authorization link and paste the
browser's authorization code back into T3 Code. Existing logins remain usable
without signing in again. See [native CLI sign-in](./install.md#sign-in-to-an-installed-cli)
for cancellation, expiry and signing out.

This entry uses Claude's subscription login. Instances configured with API keys,
OAuth-token environment variables, Bedrock, Vertex or Foundry keep their native
authentication setup. Console OAuth profiles are not managed here.

## Separate accounts or configurations

To view and edit this instance's native settings, instructions, memories and
Skills, see [Native agent configuration](./native-configuration.md).

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. Add another instance with a
separate config directory and sign in from its account section. Alternatively,
create the second login on the environment's machine:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter and may suggest it when you return to
a large older thread. See [commands and skills](./composer.md#commands-and-skills)
for using composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Custom API gateways

In **Settings → Providers**, select your environment and Claude instance, then
open **Custom API gateway**. Enter the gateway base URL, API key and
default model ID, then **Save and use gateway**. Saving applies it immediately.
Self-hosted gateways and other vendors work through the same form when they
support native Anthropic Messages. There is no protocol conversion.

The base URL is the prefix before `/v1/messages`: OpenRouter uses
`https://openrouter.ai/api`. Use **Load gateway models** to choose an ID, or enter
IDs manually if the gateway does not expose a model list. IDs are sent unchanged.
**Advanced settings** contains authentication, additional model IDs, optional
Opus/Sonnet/Haiku/subagent mappings, request headers and connection testing.
Bearer authentication is the default; model mappings fall back to the main model.
Additional request headers are stored as sensitive values.

**Test connection** sends two small requests from the selected server, checking
native streaming and a tool call without executing the tool. These requests may
be billed by the gateway. A passing test does not guarantee every Claude feature;
the gateway must support the capabilities your model and agent use. See the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
for that service's current compatibility requirements.

Saving rebuilds the instance and can stop its running tasks; finish them first,
or add a separate Claude instance for the gateway. Choose one of its models in an existing chat.
On mobile, open the environment in Settings and use **Custom API gateway** under
Claude.

Your saved Claude OAuth login, Skills, config directory and proxy settings stay
intact. Gateway overrides apply only to this instance's child processes; native
managed policy still applies. If you use custom `--settings` launch arguments,
move those values into native settings files before enabling the gateway.
Select **Use original configuration** to remove the gateway overrides and restore
the original instance configuration. API key fields stay masked and keep their
saved value when left unchanged. Subscription limits are not shown for a gateway instance.
