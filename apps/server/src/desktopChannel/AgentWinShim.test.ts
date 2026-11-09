import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { launcherConstants, prepareAgentWinEnvironment } from "./AgentWinShim.ts";
import { runWinLauncher, type WinLauncherRuntime } from "./winLauncher.ts";

const result = {
  outcome: "exited",
  exitCode: 0,
  durationMs: 3,
  winCwd: "C:\\project",
  stdoutBytes: 0,
  stderrBytes: 0,
  truncated: false,
  decodedAsGbk: false,
};
const accepted = { type: "accepted", requestId: "r", hostId: "h", hostName: "Windows" };
const ndjson = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const fixture = (
  args = ["--", "echo", "hello"],
  events: unknown[] = [{ type: "result", result }],
) => {
  const output = { stdout: "", stderr: "" };
  const requests: { url: string; init: RequestInit }[] = [];
  const signals = new Map<string, () => void>();
  const io: WinLauncherRuntime = {
    args,
    env: { T3_WIN_ENDPOINT: "http://localhost/agent-win/v1", T3_WIN_CREDENTIAL_FILE: "/token" },
    cwd: () => "/project",
    readFile: async () => "credential\n",
    stdin: async () => "Write-Host hello",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response(ndjson(events));
    },
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
    onSignal: (signal, listener) => {
      signals.set(signal, listener);
      return () => {
        signals.delete(signal);
      };
    },
    constants: launcherConstants,
  };
  return { io, output, requests, signals, run: () => runWinLauncher(io) };
};

