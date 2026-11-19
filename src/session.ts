import { canonicalJson, sha256Hex } from 'sovereign-attest';
import { EnergyError } from './errors.js';
import {
  MAX_PRICE_SATANG_PER_KWH,
  assertTimestamp,
  assertWh,
  digestOf,
  normaliseMeterReading,
  type MeterReading,
} from './meter.js';

export const SESSION_VERSION = 1;
export const CURRENCY = 'THB';
export const DEFAULT_TOLERANCE_WH = 100;

const SITE_ID = /^[a-z][a-z0-9._:-]{0,63}$/;
const SESSION_ID = /^[0-9a-f]{64}$/;
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VEHICLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const SESSION_FIELDS = new Set([
  'v',
  'id',
  'site',
  'connectorId',
  'vehicleId',
  'priceSatangPerKwh',
  'chargerStartWh',
  'meterStartWh',
  'startAt',
  'status',
  'startReceiptId',
  'meterStart',
  'chargerStopWh',
  'meterStopWh',
  'endAt',
  'chargerWh',
  'meterWh',
  'driftWh',
  'amountSatang',
  'meterStop',
  'settlementReceiptId',
]);

export type SessionStatus = 'active' | 'settled';

/**
 * One charge session, stored as a single JSON record. The id hashes the
 * immutable header, so two devices that reconstruct the same start get the
 * same id, and an edited header no longer hashes to its own id.
 */
export interface ChargeSession {
  readonly v: 1;
  readonly id: string;
  readonly site: string;
  readonly connectorId: string;
  readonly vehicleId: string;
  readonly priceSatangPerKwh: number;
  readonly chargerStartWh: number;
  readonly meterStartWh: number;
  readonly startAt: number;
  readonly status: SessionStatus;
  readonly startReceiptId: string;
  readonly meterStart: MeterReading;
  readonly chargerStopWh?: number;
  readonly meterStopWh?: number;
  readonly endAt?: number;
  readonly chargerWh?: number;
  readonly meterWh?: number;
  readonly driftWh?: number;
  readonly amountSatang?: number;
  readonly meterStop?: MeterReading;
  readonly settlementReceiptId?: string;
}

export interface SessionHeader {
  readonly v: 1;
  readonly site: string;
  readonly connectorId: string;
  readonly vehicleId: string;
  readonly priceSatangPerKwh: number;
  readonly chargerStartWh: number;
  readonly meterStartWh: number;
  readonly startAt: number;
}

export function assertSiteId(value: unknown): string {
  if (typeof value !== 'string' || !SITE_ID.test(value)) {
    throw new EnergyError('invalid-session', 'site must match ^[a-z][a-z0-9._:-]{0,63}$');
  }
  return value;
}

export function assertConnectorId(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTOR_ID.test(value)) {
    throw new EnergyError(
      'invalid-connector',
      'connectorId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    );
  }
  return value;
}

export function assertVehicleId(value: unknown): string {
  if (typeof value !== 'string' || !VEHICLE_ID.test(value)) {
    throw new EnergyError(
      'invalid-session',
      'vehicleId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    );
  }
  return value;
}

export function assertPrice(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_PRICE_SATANG_PER_KWH
  ) {
    throw new EnergyError(
      'invalid-session',
      `priceSatangPerKwh must be an integer between 0 and ${MAX_PRICE_SATANG_PER_KWH}`
    );
  }
  return value;
}

export function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new EnergyError('invalid-session', 'session id must be a lowercase sha256 hex digest');
  }
  return value;
}

/** SHA-256 of the canonical header — the session's stable identity. */
export function sessionId(header: SessionHeader): string {
  return sha256Hex(canonicalJson(header));
}

export function sessionHeader(session: ChargeSession): SessionHeader {
  return {
    v: SESSION_VERSION,
    site: session.site,
    connectorId: session.connectorId,
    vehicleId: session.vehicleId,
    priceSatangPerKwh: session.priceSatangPerKwh,
    chargerStartWh: session.chargerStartWh,
    meterStartWh: session.meterStartWh,
    startAt: session.startAt,
  };
}

