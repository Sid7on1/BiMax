// Protocol compatibility, DERIVED from the engine's own constants rather than copied from them.
// Safe for both Electron main and the renderer: src/protocol/protocol.ts has no imports.
import {
  PROTOCOL_SEMVER,
  PROTOCOL_MIN_COMPATIBLE_MAJOR,
  PROTOCOL_MAX_COMPATIBLE_MAJOR,
} from '../../../src/protocol/protocol';

export const CLIENT_PROTOCOL_VERSION = PROTOCOL_SEMVER;
export const CLIENT_MIN_COMPATIBLE_MAJOR = PROTOCOL_MIN_COMPATIBLE_MAJOR;
export const CLIENT_MAX_COMPATIBLE_MAJOR = PROTOCOL_MAX_COMPATIBLE_MAJOR;

export function supportsProtocolMajor(major: number): boolean {
  return Number.isInteger(major) && major >= CLIENT_MIN_COMPATIBLE_MAJOR && major <= CLIENT_MAX_COMPATIBLE_MAJOR;
}