describe("win launcher", () => {
  it("preserves argv, overlays env and sends the server cwd and session headers", async () => {
    const f = fixture([
      "--cwd",
      "D:\\Win project",
      "--timeout",
      "1.5",
      "--no-sync",
      "--env",
      "A=x=y",
      "--env",
      "B=",
      "--host",
      "Work",
      "--",
      "tool",
      "a b",
      "--help",
      "-n",
    ]);
    f.io.env.T3_WIN_LABEL = "delegate";
    expect(await f.run()).toBe(0);
    expect(JSON.parse(f.requests[0]!.init.body as string)).toEqual({
      host: "Work",
      exec: {
        mode: "argv",
        argv: ["tool", "a b", "--help", "-n"],
        serverCwd: "/project",
        winCwd: "D:\\Win project",
        timeoutMs: 1500,
        noSync: true,
        env: { A: "x=y", B: "" },
      },
    });
    expect(f.requests[0]!.init.headers).toMatchObject({
      authorization: "Bearer credential",
      "x-t3-win-label": "delegate",
    });
  });
  it.each([
    ["ps", "Write-Host hi"],
    ["ps", "-"],
  ])("reads PowerShell script %j", async (...args) => {
    const f = fixture(args);
    expect(await f.run()).toBe(0);
    expect(JSON.parse(f.requests[0]!.init.body as string).exec).toMatchObject({
      mode: "powershell",
      script: args[1] === "-" ? "Write-Host hello" : args[1],
      timeoutMs: 600000,
    });
  });
  it.each([
    [],
    ["--"],
    ["echo"],
    ["--timeout"],
    ["--timeout", "0", "--", "p"],
    ["--timeout", "21601", "--", "p"],
    ["--timeout", "NaN", "--", "p"],
    ["--cwd", " ", "--", "p"],
    ["--env", "1X=y", "--", "p"],
    ["--env", "X", "--", "p"],
    ["status", "--timeout", "10"],
    ["log", "-n", "201"],
    ["log", "-n", "0"],
    ["log", "-n", "1.5"],
    ["--json", "--", "p"],
    ["ps", ""],
    ["status", "log"],
    ["--bad"],
    ["status", "-n", "2"],
  ])("rejects invalid arguments %j", async (...args) => {
    const f = fixture(args);
    expect(await f.run()).toBe(125);
    expect(f.output.stderr).toMatch(/^\[win\] /);
    expect(f.requests).toHaveLength(0);
  });
  it("prints help without credentials", async () => {
    const f = fixture(["--help"]);
    f.io.env = {};
    expect(await f.run()).toBe(0);
    expect(f.output.stdout).toContain("Usage:");
  });
  it.each(["T3_WIN_ENDPOINT", "T3_WIN_CREDENTIAL_FILE"])("requires %s", async (key) => {
    const f = fixture();
    delete f.io.env[key];
    expect(await f.run()).toBe(120);
  });
  it("rejects unreadable or empty credential files", async () => {
    const f = fixture();
    f.io.readFile = async () => {
      throw new Error("missing");
    };
    expect(await f.run()).toBe(120);
    f.io.readFile = async () => "";
    expect(await f.run()).toBe(120);
  });
  it.each([
    ["exited", 7, 7],
    ["timedOut", null, 124],
    ["cancelled", null, 130],
    ["exited", null, 122],
    ["exited", 0xc0000005, 1],
    ["exited", -1073741819, 1],
  ] as const)("maps result %s/%s to %s", async (outcome, exitCode, code) => {
    const f = fixture(undefined, [{ type: "result", result: { ...result, outcome, exitCode } }]);
    expect(await f.run()).toBe(code);
    if (code === 1) expect(f.output.stderr).toContain("0xC0000005");
  });
  it.each(Object.entries(launcherConstants.errorCodes))(
    "maps error %s to %s",
    async (code, exit) => {
      const f = fixture(undefined, [{ type: "error", code, message: "test" }]);
      expect(await f.run()).toBe(exit);
      expect(f.output.stderr).toBe(`[win] ${code}: test\n`);
    },
  );
  it.each([
    [[], 121],
    [[accepted], 122],
  ] as const)("handles missing terminal line %j", async (events, code) => {
    const f = fixture(undefined, [...events]);
    expect(await f.run()).toBe(code);
    if (code === 122) expect(f.output.stderr).toContain("win log");
  });
  it("handles HTTP 401 and unreachable servers", async () => {
    const f = fixture();
    f.io.fetch = async () =>
      new Response(ndjson([{ type: "error", code: "UNAUTHORIZED", message: "expired" }]), {
        status: 401,
      });
    expect(await f.run()).toBe(120);
    f.io.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await f.run()).toBe(121);
  });
  it("ignores heartbeat blank lines in fragmented UTF-8 NDJSON and preserves output and progress", async () => {
    const f = fixture();
    const bytes = new TextEncoder().encode(
      ndjson([
        accepted,
        { type: "stdout", data: "中文\n" },
        { type: "stderr", data: "warning" },
        { type: "progress", progress: { type: "queued" } },
        { type: "progress", progress: { type: "awaiting-grant" } },
        { type: "progress", progress: { type: "truncated", limitBytes: 10 } },
        { type: "result", result },
      ]).replaceAll("\n", "\n\n\n"),
    );
    f.io.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const b of bytes) c.enqueue(new Uint8Array([b]));
            c.close();
          },
        }),
      );
    expect(await f.run()).toBe(0);
    expect(f.output.stdout).toBe("中文\n");
    expect(f.output.stderr).toBe(
      "warning[win] waiting for Windows session approval\n[win] output truncated\n",
    );
  });
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("aborts fetch on %s", async (signal, code) => {
    const f = fixture();
    let aborted = false;
    f.io.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        f.signals.get(signal)!();
      });
    expect(await f.run()).toBe(code);
    expect(aborted).toBe(true);
    expect(f.output.stderr).toBe("[win] cancelled\n");
    expect(f.signals.size).toBe(0);
  });
  it("prints status and log as readable text or original JSON and takes the default host from env", async () => {
    const status = {
      hosts: [{ hostId: "h", hostName: "Work", execEnabled: true }],
      selectedHostId: "h",
      hostStatus: { grant: "granted", running: 1, shells: ["pwsh"] },
      hostStatusError: null,
    };
    for (const json of [false, true]) {
      const f = fixture(["status", ...(json ? ["--json"] : [])]);
      f.io.env.T3_WIN_HOST = "Work";
      const text = JSON.stringify(status, null, 2);
      f.io.fetch = async (url) => {
        expect(String(url)).toContain("host=Work");
        return new Response(text);
      };
      expect(await f.run()).toBe(0);
      expect(f.output.stdout).toContain(json ? text : "Grant: granted");
      const log = fixture(["log", "-n", "5", ...(json ? ["--json"] : [])]);
      log.io.fetch = async (url) => {
        expect(String(url)).toContain("n=5");
        return new Response('{"source":"server","entries":[]}');
      };
      expect(await log.run()).toBe(0);
      expect(log.output.stdout).toContain(json ? '"source":"server"' : "Execution log (server)");
    }
  });

  it.effect("runs generated JavaScript and shell launchers with real Node", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-generated-" });
        const env = yield* prepareAgentWinEnvironment({
          stateDir: dir,
          sessionId: "session",
          endpoint: "http://localhost/mcp",
          authorizationHeader: "Bearer test-token",
        });
        expect((yield* fs.stat(env.T3_WIN_CREDENTIAL_FILE)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(`${dir}/agent-win/credentials`)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(`${env.PATH}/win`)).mode & 0o777).toBe(0o755);
        for (const [program, launcher] of [
          [process.execPath, `${env.PATH}/win-launcher.mjs`],
          ["/bin/sh", `${env.PATH}/win`],
        ] as const) {
          for (const [arg, expected] of [
            ["--help", 0],
            ["--invalid", 125],
          ] as const) {
            const child = NodeChildProcess.spawn(program, [launcher, arg], {
              env: { ...process.env, ...env },
              stdio: "inherit",
            });
            const code = yield* Effect.promise(
              () =>
                new Promise<number | null>((resolve, reject) => {
                  child.on("error", reject);
                  child.on("close", resolve);
                }),
            );
            expect(code).toBe(expected);
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the generated launcher with real Node against a local HTTP server", (context) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-http-" });
        const server = NodeHttp.createServer(async (req, res) => {
          expect(req.url).toBe("/agent-win/v1/exec");
          expect(req.headers.authorization).toBe("Bearer test-token");
          let text = "";
          for await (const part of req) text += part;
          expect(JSON.parse(text).exec.argv).toEqual(["echo", "hello"]);
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(
            ndjson([accepted, { type: "stdout", data: "real exec\n" }, { type: "result", result }]),
          );
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                if (!server.listening) {
                  resolve();
                  return;
                }
                server.close((e) => (e ? reject(e) : resolve()));
              }),
          ),
        );
        const listening = yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", resolve);
            }),
        ).pipe(Effect.result);
        if (listening._tag === "Failure") {
          if ((listening.failure.cause as NodeJS.ErrnoException).code === "EPERM") {
            context.skip(true, "Sandbox forbids local HTTP listeners");
            return;
          }
          throw listening.failure;
        }
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const env = yield* prepareAgentWinEnvironment({
          stateDir: dir,
          sessionId: "session",
          endpoint: `http://127.0.0.1:${address.port}/mcp`,
          authorizationHeader: "Bearer test-token",
        });
        const child = NodeChildProcess.spawn(
          process.execPath,
          [`${env.PATH}/win-launcher.mjs`, "--", "echo", "hello"],
          { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (b) => {
          out += b;
        });
        child.stderr.on("data", (b) => {
          err += b;
        });
        const code = yield* Effect.promise(
          () =>
            new Promise<number | null>((resolve, reject) => {
              child.on("error", reject);
              child.on("close", resolve);
            }),
        );
        expect({ code, out, err }).toEqual({ code: 0, out: "real exec\n", err: "" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