/** Whole satang, half-up. Exact for integers inside the documented caps. */
export function amountSatang(energyWh: number, priceSatangPerKwh: number): number {
  return Math.round((energyWh * priceSatangPerKwh) / 1000);
}

/** Session fields report session errors, even when they reuse a meter helper. */
function assertSessionTime(value: unknown, field: string): number {
  try {
    return assertTimestamp(value, field);
  } catch (error) {
    throw new EnergyError('invalid-session', `${field} must be a positive integer timestamp`, {
      cause: error,
    });
  }
}

function sessionReading(value: unknown, field: string): MeterReading {
  try {
    return normaliseMeterReading(value);
  } catch (error) {
    throw new EnergyError('invalid-session', `${field} is not a usable meter reading`, {
      cause: error,
    });
  }
}

/**
 * Validates a record read back from disk. Invariants that must survive a crash:
 * the id hashes its own header, a settled session carries a settlement receipt,
 * and a settled session has every number the receipt covers.
 */
export function normaliseSession(input: unknown): ChargeSession {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EnergyError('invalid-session', 'session record must be an object');
  }
  const raw = input as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!SESSION_FIELDS.has(field)) {
      throw new EnergyError('invalid-session', `session has an unknown field "${field}"`);
    }
  }
  if (raw.v !== SESSION_VERSION) {
    throw new EnergyError('invalid-session', `session.v must be ${SESSION_VERSION}`);
  }

  const header: SessionHeader = {
    v: SESSION_VERSION,
    site: assertSiteId(raw.site),
    connectorId: assertConnectorId(raw.connectorId),
    vehicleId: assertVehicleId(raw.vehicleId),
    priceSatangPerKwh: assertPrice(raw.priceSatangPerKwh),
    chargerStartWh: assertWh(raw.chargerStartWh, 'chargerStartWh'),
    meterStartWh: assertWh(raw.meterStartWh, 'meterStartWh'),
    startAt: assertSessionTime(raw.startAt, 'startAt'),
  };
  const id = assertSessionId(raw.id);
  if (id !== sessionId(header)) {
    throw new EnergyError('invalid-session', 'session id does not hash its own header');
  }

  const meterStart = sessionReading(raw.meterStart, 'meterStart');
  if (meterStart.wh !== header.meterStartWh) {
    throw new EnergyError('invalid-session', 'meterStart.wh does not match meterStartWh');
  }
  if (typeof raw.startReceiptId !== 'string' || !/^[0-9a-f]{64}$/.test(raw.startReceiptId)) {
    throw new EnergyError('invalid-session', 'startReceiptId must be a receipt id');
  }
  if (raw.status !== 'active' && raw.status !== 'settled') {
    throw new EnergyError('invalid-session', 'session.status must be active or settled');
  }

  const session: ChargeSession = {
    ...header,
    id,
    status: raw.status,
    startReceiptId: raw.startReceiptId,
    meterStart,
  };

  if (raw.status === 'active') {
    for (const field of [
      'chargerStopWh',
      'meterStopWh',
      'endAt',
      'chargerWh',
      'meterWh',
      'driftWh',
      'amountSatang',
      'meterStop',
      'settlementReceiptId',
    ]) {
      if (raw[field] !== undefined) {
        throw new EnergyError('invalid-session', `an active session must not carry ${field}`);
      }
    }
    return session;
  }

  const stop = sessionReading(raw.meterStop, 'meterStop');
  const meterStopWh = assertWh(raw.meterStopWh, 'meterStopWh');
  if (stop.wh !== meterStopWh) {
    throw new EnergyError('invalid-session', 'meterStop.wh does not match meterStopWh');
  }
  if (stop.meterId !== meterStart.meterId) {
    throw new EnergyError(
      'invalid-session',
      'start and stop readings must come from the same meter'
    );
  }
  if (meterStopWh < header.meterStartWh) {
    throw new EnergyError('invalid-session', 'meterStopWh is below meterStartWh');
  }
  const chargerStopWh = assertWh(raw.chargerStopWh, 'chargerStopWh');
  if (chargerStopWh < header.chargerStartWh) {
    throw new EnergyError('invalid-session', 'chargerStopWh is below chargerStartWh');
  }
  const chargerWh = assertWh(raw.chargerWh, 'chargerWh');
  const meterWh = assertWh(raw.meterWh, 'meterWh');
  if (chargerWh !== chargerStopWh - header.chargerStartWh) {
    throw new EnergyError('invalid-session', 'chargerWh does not equal stop minus start');
  }
  if (meterWh !== meterStopWh - header.meterStartWh) {
    throw new EnergyError('invalid-session', 'meterWh does not equal stop minus start');
  }
  const driftWh = assertWh(raw.driftWh, 'driftWh');
  if (driftWh !== Math.abs(chargerWh - meterWh)) {
    throw new EnergyError('invalid-session', 'driftWh does not match the two energies');
  }
  const settledAmount = assertSatang(raw.amountSatang);
  if (settledAmount !== amountSatang(meterWh, header.priceSatangPerKwh)) {
    throw new EnergyError('invalid-session', 'amountSatang does not match meterWh × price');
  }
  if (
    raw.settlementReceiptId === undefined ||
    typeof raw.settlementReceiptId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.settlementReceiptId)
  ) {
    throw new EnergyError('invalid-session', 'a settled session must carry settlementReceiptId');
  }

  return {
    ...session,
    status: 'settled',
    chargerStopWh,
    chargerWh,
    meterStopWh,
    meterWh,
    driftWh,
    amountSatang: settledAmount,
    endAt: assertSessionTime(raw.endAt, 'endAt'),
    meterStop: stop,
    settlementReceiptId: raw.settlementReceiptId,
  };
}

