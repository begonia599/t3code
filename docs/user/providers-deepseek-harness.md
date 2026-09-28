# DeepSeek Harness

Install the DeepSeek Harness CLI on the machine running your T3 Code environment:

```bash
npm install -g @deepseek-ai/dsh
```

In **Settings → Providers**, add **DeepSeek Harness**. T3 Code starts the CLI's
ACP profile for each thread and keeps the harness's saved sessions available
after reconnecting. If `dsh` is not on the server's `PATH`, set **Binary path**
to its executable.

Set `DEEPSEEK_API_KEY` in the provider instance's environment variables, or
save the key in DeepSeek Harness's own **Settings → Models**. T3 Code does not
manage the harness's model credentials. The model picker includes the bundled
DeepSeek models; other routes configured in the harness can be added as custom
models using their ACP model value.

The ACP profile exposes standard messages, tool calls, permissions, model and
reasoning selection, and session resume. DeepSeek Harness presentation cards
and child agent details are not available through its standard ACP profile.
T3 Code's background title, commit message, branch name, and PR text generation
are not available from this provider yet; select another provider for those tasks.
