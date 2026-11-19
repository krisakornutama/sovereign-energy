import {
  canonicalJson,
  normalisePublicKey,
  publicKeyMatches,
  sha256Hex,
  utf8,
  verifyBytes,
} from 'sovereign-attest';
import { EnergyError } from './errors.js';

/**
 * Hard ceilings. Every value is an integer so settlement arithmetic stays exact;
 * the caps keep `wh * satangPerKwh` inside Number.MAX_SAFE_INTEGER and keep a
 * malicious peer from turning one receipt into a huge number.
 */
export const MAX_ENERGY_WH = 1_000_000_000; // 1 GWh
export const MAX_PRICE_SATANG_PER_KWH = 1_000_000; // 10,000 THB/kWh
export const MAX_TOLERANCE_WH = 10_000; // 10 kWh
export const MAX_TIMESTAMP = 8_640_000_000_000_000; // 275,760 AD in ms

const METER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * A reading from the billing meter. `signature` is a base64 Ed25519 signature
 * over canonical({ wh, at, meterId }) — the same canonical JSON rules as attest,
 * so a reading can be verified with nothing but the pinned public key.
 */
export interface MeterReading {
  readonly wh: number;
  readonly at: number;
  readonly meterId: string;
  readonly signature?: string;
}

export function assertMeterId(value: unknown): string {
  if (typeof value !== 'string' || !METER_ID.test(value)) {
    throw new EnergyError(
      'invalid-meter',
      'meterId must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    );
  }
  return value;
}

export function assertWh(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new EnergyError('invalid-meter', `${field} must be a non-negative integer Wh`);
  }
  if (value > MAX_ENERGY_WH) {
    throw new EnergyError('invalid-meter', `${field} must be at most ${MAX_ENERGY_WH} Wh`);
  }
  return value;
}

export function assertTimestamp(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TIMESTAMP
  ) {
    throw new EnergyError('invalid-meter', `${field} must be a positive integer timestamp`);
  }
  return value;
}

/**
 * Validates shape only. Unknown fields are rejected: a field the verifier
 * ignores is a field an attacker can use to change the payload while the
 * signature still covers something else.
 */
export function normaliseMeterReading(input: unknown): MeterReading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EnergyError('invalid-meter', 'meter reading must be an object');
  }
  const raw = input as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!['wh', 'at', 'meterId', 'signature'].includes(field)) {
      throw new EnergyError('invalid-meter', `meter reading has an unknown field "${field}"`);
    }
  }
  const reading: {
    wh: number;
    at: number;
    meterId: string;
    signature?: string;
  } = {
    wh: assertWh(raw.wh, 'meter reading wh'),
    at: assertTimestamp(raw.at, 'meter reading at'),
    meterId: assertMeterId(raw.meterId),
  };
  if (raw.signature !== undefined) {
    if (typeof raw.signature !== 'string' || raw.signature.length === 0) {
      throw new EnergyError('invalid-meter', 'meter reading signature must be a non-empty string');
    }
    if (raw.signature.length > 512) {
      throw new EnergyError('invalid-meter', 'meter reading signature is too long');
    }
    reading.signature = raw.signature;
  }
  return reading;
}

/** The exact bytes a meter signs. Never re-serialise the object after signing. */
export function meterPayload(reading: MeterReading): Uint8Array {
  return utf8(canonicalJson({ wh: reading.wh, at: reading.at, meterId: reading.meterId }));
}

/** Constant-shape verification: returns false for any malformed input. */
export function verifyMeterSignature(reading: MeterReading, publicKeyPem: unknown): boolean {
  if (typeof publicKeyPem !== 'string' || reading.signature === undefined) return false;
  return verifyBytes(publicKeyPem, meterPayload(reading), reading.signature);
}

export function sameMeterKey(left: string, right: string): boolean {
  try {
    return publicKeyMatches(left, right);
  } catch {
    return false;
  }
}

export function normaliseMeterKey(publicKey: unknown): string {
  if (typeof publicKey !== 'string' || publicKey.length > 4096) {
    throw new EnergyError('untrusted-meter', 'meter public key must be a PEM string');
  }
  if (
    !publicKey.includes('-----BEGIN PUBLIC KEY-----') ||
    !publicKey.includes('-----END PUBLIC KEY-----')
  ) {
    throw new EnergyError('untrusted-meter', 'meter public key must be a PEM public key');
  }
  try {
    return normalisePublicKey(publicKey);
  } catch (error) {
    throw new EnergyError('untrusted-meter', 'meter public key is not a usable Ed25519 key', {
      cause: error,
    });
  }
}

/** Session/billing id helpers shared with the receipt layer. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
