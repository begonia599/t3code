import * as Context from "effect/Context";

export class SyncEnvironment extends Context.Service<
  SyncEnvironment,
  {
    privateEnvironment?: () => Promise<Readonly<Record<string, string>>>;
    environment: (environmentId: string) => Promise<Readonly<Record<string, string>>>;
  }
>()("@t3tools/desktop/sync/SyncEnvironment") {}
