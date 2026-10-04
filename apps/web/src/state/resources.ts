import { createResourceAtoms } from "@t3tools/client-runtime/state/resources";
import { connectionAtomRuntime } from "../connection/runtime";
export const resources = createResourceAtoms(connectionAtomRuntime);
