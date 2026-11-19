import type { AttestVault } from 'sovereign-attest';

/**
 * The vault throws `not-found`; the energy module treats an absent key as
 * "not written yet". Any other error is real and must not be swallowed.
 */
export async function readOptional(vault: AttestVault, path: string): Promise<Uint8Array | null> {
  try {
    return await vault.get(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'not-found'
  );
}
