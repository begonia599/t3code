import type {
  LocalMcpDiscoveredServer,
  LocalMcpServerView,
  LocalMcpServiceGroup,
} from "@t3tools/contracts";

export function serverId(name: string): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/__+/g, "_");
  id = id.replace(/^mcp[-_]/, "") || id;
  id = id.replace(/(?:[-_]?mcp)$/, "") || id;
  if (!/^[a-z]/.test(id)) id = `m-${id}`;
  return id.slice(0, 24);
}

export type LocalMcpGroupExisting = Pick<
  LocalMcpServerView,
  "config" | "serverName" | "toolsUpdatedAt"
>;

const products = [
  {
    id: "mcp-for-unity",
    label: "Unity",
    executables: ["mcpforunityserver", "mcp-for-unity", "mcp-for-unity-server"],
    serverNames: ["mcp-for-unity-server"],
  },
];

const executable = (value: string) =>
  (value.split(/[\\/]/).at(-1) ?? "")
    .toLowerCase()
    .replace(/(?:==|@).*$/, "")
    .replace(/\.exe$/, "");

type Member = LocalMcpGroupExisting & {
  names: readonly string[];
  configured: boolean;
};

/** Group distinct members, then choose a stable enabled primary or a bulk-add preference. */
function groups(members: readonly Member[]) {
  const parents = members.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const identities = members.map((member) => {
    const transport = member.config.transport;
    const commands =
      transport.type === "stdio" ? [transport.command, ...transport.args].map(executable) : [];
    const serverName = member.serverName?.toLowerCase();
    return {
      names: new Set(member.names.map(serverId)),
      serverName,
      product: products.find(
        (product) =>
          product.executables.some((name) => commands.includes(name)) ||
          (serverName !== undefined && product.serverNames.includes(serverName)),
      ),
    };
  });
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = identities[i]!;
      const b = identities[j]!;
      const sameProduct = a.product !== undefined && a.product === b.product;
      const crossTransport =
        members[i]!.config.transport.type !== members[j]!.config.transport.type;
      const sameName = [...a.names].some((name) => b.names.has(name));
      const sameServer = a.serverName !== undefined && a.serverName === b.serverName;
      if (sameProduct || (crossTransport && (sameName || sameServer))) {
        parents[root(j)] = root(i);
      }
    }
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < members.length; index++) {
    const key = root(index);
    const component = components.get(key);
    if (component) component.push(index);
    else components.set(key, [index]);
  }
  const http = (index: number) => Number(members[index]!.config.transport.type === "http");
  return [...components.values()]
    .filter((indices) => indices.length >= 2)
    .map((indices) => {
      const primary = indices
        .filter((index) => members[index]!.configured && members[index]!.config.enabled)
        .sort(
          (a, b) =>
            Number(members[b]!.toolsUpdatedAt !== undefined) -
              Number(members[a]!.toolsUpdatedAt !== undefined) ||
            http(b) - http(a) ||
            a - b,
        )[0];
      const preferred =
        primary === undefined
          ? indices
              .filter((index) => !members[index]!.configured)
              .sort((a, b) => http(b) - http(a) || a - b)[0]
          : undefined;
      const product = indices.map((index) => identities[index]!.product).find(Boolean);
      const group: LocalMcpServiceGroup = {
        key: product
          ? `product:${product.id}`
          : `name:${indices.flatMap((index) => [...identities[index]!.names]).sort()[0]!}`,
        label: product?.label ?? members[primary ?? preferred ?? indices[0]!]!.config.name,
      };
      return { indices, group, primary, preferred };
    });
}

/** Annotate settings views without changing configs, connection state or the remote catalog. */
export function groupLocalMcpViews(views: readonly LocalMcpServerView[]): LocalMcpServerView[] {
  const members = views.map((view) => ({
    ...view,
    names: [view.config.name],
    configured: true,
  }));
  const result = views.map<LocalMcpServerView>(
    ({ group: _group, duplicateOf: _duplicateOf, ...view }) => view,
  );
  for (const { indices, group, primary } of groups(members)) {
    for (const index of indices) {
      result[index] = {
        ...result[index]!,
        group,
        ...(primary === undefined || primary === index
          ? {}
          : { duplicateOf: members[primary]!.config.id }),
      };
    }
  }
  return result;
}

/** Added candidates contribute their source aliases to the existing member, never another node. */
export function groupLocalMcpDiscovery(
  servers: readonly LocalMcpDiscoveredServer[],
  existing: readonly LocalMcpGroupExisting[],
): LocalMcpDiscoveredServer[] {
  const members: Member[] = existing.map((view) => ({
    ...view,
    names: [view.config.name],
    configured: true,
  }));
  const configured = new Map(existing.map((view, index) => [view.config.id, index]));
  const candidateIndices = servers.map((server) => {
    const index = server.addedAs === undefined ? undefined : configured.get(server.addedAs);
    const names = server.sources.map((source) => source.name);
    if (index !== undefined) {
      members[index]!.names = [...members[index]!.names, ...names];
      return index;
    }
    return members.push({ config: server.config, names, configured: false }) - 1;
  });
  const annotations = new Map<
    number,
    Pick<LocalMcpDiscoveredServer, "group" | "preferred" | "duplicateOf">
  >();
  for (const { indices, group, primary, preferred } of groups(members)) {
    for (const index of indices) {
      annotations.set(index, {
        group,
        preferred: index === preferred,
        ...(primary === undefined ? {} : { duplicateOf: members[primary]!.config.id }),
      });
    }
  }
  return servers.map(
    ({ group: _group, preferred: _preferred, duplicateOf: _duplicateOf, ...server }, index) => ({
      ...server,
      ...annotations.get(candidateIndices[index]!),
    }),
  );
}
