// A stdio fixture for the 1.5 quota command and its disposable session artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const sessionId = NodeCrypto.randomUUID();
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const notify = (update, target = sessionId) =>
  send({ method: "session/update", params: { sessionId: target, update } });

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  NodeFS.appendFileSync(
    process.env.T3_ACP_REQUEST_LOG_PATH,
    JSON.stringify({ method, params }) + "\n",
  );
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [{ id: "oauth-personal", name: "Google" }],
          agentInfo: { name: "antigravity-acp", version: "1.5.0" },
        },
      });
      break;
    case "authenticate":
      send({
        id,
        result: {
          _meta: {
            antigravity: {
              tier: {
                name: "Google AI Ultra",
                id: "g1-ultra-tier",
                upgradeUri: "https://example.invalid/upgrade",
              },
            },
          },
        },
      });
      break;
    case "session/new": {
      const profile = NodePath.join(process.env.GEMINI_HOME, "antigravity-acp");
      NodeFS.mkdirSync(NodePath.join(profile, "brain", sessionId), { recursive: true });
      const base = NodePath.join(profile, "conversations", sessionId);
      NodeFS.mkdirSync(NodePath.join(profile, "conversations"), { recursive: true });
      for (const suffix of [".db", ".db-wal", ".db-shm"]) NodeFS.writeFileSync(base + suffix, "");
      NodeFS.writeFileSync(base + ".meta", JSON.stringify({ cwd: params.cwd }));
      send({ id, result: { sessionId } });
      notify({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "usage", description: "Usage" }],
      });
      break;
    }
    case "session/set_config_option":
      send({ id, result: { configOptions: [] } });
      break;
    case "session/prompt": {
      const content = (text) => ({ type: "text", text });
      if (params.prompt[0]?.text !== "/usage") {
        notify({ sessionUpdate: "agent_message_chunk", content: content("Thread reply") });
        send({ id, result: { stopReason: "end_turn" } });
        break;
      }
      notify(
        {
          sessionUpdate: "agent_message_chunk",
          content: content("### Quota Limits\n- Unable to retrieve quota status (foreign)\n"),
        },
        "another-session",
      );
      notify({
        sessionUpdate: "agent_thought_chunk",
        content: content("### Quota Limits\n- Unable to retrieve quota status (thought)\n"),
      });
      notify({
        sessionUpdate: "agent_message_chunk",
        content: content("### Quota Limits\n- **Gemini Mo"),
      });
      notify({
        sessionUpdate: "agent_message_chunk",
        content: content("dels**\n  - **Weekly Limit Remaining:** 98% remaining"),
      });
      send({ id, result: { stopReason: "end_turn" } });
      break;
    }
    default:
      send({ id, error: { code: -32601, message: "Unknown method" } });
  }
}
