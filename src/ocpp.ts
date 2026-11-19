import { EnergyError } from './errors.js';
import { assertWh } from './meter.js';
import { assertConnectorId, assertVehicleId } from './session.js';

/**
 * A strict parser for the OCPP 2.0.1 `TransactionEvent` subset that settlement
 * needs. OCPP itself has 80+ message types and a WebSocket transport; the fabric
 * of a charge session only needs the numbers a meter can be compared against,
 * so everything else is rejected rather than silently ignored.
 */
export const MAX_SAMPLES = 1_000;

export type ParsedTransactionEvent =
  | {
      readonly kind: 'start';
      readonly transactionId: string;
      readonly connectorId: string;
      readonly vehicleId: string;
      readonly chargerStartWh: number;
      readonly at: number;
    }
  | {
      readonly kind: 'reading';
      readonly transactionId: string;
      readonly chargerWh: number;
      readonly at: number;
    }
  | {
      readonly kind: 'end';
      readonly transactionId: string;
      readonly connectorId: string;
      readonly chargerStopWh: number;
      readonly at: number;
      readonly reason?: string;
    };

const EVENT_TYPES = new Set(['Started', 'Updated', 'Ended']);
const REGISTER = 'Energy.Active.Import.Register';
const REASON = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(message: string): never {
  throw new EnergyError('invalid-ocpp', message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') fail(`${field} must be an ISO-8601 string`);
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= 0) fail(`${field} is not a valid ISO-8601 timestamp`);
  return at;
}

function parseConnector(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    fail('evse.id must be a positive integer');
  }
  return assertConnectorId(String(value));
}

function parseTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !TRANSACTION_ID.test(value)) {
    fail('transactionInfo.transactionId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  return value;
}

function parseEnergy(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  try {
    return assertWh(value, field);
  } catch {
    fail(`${field} must be a non-negative integer Wh`);
  }
}

function parseWhText(value: unknown, unit: unknown, field: string): number {
  if (typeof value !== 'string' || value.trim() === '')
    fail(`${field}.value must be a numeric string`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${field}.value must be a non-negative number`);
  if (unit !== undefined && unit !== 'Wh' && unit !== 'kWh') {
    fail(`${field}.unit must be Wh or kWh`);
  }
  const wh = unit === 'kWh' ? parsed * 1000 : parsed;
  if (!Number.isInteger(wh)) fail(`${field} does not convert to whole Wh`);
  try {
    return assertWh(wh, field);
  } catch {
    fail(`${field} is outside the supported energy range`);
  }
}

/** Latest `Energy.Active.Import.Register` sample wins, exactly as OCPP defines it. */
export function latestRegisterWh(
  meterValue: unknown,
  field = 'meterValue'
): { wh: number; at: number } | null {
  if (!Array.isArray(meterValue)) fail(`${field} must be an array`);
  if (meterValue.length > MAX_SAMPLES) fail(`${field} carries too many samples`);

  let latest: { wh: number; at: number } | null = null;
  for (const [index, item] of meterValue.entries()) {
    const entry = asRecord(item, `${field}[${index}]`);
    const at = parseTimestamp(entry.timestamp, `${field}[${index}].timestamp`);
    if (!Array.isArray(entry.sampledValue)) {
      fail(`${field}[${index}].sampledValue must be an array`);
    }
    if (entry.sampledValue.length > MAX_SAMPLES) {
      fail(`${field}[${index}].sampledValue carries too many samples`);
    }
    for (const [sampleIndex, sample] of entry.sampledValue.entries()) {
      const sampleRecord = asRecord(sample, `${field}[${index}].sampledValue[${sampleIndex}]`);
      if (sampleRecord.measurand !== REGISTER) continue;
      const wh = parseWhText(
        sampleRecord.value,
        sampleRecord.unit,
        `${field}[${index}].sampledValue[${sampleIndex}]`
      );
      if (!latest || at > latest.at) latest = { wh, at };
    }
  }
  return latest;
}

/**
 * Parses one OCPP 2.0.1 TransactionEvent into the numbers the settlement engine
 * understands. Anything malformed throws `invalid-ocpp`; nothing is guessed.
 */
export function parseTransactionEvent(input: unknown): ParsedTransactionEvent {
  const event = asRecord(input, 'transactionEvent');
  const eventType = event.eventType;
  if (typeof eventType !== 'string' || !EVENT_TYPES.has(eventType)) {
    fail('eventType must be Started, Updated or Ended');
  }
  const info = asRecord(event.transactionInfo, 'transactionInfo');
  const transactionId = parseTransactionId(info.transactionId);
  const at = parseTimestamp(event.timestamp, 'timestamp');

  if (eventType === 'Started') {
    const evse = asRecord(event.evse, 'evse');
    const connectorId = parseConnector(evse.id);
    const idToken = asRecord(event.idToken, 'idToken');
    let vehicleId: string;
    try {
      vehicleId = assertVehicleId(idToken.idToken);
    } catch {
      fail('idToken.idToken must be a usable vehicle identifier');
    }
    return {
      kind: 'start',
      transactionId,
      connectorId,
      vehicleId,
      chargerStartWh: parseEnergy(info.meterStart, 'transactionInfo.meterStart'),
      at,
    };
  }

  if (eventType === 'Updated') {
    const latest = latestRegisterWh(event.meterValue);
    if (!latest) fail('Updated event carries no Energy.Active.Import.Register sample');
    return { kind: 'reading', transactionId, chargerWh: latest.wh, at: latest.at };
  }

  const evse = asRecord(event.evse, 'evse');
  const connectorId = parseConnector(evse.id);
  const reason =
    info.stoppedReason === undefined
      ? undefined
      : typeof info.stoppedReason === 'string' && REASON.test(info.stoppedReason)
        ? info.stoppedReason
        : fail('transactionInfo.stoppedReason is not a usable reason code');
  return {
    kind: 'end',
    transactionId,
    connectorId,
    chargerStopWh: parseEnergy(info.meterStop, 'transactionInfo.meterStop'),
    at,
    ...(reason === undefined ? {} : { reason }),
  };
}
