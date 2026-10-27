import * as crypto from 'crypto';

/**
 * Dynamically generates a perfectly uniform random shard ID 
 * based on the log level's configuration.
 */
export function getShardIdForTotalNumOfShards(totalShards: number = 5): number {
  
  if (totalShards <= 1) {
    return 0; // No sharding required, always use SID#0
  }

  // Eliminate modulo bias dynamically for whatever number totalShards is
  const maxUnbiasedValue = Math.floor(256 / totalShards) * totalShards;
  const byteArray = new Uint8Array(1);

  while (true) {
    crypto.getRandomValues(byteArray);
    const randomByte = byteArray[0];
    if (randomByte == null) continue; // probably will never happen, but needed to avoid Typescript errors
    if (randomByte < maxUnbiasedValue) {
      return randomByte % totalShards; // Returns 0 to (totalShards - 1) uniformly
    }
  }
}