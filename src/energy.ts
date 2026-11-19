import {
  Attest,
  loadReceipt,
  openReceipt,
  type AnchorLogLike,
  type AttestVault,
  type Receipt,
} from 'sovereign-attest';
import { fromUtf8, utf8 } from 'sovereign-attest';
import { EnergyError } from './errors.js';
import {
  MAX_TIMESTAMP,
  MAX_TOLERANCE_WH,
  assertMeterId,
  assertWh,
  digestOf,
  normaliseMeterKey,
  normaliseMeterReading,
  verifyMeterSignature,
  type MeterReading,
} from './meter.js';
import {
  CURRENCY,
  DEFAULT_TOLERANCE_WH,
  SESSION_VERSION,
  amountSatang,
  assertConnectorId,
  assertPrice,
  assertSessionId,
  assertSiteId,
  assertVehicleId,
  normaliseSession,
  sessionId,
  settlementBody,
  settlementDigest,
  type ChargeSession,
  type SessionHeader,
} from './session.js';
import { canonicalJson } from 'sovereign-attest';
import { readOptional } from './vault-io.js';

export const ACTION_CHARGE_STARTED = 'energy.charge.started';
export const ACTION_CHARGE_SETTLED = 'energy.charge.settled';

const SITE_PATH = 'energy/site';
const INDEX_PATH = 'energy/index';
const METERS_PATH = 'energy/meters';
const sessionPath = (id: string): string => `energy/session/${id}`;

export interface EnergyOptions {
  /** Works with `sovereign-vault`'s `Vault` (or anything with the same shape). */
  readonly vault: AttestVault;
  /** Stable name of this household/site, e.g. `home-a`. Bound to the vault. */
  readonly site: unknown;
  readonly keyId?: string;
  readonly now?: () => number;
  /**
   * Accept readings that carry no signature. Off by default: a settlement
   * receipt claims a meter signed the numbers, so an unsigned reading makes
   * that claim false. Turn on only when the meter cannot sign (documented).
   */
  readonly allowUnsignedMeter?: boolean;
  /** Allowed charger-vs-meter drift in Wh (default 100 Wh). */
  readonly toleranceWh?: number;
}

export interface StartChargeInput {
  readonly connectorId: unknown;
  readonly vehicleId: unknown;
  readonly priceSatangPerKwh: unknown;
  readonly chargerStartWh: unknown;
  /** Signed start reading from the billing meter. */
  readonly meterStart: unknown;
}

export interface StopChargeInput {
  readonly chargerStopWh: unknown;
  /** Signed end reading from the same billing meter. */
  readonly meterStop: unknown;
  /** End time; defaults to the injected clock. */
  readonly at?: number;
}

export interface SettlementQuote {
  readonly sessionId: string;
  readonly chargerWh: number;
  readonly meterWh: number;
  readonly driftWh: number;
  readonly toleranceWh: number;
  readonly withinTolerance: boolean;
  readonly amountSatang: number;
}

export interface SettlementReport extends SettlementQuote {
  readonly site: string;
  readonly connectorId: string;
  readonly vehicleId: string;
  readonly meterId: string;
  readonly currency: typeof CURRENCY;
  readonly status: 'matched';
  readonly receiptId: string;
  readonly receipt: Receipt;
}

interface Index {
  readonly v: 1;
  readonly sessions: readonly string[];
}

/**
 * Charge sessions with meter-verified settlement.
 *
 * The charger reports its own counter; the billing meter reports the truth.
 * `stop()` refuses to bill when the two disagree beyond `toleranceWh`, so a
 * receipt can only exist for a session whose numbers were checked. Every
 * settlement is a signed attest receipt, verifiable offline against a pinned key.
 */
