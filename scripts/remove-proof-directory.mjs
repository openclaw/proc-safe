import { rm } from "node:fs/promises";

export async function removeProofDirectory(directory) {
  // Windows can retain directory or executable locks briefly after a child exits.
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
