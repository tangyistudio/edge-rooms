/**
 * edge-rooms — realtime rooms without a game server.
 *
 * Sign realtime tokens in an edge function, derive shared state from a seed.
 */

export {
  hashSeed,
  makeRng,
  seededShuffle,
  seededInt,
  seededPick,
  makeRoomSeed,
} from './seed.js';

export { loadScriptOnce, resetScriptCache } from './loader.js';

export {
  getClient,
  releaseClient,
  resetClients,
  createAblyAdapter,
  createStubAdapter,
} from './client.js';

export { joinRoom, roomChannelName, DEFAULT_NAMESPACE } from './room.js';
