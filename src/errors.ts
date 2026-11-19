/**
 * Errors thrown by the energy module. Codes are part of the public contract:
 * "the meter disagreed" must be distinguishable from "I have a bug".
 */
export type EnergyErrorCode =
  | 'invalid-connector'
  | 'invalid-session'
  | 'invalid-meter'
  | 'invalid-ocpp'
  | 'untrusted-meter'
  | 'meter-mismatch'
  | 'connector-busy'
  | 'session-not-found'
  | 'session-not-active'
  | 'receipt-required'
  | 'signature-invalid'
  | 'rollback';

export interface EnergyErrorOptions {
  readonly cause?: unknown;
  readonly receiptId?: string;
  /** Numbers an operator needs to fix a mismatch, e.g. chargerWh vs meterWh. */
  readonly details?: Readonly<Record<string, number | string>>;
}

export class EnergyError extends Error {
  readonly code: EnergyErrorCode;
  readonly receiptId?: string;
  readonly details?: Readonly<Record<string, number | string>>;

  constructor(code: EnergyErrorCode, message: string, options: EnergyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EnergyError';
    this.code = code;
    if (options.receiptId !== undefined) this.receiptId = options.receiptId;
    if (options.details !== undefined) this.details = options.details;
  }
}
