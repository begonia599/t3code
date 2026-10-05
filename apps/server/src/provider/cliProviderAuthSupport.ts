import * as NodeUtil from "node:util";

export type LoginCli = "claude" | "grok";

/** Only documented public CLI output is parsed; OAuth exchange stays inside the CLI. */
export function readCliLoginInteraction(provider: LoginCli, output: string) {
  const plain = NodeUtil.stripVTControlCharacters(output);
  // eslint-disable-next-line no-control-regex -- Terminal control bytes cannot be part of an authorization URL.
  const urls = plain.matchAll(/https:\/\/[^\s<>"\x00-\x1f]+(?=\s|$)/g);
  for (const match of urls) {
    const raw = match[0];
    // A chunk can end inside a URL. Wait for its delimiter before publishing it.
    if (match.index + raw.length === plain.length || raw.length > 16_384) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) continue;
    if (provider === "claude") {
      if (
        !new Set(["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"]).has(
          url.hostname,
        )
      )
        continue;
      if (
        !/\/(?:oauth\/)?authorize\/?$/.test(url.pathname) ||
        !url.searchParams.get("state") ||
        !url.searchParams.get("code_challenge")
      )
        continue;
      return { type: "authorizationCode" as const, url: raw };
    }
    if (!new Set(["accounts.x.ai", "auth.x.ai", "grok.com"]).has(url.hostname)) continue;
    const userCode =
      url.searchParams.get("user_code") ??
      plain.match(
        /(?:\bcode(?: in your browser)?\s*[:：]\s*|\benter\s+(?:the\s+)?code\s+)([A-Z0-9][A-Z0-9-]{3,63})(?=[\s.])/i,
      )?.[1];
    if (!userCode || !/^[A-Z0-9][A-Z0-9-]{3,63}$/i.test(userCode)) continue;
    return { type: "deviceCode" as const, url: raw, userCode };
  }
  return null;
}

export function isCliAuthorizationCode(value: string): boolean {
  // Keep terminal control bytes and multi-line input out of the native login prompt.
  return /^[A-Za-z0-9_~.+/#=%-]{1,4096}$/.test(value);
}

export function supportsClaudeBrowserLogin(environment: NodeJS.ProcessEnv): boolean {
  return (
    !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some((key) =>
      environment[key]?.trim(),
    ) &&
    !["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((key) =>
      /^(1|true)$/i.test(environment[key] ?? ""),
    )
  );
}

export function supportsGrokBrowserLogin(environment: NodeJS.ProcessEnv): boolean {
  return !["XAI_API_KEY", "GROK_AUTH_PROVIDER_COMMAND", "GROK_OIDC_ISSUER"].some((key) =>
    environment[key]?.trim(),
  );
}
