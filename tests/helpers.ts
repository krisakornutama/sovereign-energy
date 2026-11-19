import {
  Attest,
  canonicalJson,
  createSigningKey,
  fromUtf8,
  signBytes,
  utf8,
  type RecordInput,
  type Receipt,
  type SigningKey,
} from 'sovereign-attest';
import { MemoryAnchorLog, MemoryBlobStore, Vault, randomBytes } from 'sovereign-vault';
import { expect } from 'vitest';
import { Energy, EnergyError, type ChargeSession, type MeterReading } from '../src/index.js';

export const METER_ID = 'meter-1';

export interface Fixture {
  readonly energy: Energy;
  readonly vault: Vault;
  readonly store: MemoryBlobStore;
  readonly masterKey: Uint8Array;
  readonly meter: SigningKey;
  readonly anchors: MemoryAnchorLog;
  /** The clock the energy module reads. */
  readonly clock: () => number;
  /** Moves the clock so two operations never share a timestamp by accident. */
  readonly at: (ms: number) => void;
  /** A meter reading signed by the fixture meter at the current clock. */
  readonly signed: (wh: number, at?: number, meterId?: string) => MeterReading;
}

export interface MakeOptions {
  readonly site?: string;
  readonly keyId?: string;
  /** Pin the fixture meter (default true). */
  readonly pin?: boolean;
  readonly allowUnsignedMeter?: boolean;
  readonly toleranceWh?: number;
  readonly now?: number;
}

export function signedReading(
  key: SigningKey,
  wh: number,
  at: number,
  meterId = METER_ID
): MeterReading {
  const payload = { wh, at, meterId };
  return {
    wh,
    at,
    meterId,
    signature: signBytes(key.privateKey, utf8(canonicalJson(payload))),
  };
}

export async function makeEnergy(options: MakeOptions = {}): Promise<Fixture> {
  let clock = options.now ?? 1_000_000;
  const store = new MemoryBlobStore();
  const masterKey = randomBytes(32);
  const vault = await Vault.open({ store, masterKey, clock: () => clock });
  const meter = createSigningKey(METER_ID, 1);
  const energy = await Energy.open({
    vault,
    site: options.site ?? 'home-a',
    ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
    now: () => clock,
    ...(options.toleranceWh === undefined ? {} : { toleranceWh: options.toleranceWh }),
    ...(options.allowUnsignedMeter === undefined
      ? {}
      : { allowUnsignedMeter: options.allowUnsignedMeter }),
  });
  if (options.pin !== false) await energy.trustMeter(METER_ID, meter.publicKey);
  return {
    energy,
    vault,
    store,
    masterKey,
    meter,
    anchors: new MemoryAnchorLog(),
    clock: () => clock,
    at: (ms: number) => {
      clock = ms;
    },
    signed: (wh: number, at?: number, meterId?: string) =>
      signedReading(meter, wh, at ?? clock, meterId),
  };
}

export interface StartOverrides {
  readonly connectorId?: string;
  readonly vehicleId?: string;
  readonly priceSatangPerKwh?: number;
  readonly chargerStartWh?: number;
  readonly meterStart?: MeterReading;
}

export async function startCharge(
  fixture: Fixture,
  overrides: StartOverrides = {}
): Promise<ChargeSession> {
  const chargerStartWh = overrides.chargerStartWh ?? 500_000;
  return fixture.energy.start({
    connectorId: overrides.connectorId ?? '1',
    vehicleId: overrides.vehicleId ?? 'ev:vin-hash',
    priceSatangPerKwh: overrides.priceSatangPerKwh ?? 450,
    chargerStartWh,
    meterStart: overrides.meterStart ?? fixture.signed(chargerStartWh),
  });
}

/** Re-opens the same encrypted store, as a fresh process would. */
export async function reopen(fixture: Fixture, options: MakeOptions = {}): Promise<Energy> {
  const vault = await Vault.open({
    store: fixture.store,
    masterKey: fixture.masterKey,
    clock: fixture.clock,
  });
  return Energy.open({
    vault,
    site: options.site ?? 'home-a',
    ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
    now: fixture.clock,
    ...(options.toleranceWh === undefined ? {} : { toleranceWh: options.toleranceWh }),
  });
}

export interface FailOptions {
  readonly failGet?: (path: string) => boolean;
  readonly failPut?: (path: string) => boolean;
}

/**
 * Wraps a vault so a specific path can fail on demand. Used to prove that a
 * failed write leaves no half-settled session behind.
 */
export function wrapVault(vault: Vault, options: FailOptions): Vault {
  const { failGet, failPut } = options;
  return new Proxy(vault, {
    get(target, property) {
      if (property === 'put' && failPut) {
        return async (key: string, value: Uint8Array): Promise<unknown> => {
          if (failPut(key)) throw new Error(`injected put failure: ${key}`);
          return target.put(key, value);
        };
      }
      if (property === 'get' && failGet) {
        return async (key: string): Promise<Uint8Array> => {
          if (failGet(key)) throw new Error(`injected get failure: ${key}`);
          return target.get(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Vault;
}

export async function readJson(vault: Vault, path: string): Promise<unknown> {
  return JSON.parse(fromUtf8(await vault.get(path)));
}

export async function writeJson(vault: Vault, path: string, value: unknown): Promise<void> {
  await vault.put(path, utf8(canonicalJson(value)));
}

/** Signs a receipt with the site's own key: models a bug, not a stolen key. */
export async function sealWith(vault: Vault, keyId: string, input: RecordInput): Promise<Receipt> {
  const attest = await Attest.open({ vault, keyId });
  return attest.record(input);
}

/** Asserts the operation fails with a specific `EnergyError` code. */
export async function rejectsWith(operation: () => unknown, code: string): Promise<EnergyError> {
  try {
    await operation();
  } catch (error) {
    expect(error, `expected EnergyError(${code}) but got ${String(error)}`).toBeInstanceOf(
      EnergyError
    );
    const energyError = error as EnergyError;
    expect(energyError.code).toBe(code);
    return energyError;
  }
  throw new Error(`expected EnergyError(${code}) but the operation succeeded`);
}
