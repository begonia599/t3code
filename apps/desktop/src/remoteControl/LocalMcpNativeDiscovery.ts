// @effect-diagnostics globalDate:off -- Native discovery stamps the scan time.
// @effect-diagnostics nodeBuiltinImport:off -- Native read-only configuration discovery.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { LocalMcpServerConfig } from "@t3tools/contracts";
import { discoverLocalMcpServers, MAX_MCP_DISCOVERY_FILE_BYTES } from "./LocalMcpDiscovery.ts";

export const discoverNativeLocalMcpServers = (existing: readonly LocalMcpServerConfig[]) =>
  discoverLocalMcpServers(
    {
      home: NodeOS.homedir(),
      ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
      env: process.env,
      now: () => new Date(),
      readFile: async (file) => {
        try {
          if ((await NodeFSP.stat(file)).size > MAX_MCP_DISCOVERY_FILE_BYTES) {
            throw new Error("MCP config exceeds 8 MB");
          }
          return await NodeFSP.readFile(file, "utf8");
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return undefined;
          throw cause;
        }
      },
    },
    existing,
  );
