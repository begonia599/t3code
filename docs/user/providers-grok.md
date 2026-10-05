# Grok

T3 Code uses the official Grok Build CLI and its saved account login.

## Sign in from T3 Code

On web or desktop, open **Settings > Providers**, select the Grok instance, and
choose **Sign in with Grok**. On mobile, open **Settings > Environments**, select
the environment, and find the instance's **Grok account** section.

Open the authorization link and enter or confirm the displayed device code in
your browser. T3 waits for authorization and checks the saved login before
reporting success. Cancel or retry from the client that started the request.
The server does not need a browser or an SSH connection from you.

Use a Grok Build version supporting `grok login --device-auth`. Credentials stay
with the official CLI, which also handles refresh. Instances using `XAI_API_KEY`,
an external authentication command, or an OIDC issuer keep that configuration;
manage those credentials in the instance's settings.

## Separate accounts

Give each account its own instance and `GROK_HOME` directory. A sandbox instance
already has a provisioned private Grok directory. The login process uses that
instance's identity and network.

Existing logins remain until you explicitly **Sign out**. Signing in or out stops
active threads sharing the credential directory, while keeping their history.
