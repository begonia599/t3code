# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. T3 Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

To view and edit this instance's native settings, instructions and Skills, see
[Native agent configuration](./native-configuration.md).

T3 Code can use your installed Codex and its existing login. If it is signed out,
start device-code sign-in in **Settings → Providers** for that instance, or run
`codex login` on the environment's machine. See
[native CLI sign-in](./install.md#sign-in-to-an-installed-cli) for authorization,
cancellation and account changes.

## Custom API gateways

Open **Settings → Providers**, select the environment and a **local** Codex
instance, then open **Custom API gateway**. Enter the base URL before `/responses`
(for example, `https://gateway.example/v1`), API key and default model ID. The
gateway must support the native Responses protocol; Chat Completions alone is
not sufficient and T3 does not convert protocols. T3-managed ChatGPT accounts
remain a separate setup mode.

Fetch the model list or enter IDs manually, then **Save and use gateway** to
apply it immediately. Model IDs are sent unchanged. **Advanced settings** contains
authentication, additional model IDs, request headers and connection testing.
Bearer authentication is the default; `x-api-key` is also supported. Test connection
checks streaming and a tool call from the selected server with two small, potentially billable requests; it does not execute tools
or guarantee every Codex capability.

Saving rebuilds the instance and can stop its tasks. Finish them first, or create
a separate Codex instance for the gateway, then select a gateway model in chat.
On mobile, the same editor is under the environment's provider settings.

Gateway overrides use Codex's native per-process configuration. They preserve
`CODEX_HOME`, saved OAuth credentials, Skills and network settings. Use
**Use original configuration** to remove the gateway overrides and return to
the previous instance configuration.
Gateway instances do not show the saved ChatGPT account's subscription limits.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting T3-managed ChatGPT accounts leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. Add the second instance with a fresh shadow
directory, then sign in from that instance's account section. Alternatively, sign
in on the environment's machine:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
