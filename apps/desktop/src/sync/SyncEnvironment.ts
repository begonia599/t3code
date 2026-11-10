import * as Context from "effect/Context";

export class SyncEnvironment extends Context.Service<
  SyncEnvironment,
  {
    environment: (environmentId: string) => Promise<Readonly<Record<string, string>>>;
  }
>()("@t3tools/desktop/sync/SyncEnvironment") {}
