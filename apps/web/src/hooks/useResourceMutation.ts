import type { ResourceMutation } from "@t3tools/client-runtime/state/resources";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRef, useState } from "react";
import { resources } from "../state/resources";
import { useAtomCommand } from "../state/use-atom-command";

export function useResourceMutation(
  environmentId: EnvironmentId,
  errorMessage = "Could not save resources. Check your connection and administrator access.",
) {
  const execute = useAtomCommand(resources.mutate, { reportFailure: false, reportDefect: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutate = async (input: ResourceMutation) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await execute({ environmentId, input });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      return true;
    } catch {
      setError(errorMessage);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { mutate, busy, error };
}