export class Energy {
  private readonly vault: AttestVault;
  private readonly attest: Attest;
  private readonly keyId: string;
  private readonly clock: () => number;
  private readonly siteId: string;
  private readonly allowUnsigned: boolean;
  private readonly toleranceWh: number;
  private readonly records = new Map<string, ChargeSession>();
  private readonly meterPins = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    vault: AttestVault,
    attest: Attest,
    keyId: string,
    clock: () => number,
    siteId: string,
    allowUnsigned: boolean,
    toleranceWh: number
  ) {
    this.vault = vault;
    this.attest = attest;
    this.keyId = keyId;
    this.clock = clock;
    this.siteId = siteId;
    this.allowUnsigned = allowUnsigned;
    this.toleranceWh = toleranceWh;
  }

  static async open(options: EnergyOptions): Promise<Energy> {
    const raw = options as EnergyOptions | null | undefined;
    const vault = raw?.vault as AttestVault | null | undefined;
    if (!vault || typeof vault.get !== 'function' || typeof vault.put !== 'function') {
      throw new EnergyError('invalid-session', 'Energy.open needs a vault with get/put');
    }
    const siteId = assertSiteId(raw?.site);
    const stored = await readOptional(vault, SITE_PATH);
    if (stored) {
      const owner = parseRecord(stored, 'site');
      if (owner.v !== 1 || owner.site !== siteId) {
        throw new EnergyError(
          'invalid-session',
          `this vault belongs to site "${String(owner.site)}", not "${siteId}"`
        );
      }
    } else {
      await vault.put(SITE_PATH, encode({ v: 1, site: siteId }));
    }

    const toleranceWh = raw?.toleranceWh ?? DEFAULT_TOLERANCE_WH;
    if (
      typeof toleranceWh !== 'number' ||
      !Number.isInteger(toleranceWh) ||
      toleranceWh < 0 ||
      toleranceWh > MAX_TOLERANCE_WH
    ) {
      throw new EnergyError(
        'invalid-session',
        `toleranceWh must be an integer between 0 and ${MAX_TOLERANCE_WH}`
      );
    }

    const clock = raw?.now ?? Date.now;
    const keyId = raw?.keyId ?? 'energy';
    const attest = await Attest.open({ vault, keyId, now: clock });
    const energy = new Energy(
      vault,
      attest,
      keyId,
      clock,
      siteId,
      raw?.allowUnsignedMeter === true,
      toleranceWh
    );
    await energy.loadMeters();
    await energy.loadSessions();
    return energy;
  }

  /** This site's name. */
  site(): string {
    return this.siteId;
  }

  /** PEM an auditor pins to verify this site's receipts. */
  publicKey(): string {
    const key = this.attest.trustedKeys()[this.keyId];
    if (!key) throw new EnergyError('invalid-session', `no public key for keyId "${this.keyId}"`);
    return key;
  }

  /** Pins the billing meter's public key. Signed readings from anyone else are refused. */
  async trustMeter(meterId: unknown, publicKey: unknown): Promise<this> {
    const id = assertMeterId(meterId);
    const key = normaliseMeterKey(publicKey);
    return this.enqueue(async () => {
      const next = new Map([...this.meterPins, [id, key]]);
      await this.writeMeters(next);
      return this;
    });
  }

  async untrustMeter(meterId: unknown): Promise<this> {
    const id = assertMeterId(meterId);
    return this.enqueue(async () => {
      const next = new Map(this.meterPins);
      next.delete(id);
      await this.writeMeters(next);
      return this;
    });
  }

  meters(): readonly string[] {
    return [...this.meterPins.keys()].sort();
  }

  /**
   * Starts a session. The start receipt is sealed before the record is written,
   * so a store failure aborts with `receipt-required` and leaves no session.
   */
  async start(input: StartChargeInput): Promise<ChargeSession> {
    return this.enqueue(async () => {
      // JS callers can pass anything; the runtime guard is not optional chaining
      // for style, it is the type check that the signature cannot express.
      const raw = input as StartChargeInput | null | undefined;
      const connectorId = assertConnectorId(raw?.connectorId);
      const vehicleId = assertVehicleId(raw?.vehicleId);
      const priceSatangPerKwh = assertPrice(raw?.priceSatangPerKwh);
      const chargerStartWh = assertWh(raw?.chargerStartWh, 'chargerStartWh');
      const meterStart = this.acceptMeter(raw?.meterStart, 'meterStart');

      for (const session of this.records.values()) {
        if (session.status === 'active' && session.connectorId === connectorId) {
          throw new EnergyError(
            'connector-busy',
            `connector "${connectorId}" already has an active session`
          );
        }
      }

      const header: SessionHeader = {
        v: SESSION_VERSION,
        site: this.siteId,
        connectorId,
        vehicleId,
        priceSatangPerKwh,
        chargerStartWh,
        meterStartWh: meterStart.wh,
        startAt: this.clock(),
      };
      const id = sessionId(header);
      if (this.records.has(id)) {
        throw new EnergyError('invalid-session', `session ${id} already exists`);
      }

      const receipt = await this.seal(ACTION_CHARGE_STARTED, `charge:${id}`, digestOf(header), {
        connectorId,
        vehicleId,
        priceSatangPerKwh: String(priceSatangPerKwh),
        chargerStartWh: String(chargerStartWh),
        meterId: meterStart.meterId,
        startAt: String(header.startAt),
      });

      const session: ChargeSession = {
        ...header,
        id,
        status: 'active',
        startReceiptId: receipt.id,
        meterStart,
      };
      await this.vault.put(sessionPath(id), encode(session));
      await this.writeIndex([...this.records.keys(), id]);
      this.records.set(id, session);
      return session;
    });
  }

  /**
   * Compares the two counters without touching state. Useful before stopping:
   * the operator sees the drift while the session is still open.
   */
  reconcile(sessionIdInput: unknown, input: StopChargeInput): SettlementQuote {
    const session = this.requireSession(sessionIdInput, 'active');
    const { chargerStopWh, meterStop } = this.readStop(input);
    return this.quote(session, chargerStopWh, meterStop);
  }

  /**
   * Ends a session. Refuses with `meter-mismatch` when charger and meter differ
   * beyond tolerance — the session stays active so the reading can be corrected
   * and the call retried. On success the settlement receipt is sealed before
   * the settled record is written (fail closed).
   */
  async stop(
    sessionIdInput: unknown,
    input: StopChargeInput
  ): Promise<{ session: ChargeSession; settlement: SettlementReport }> {
    return this.enqueue(async () => {
      const session = this.requireSession(sessionIdInput, 'active');
      const { chargerStopWh, meterStop } = this.readStop(input);
      const quote = this.quote(session, chargerStopWh, meterStop);
      if (!quote.withinTolerance) {
        throw new EnergyError(
          'meter-mismatch',
          `meter and charger disagree by ${quote.driftWh} Wh (tolerance ${this.toleranceWh} Wh)`,
          {
            details: {
              sessionId: session.id,
              chargerWh: quote.chargerWh,
              meterWh: quote.meterWh,
              driftWh: quote.driftWh,
              toleranceWh: quote.toleranceWh,
            },
          }
        );
      }

      const endAt =
        (input as StopChargeInput | null | undefined)?.at === undefined
          ? this.clock()
          : assertTimestampInput(input.at);
      if (endAt < session.startAt) {
        throw new EnergyError('invalid-session', 'session cannot end before it started');
      }

      const settled: ChargeSession = {
        ...session,
        status: 'settled',
        chargerStopWh,
        chargerWh: quote.chargerWh,
        meterStopWh: meterStop.wh,
        meterWh: quote.meterWh,
        driftWh: quote.driftWh,
        amountSatang: quote.amountSatang,
        endAt,
        meterStop,
      };
      const body = settlementBody(settled, this.toleranceWh);
      const digest = digestOf(body);
      const receipt = await this.seal(ACTION_CHARGE_SETTLED, `settlement:${session.id}`, digest, {
        sessionId: session.id,
        digest,
        site: session.site,
        connectorId: session.connectorId,
        vehicleId: session.vehicleId,
        meterId: meterStop.meterId,
        chargerWh: String(quote.chargerWh),
        meterWh: String(quote.meterWh),
        driftWh: String(quote.driftWh),
        toleranceWh: String(this.toleranceWh),
        amountSatang: String(quote.amountSatang),
        currency: CURRENCY,
        startedAt: String(session.startAt),
        endedAt: String(endAt),
      });

      const finalSession: ChargeSession = { ...settled, settlementReceiptId: receipt.id };
      await this.vault.put(sessionPath(session.id), encode(finalSession));
      this.records.set(session.id, finalSession);
      return {
        session: finalSession,
        settlement: {
          ...quote,
          site: session.site,
          connectorId: session.connectorId,
          vehicleId: session.vehicleId,
          meterId: meterStop.meterId,
          currency: CURRENCY,
          status: 'matched',
          receiptId: receipt.id,
          receipt,
        },
      };
    });
  }

  get(sessionIdInput: unknown): ChargeSession | undefined {
    return this.records.get(assertSessionId(sessionIdInput));
  }

  /** Settled sessions first, then active ones; each group ordered by start time. */
  sessions(): readonly ChargeSession[] {
    return [...this.records.values()].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'settled' ? -1 : 1;
      return left.startAt - right.startAt;
    });
  }

  /**
   * Re-opens a stored settlement receipt and checks it against the record:
   * signature, action, artifact name and digest must all line up.
   */
  async settlement(sessionIdInput: unknown): Promise<SettlementReport> {
    const session = this.requireSession(sessionIdInput, 'settled');
    const receiptId = session.settlementReceiptId as string;
    const receipt = await loadReceipt(this.vault, receiptId);
    if (!receipt) {
      throw new EnergyError('rollback', `settlement receipt ${receiptId} is missing`, {
        receiptId,
      });
    }
    let body;
    try {
      body = openReceipt(receipt, { publicKey: this.publicKey() });
    } catch (error) {
      throw new EnergyError(
        'signature-invalid',
        'stored settlement receipt does not verify against this site key',
        { cause: error, receiptId }
      );
    }
    if (body.action !== ACTION_CHARGE_SETTLED) {
      throw new EnergyError('signature-invalid', 'stored receipt is not a settlement', {
        receiptId,
      });
    }
    if (
      body.artifact.name !== `settlement:${session.id}` ||
      body.artifact.sha256 !== settlementDigest(session, this.toleranceWh)
    ) {
      throw new EnergyError('signature-invalid', 'settlement receipt does not match this session', {
        receiptId,
      });
    }
    return {
      sessionId: session.id,
      chargerWh: session.chargerWh as number,
      meterWh: session.meterWh as number,
      driftWh: session.driftWh as number,
      toleranceWh: this.toleranceWh,
      withinTolerance: (session.driftWh as number) <= this.toleranceWh,
      amountSatang: session.amountSatang as number,
      site: session.site,
      connectorId: session.connectorId,
      vehicleId: session.vehicleId,
      meterId: session.meterStart.meterId,
      currency: CURRENCY,
      status: 'matched',
      receiptId,
      receipt,
    };
  }

  async anchor(log: AnchorLogLike): Promise<unknown> {
    return this.attest.anchor(log);
  }

  async checkAnchor(log: AnchorLogLike, expectedRoot?: string): Promise<unknown> {
    return this.attest.checkAnchor(log, expectedRoot);
  }

  /**
   * Verifies a settlement receipt with only the pinned key and the receipt
   * itself. An auditor does not need this package's state.
   */
  static verifySettlement(
    receipt: Receipt,
    options: { readonly publicKey: string }
  ): Omit<SettlementReport, 'receipt'> {
    let body;
    try {
      body = openReceipt(receipt, { publicKey: options.publicKey });
    } catch (error) {
      throw new EnergyError('signature-invalid', 'settlement receipt does not verify', {
        cause: error,
        receiptId: receipt.id,
      });
    }
    if (body.action !== ACTION_CHARGE_SETTLED) {
      throw new EnergyError('signature-invalid', 'receipt is not a settlement', {
        receiptId: receipt.id,
      });
    }
    const name = body.artifact.name;
    if (!/^settlement:[0-9a-f]{64}$/.test(name)) {
      throw new EnergyError('signature-invalid', 'settlement artifact name is malformed', {
        receiptId: receipt.id,
      });
    }
    const meta = body.meta ?? {};
    if (meta.digest !== body.artifact.sha256) {
      throw new EnergyError('signature-invalid', 'receipt digest does not match its artifact', {
        receiptId: receipt.id,
      });
    }
    try {
      const sessionId = name.slice('settlement:'.length);
      if (meta.sessionId !== sessionId) {
        throw new EnergyError('signature-invalid', 'receipt meta.sessionId is not the artifact id');
      }
      if (meta.currency !== CURRENCY) {
        throw new EnergyError('signature-invalid', `receipt currency is not ${CURRENCY}`);
      }
      const chargerWh = metaNumber(meta, 'chargerWh');
      const meterWh = metaNumber(meta, 'meterWh');
      const driftWh = metaNumber(meta, 'driftWh');
      const toleranceWh = metaNumber(meta, 'toleranceWh');
      // The verifier redoes the arithmetic instead of trusting the signer's
      // drift: a receipt that claims "0 Wh drift" while its numbers disagree is
      // a receipt that cannot be audited.
      if (driftWh !== Math.abs(chargerWh - meterWh)) {
        throw new EnergyError('signature-invalid', 'receipt drift does not match its energies');
      }
      if (driftWh > toleranceWh) {
        throw new EnergyError('signature-invalid', 'receipt bills a session outside its tolerance');
      }
      const startedAt = metaNumber(meta, 'startedAt');
      const endedAt = metaNumber(meta, 'endedAt');
      if (startedAt <= 0 || endedAt <= 0 || endedAt > MAX_TIMESTAMP || startedAt > MAX_TIMESTAMP) {
        throw new EnergyError(
          'signature-invalid',
          'receipt timestamps are outside the supported range'
        );
      }
      if (endedAt < startedAt) {
        throw new EnergyError('signature-invalid', 'receipt ends before it starts');
      }
      return {
        sessionId,
        chargerWh,
        meterWh,
        driftWh,
        toleranceWh,
        withinTolerance: true,
        amountSatang: metaNumber(meta, 'amountSatang'),
        site: assertSiteId(meta.site),
        connectorId: assertConnectorId(meta.connectorId),
        vehicleId: assertVehicleId(meta.vehicleId),
        meterId: assertMeterId(meta.meterId),
        currency: CURRENCY,
        status: 'matched',
        receiptId: receipt.id,
      };
    } catch (error) {
      if (error instanceof EnergyError && error.code === 'signature-invalid') throw error;
      throw new EnergyError('signature-invalid', 'settlement metadata is malformed', {
        cause: error,
        receiptId: receipt.id,
      });
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private readStop(input: StopChargeInput): {
    chargerStopWh: number;
    meterStop: MeterReading;
  } {
    const raw = input as StopChargeInput | null | undefined;
    return {
      chargerStopWh: assertWh(raw?.chargerStopWh, 'chargerStopWh'),
      meterStop: this.acceptMeter(raw?.meterStop, 'meterStop'),
    };
  }

  private quote(
    session: ChargeSession,
    chargerStopWh: number,
    meterStop: MeterReading
  ): SettlementQuote {
    if (chargerStopWh < session.chargerStartWh) {
      throw new EnergyError('invalid-meter', 'chargerStopWh is below chargerStartWh');
    }
    if (meterStop.meterId !== session.meterStart.meterId) {
      throw new EnergyError(
        'invalid-meter',
        `stop reading came from "${meterStop.meterId}", start came from "${session.meterStart.meterId}"`
      );
    }
    if (meterStop.wh < session.meterStartWh) {
      throw new EnergyError('invalid-meter', 'meterStop.wh is below meterStartWh');
    }
    if (meterStop.at < session.meterStart.at) {
      throw new EnergyError('invalid-meter', 'meter stop reading is older than the start reading');
    }
    const chargerWh = chargerStopWh - session.chargerStartWh;
    const meterWh = meterStop.wh - session.meterStartWh;
    const driftWh = Math.abs(chargerWh - meterWh);
    return {
      sessionId: session.id,
      chargerWh,
      meterWh,
      driftWh,
      toleranceWh: this.toleranceWh,
      withinTolerance: driftWh <= this.toleranceWh,
      amountSatang: amountSatang(meterWh, session.priceSatangPerKwh),
    };
  }

  /** Validates a reading and proves it was signed by the meter pinned for that id. */
  private acceptMeter(input: unknown, field: string): MeterReading {
    let reading: MeterReading;
    try {
      reading = normaliseMeterReading(input);
    } catch (error) {
      throw new EnergyError('invalid-meter', `${field} is not a usable meter reading`, {
        cause: error,
      });
    }
    const pinned = this.meterPins.get(reading.meterId);
    if (reading.signature === undefined) {
      // A pinned meter is *not* allowed to fall back to unsigned readings: an
      // attacker able to reach the bridge could otherwise strip the signature
      // and have the numbers accepted as-is. Unsigned is only ever allowed when
      // the operator explicitly says so for a meter that cannot sign.
      if (!this.allowUnsigned) {
        throw new EnergyError(
          'invalid-meter',
          `${field} is unsigned; pin the meter key with trustMeter() or pass allowUnsignedMeter`
        );
      }
      return reading;
    }
    if (!pinned) {
      throw new EnergyError('untrusted-meter', `no pinned key for meter "${reading.meterId}"`);
    }
    if (!verifyMeterSignature(reading, pinned)) {
      throw new EnergyError(
        'signature-invalid',
        `${field} signature does not verify against the pinned meter key`
      );
    }
    return reading;
  }

  private requireSession(sessionIdInput: unknown, state: 'active' | 'settled'): ChargeSession {
    const id = assertSessionId(sessionIdInput);
    const session = this.records.get(id);
    if (!session) throw new EnergyError('session-not-found', `session ${id} not found`);
    if (session.status !== state) {
      throw new EnergyError(
        'session-not-active',
        `session ${id} is ${session.status}; expected ${state}`
      );
    }
    return session;
  }

  private async seal(
    action: string,
    name: string,
    sha256: string,
    meta: Readonly<Record<string, string>>
  ): Promise<Receipt> {
    try {
      return await this.attest.record({
        action,
        actor: this.siteId,
        artifact: { name, sha256 },
        meta,
      });
    } catch (error) {
      throw new EnergyError('receipt-required', `could not seal ${action}; nothing was written`, {
        cause: error,
      });
    }
  }

  private async loadSessions(): Promise<void> {
    const rawIndex = await readOptional(this.vault, INDEX_PATH);
    if (!rawIndex) return;
    let index: Index;
    try {
      index = parseIndex(rawIndex);
    } catch (error) {
      throw new EnergyError('rollback', 'session index is malformed', { cause: error });
    }
    for (const id of index.sessions) {
      const raw = await readOptional(this.vault, sessionPath(id));
      if (!raw) {
        throw new EnergyError('rollback', `session ${id} is indexed but missing`);
      }
      let session: ChargeSession;
      try {
        session = normaliseSession(parseRecord(raw, `session ${id}`));
      } catch (error) {
        throw new EnergyError('rollback', `stored session ${id} is not self-consistent`, {
          cause: error,
        });
      }
      if (session.id !== id) {
        throw new EnergyError('rollback', `session stored at ${id} hashes to ${session.id}`);
      }
      this.records.set(id, session);
    }
  }

  private async loadMeters(): Promise<void> {
    const raw = await readOptional(this.vault, METERS_PATH);
    if (!raw) return;
    let record: Record<string, unknown>;
    try {
      record = parseRecord(raw, 'meters');
    } catch (error) {
      throw new EnergyError('rollback', 'meter pin file is malformed', { cause: error });
    }
    if (
      record.v !== 1 ||
      typeof record.meters !== 'object' ||
      record.meters === null ||
      Array.isArray(record.meters)
    ) {
      throw new EnergyError('rollback', 'meter pin file is malformed');
    }
    for (const [meterId, key] of Object.entries(record.meters as Record<string, unknown>)) {
      if (typeof key !== 'string') {
        throw new EnergyError('rollback', `meter pin for "${meterId}" is not a string`);
      }
      this.meterPins.set(assertMeterId(meterId), key);
    }
  }

  private async writeMeters(next: Map<string, string>): Promise<void> {
    const meters: Record<string, string> = {};
    for (const id of [...next.keys()].sort()) meters[id] = next.get(id) as string;
    await this.vault.put(METERS_PATH, encode({ v: 1, meters }));
    this.meterPins.clear();
    for (const [id, key] of Object.entries(meters)) this.meterPins.set(id, key);
  }

  private async writeIndex(sessions: readonly string[]): Promise<void> {
    const unique = [...new Set(sessions)].sort();
    const index: Index = { v: 1, sessions: unique };
    await this.vault.put(INDEX_PATH, encode(index));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function metaNumber(meta: Readonly<Record<string, string | undefined>>, field: string): number {
  const value = meta[field];
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new EnergyError('signature-invalid', `settlement meta.${field} is not a whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EnergyError('signature-invalid', `settlement meta.${field} is too large`);
  }
  return parsed;
}

function assertTimestampInput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new EnergyError('invalid-session', 'at must be a positive integer timestamp');
  }
  return value;
}

function parseRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(bytes));
  } catch (error) {
    throw new EnergyError('invalid-session', `${label} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnergyError('invalid-session', `${label} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseIndex(bytes: Uint8Array): Index {
  const record = parseRecord(bytes, 'session index');
  if (record.v !== 1 || !Array.isArray(record.sessions)) {
    throw new EnergyError('rollback', 'session index is malformed');
  }
  const sessions = record.sessions.map(assertSessionId);
  return { v: 1, sessions };
}

function encode(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

export type { ChargeSession };
