import { runJob, type GroundJob } from "./groundJobs.ts";

/** Web Worker: paints ground textures off the main thread (see groundJobs.ts). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<GroundJob>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
scope.onmessage = (e) => {
  const r = runJob(e.data);
  scope.postMessage(r, [r.pixels.buffer]);
};
