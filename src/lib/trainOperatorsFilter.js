/**
 * Train4you (Urlaubs-Express / UEX) operator detection.
 *
 * The implementation lives in the shared, node-runnable primitives module
 * (src/pages/api/lib/primitives.mjs) so the live API routes and the build-time
 * canonicalize script share one definition. Re-exported here to preserve the
 * existing import path.
 */
export {
  TRAIN4YOU_AGENCY_ID,
  isTrain4you,
} from "../pages/api/lib/primitives.mjs";