/**
 * The body a settlement receipt signs. Kept explicit so an auditor can rebuild
 * the exact bytes from the session record and compare the digest.
 */
export interface SettlementBody {
  readonly v: 1;
  readonly sessionId: string;
  readonly site: string;
  readonly connectorId: string;
  readonly vehicleId: string;
  readonly meterId: string;
  readonly chargerWh: number;
  readonly meterWh: number;
  readonly driftWh: number;
  readonly toleranceWh: number;
  readonly amountSatang: number;
  readonly currency: typeof CURRENCY;
  readonly startedAt: number;
  readonly endedAt: number;
}

export function settlementBody(session: ChargeSession, toleranceWh: number): SettlementBody {
  if (session.status !== 'settled') {
    throw new EnergyError('invalid-session', 'settlement body needs a settled session');
  }
  return {
    v: SESSION_VERSION,
    sessionId: session.id,
    site: session.site,
    connectorId: session.connectorId,
    vehicleId: session.vehicleId,
    meterId: session.meterStart.meterId,
    chargerWh: session.chargerWh as number,
    meterWh: session.meterWh as number,
    driftWh: session.driftWh as number,
    toleranceWh,
    amountSatang: session.amountSatang as number,
    currency: CURRENCY,
    startedAt: session.startAt,
    endedAt: session.endAt as number,
  };
}

export function settlementDigest(session: ChargeSession, toleranceWh: number): string {
  return digestOf(settlementBody(session, toleranceWh));
}

/**
 * Money is not energy: a settled amount may exceed `MAX_ENERGY_WH` (a survey of
 * 1 GWh at 10,000 satang/kWh would), but it must still be an exact integer so a
 * receipt never carries a rounded or fractional amount.
 */
export function assertSatang(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EnergyError('invalid-session', 'amountSatang must be a non-negative safe integer');
  }
  return value;
}
