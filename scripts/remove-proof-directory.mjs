import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function removeProofDirectory(directory) {
  // Bun does not honor fs.rm retry options for transient Windows locks.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 10 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}
