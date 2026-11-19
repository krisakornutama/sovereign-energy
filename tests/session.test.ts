import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from 'sovereign-attest';
import {
  CURRENCY,
  DEFAULT_TOLERANCE_WH,
  MAX_PRICE_SATANG_PER_KWH,
  SESSION_VERSION,
  amountSatang,
  assertConnectorId,
  assertPrice,
  assertSessionId,
  assertSiteId,
  assertVehicleId,
  normaliseSession,
  sessionHeader,
  sessionId,
  settlementBody,
  settlementDigest,
  type ChargeSession,
  type SessionHeader,
  type MeterReading,
} from '../src/index.js';
import { makeEnergy, rejectsWith, startCharge, type Fixture } from './helpers.js';

const header: SessionHeader = {
  v: 1,
  site: 'home-a',
  connectorId: '1',
  vehicleId: 'ev:vin-hash',
  priceSatangPerKwh: 450,
  chargerStartWh: 900_000,
  meterStartWh: 900_000,
  startAt: 1_000_000,
};

describe('session identity', () => {
  it('hashes the canonical header with SHA-256', () => {
    expect(sessionId(header)).toBe(sha256Hex(canonicalJson(header)));
  });

  it('gives every header field a say in the id', () => {
    const base = sessionId(header);
    const mutations: SessionHeader[] = [
      { ...header, v: 2 as 1 },
      { ...header, site: 'home-b' },
      { ...header, connectorId: '2' },
      { ...header, vehicleId: 'ev:other' },
      { ...header, priceSatangPerKwh: 451 },
      { ...header, chargerStartWh: 900_001 },
      { ...header, meterStartWh: 900_001 },
      { ...header, startAt: 1_000_001 },
    ];
    const ids = new Set([base, ...mutations.map(sessionId)]);
    expect(ids.size).toBe(mutations.length + 1);
  });

  it('is stable across processes because canonical JSON sorts keys', () => {
    const same: SessionHeader = {
      startAt: header.startAt,
      meterStartWh: header.meterStartWh,
      chargerStartWh: header.chargerStartWh,
      priceSatangPerKwh: header.priceSatangPerKwh,
      vehicleId: header.vehicleId,
      connectorId: header.connectorId,
      site: header.site,
      v: 1,
    };
    expect(sessionId(same)).toBe(sessionId(header));
  });
});

describe('field validators', () => {
  it('accepts valid identifiers', () => {
    expect(assertSiteId('home-a')).toBe('home-a');
    expect(assertConnectorId('1')).toBe('1');
    expect(assertVehicleId('ev:vin-hash')).toBe('ev:vin-hash');
    expect(assertSessionId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(assertPrice(0)).toBe(0);
    expect(assertPrice(MAX_PRICE_SATANG_PER_KWH)).toBe(MAX_PRICE_SATANG_PER_KWH);
  });

  it('rejects bad identifiers with the documented codes', async () => {
    await rejectsWith(() => assertSiteId('Home-A'), 'invalid-session');
    await rejectsWith(() => assertSiteId(''), 'invalid-session');
    await rejectsWith(() => assertSiteId(1), 'invalid-session');
    await rejectsWith(() => assertConnectorId(''), 'invalid-connector');
    await rejectsWith(() => assertConnectorId('my connector'), 'invalid-connector');
    await rejectsWith(() => assertVehicleId(''), 'invalid-session');
    await rejectsWith(() => assertSessionId('A'.repeat(64)), 'invalid-session');
    await rejectsWith(() => assertSessionId('a'.repeat(63)), 'invalid-session');
    await rejectsWith(() => assertSessionId(42), 'invalid-session');
  });

  it('keeps prices inside the documented range', async () => {
    await rejectsWith(() => assertPrice(-1), 'invalid-session');
    await rejectsWith(() => assertPrice(1.5), 'invalid-session');
    await rejectsWith(() => assertPrice(MAX_PRICE_SATANG_PER_KWH + 1), 'invalid-session');
    await rejectsWith(() => assertPrice('450'), 'invalid-session');
  });

  it('rounds amounts half-up to whole satang', () => {
    expect(amountSatang(0, 450)).toBe(0);
    expect(amountSatang(1_000, 450)).toBe(450);
    expect(amountSatang(1_234, 450)).toBe(555);
    expect(amountSatang(1_235, 450)).toBe(556);
    expect(amountSatang(500, 1)).toBe(1);
    expect(amountSatang(1, 1)).toBe(0);
  });
});

describe('session records read back from disk', () => {
  let fixture: Fixture;
  let active: ChargeSession;
  let settled: ChargeSession;

  beforeAll(async () => {
    fixture = await makeEnergy();
    active = await startCharge(fixture, {
      chargerStartWh: 900_000,
      meterStart: fixture.signed(900_000),
    });
    fixture.at(1_000_500);
    const result = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });
    settled = result.session;
  });

  it('round-trips an active session', () => {
    expect(normaliseSession(active)).toEqual(active);
    expect(active.status).toBe('active');
    expect(active.amountSatang).toBeUndefined();
  });

  it('round-trips a settled session and its arithmetic', () => {
    expect(normaliseSession(settled)).toEqual(settled);
    expect(settled.chargerWh).toBe(13_500);
    expect(settled.meterWh).toBe(13_600);
    expect(settled.driftWh).toBe(100);
    expect(settled.amountSatang).toBe(6_120);
  });

  it('builds the header from a record', () => {
    expect(sessionHeader(settled)).toEqual(header);
  });

  it('rejects non-object shapes', () => {
    for (const value of [null, [], 'session', 42]) {
      expect(() => normaliseSession(value)).toThrow(/must be an object/);
    }
  });

  it('rejects unknown fields and wrong versions', async () => {
    await rejectsWith(() => normaliseSession({ ...active, extra: true }), 'invalid-session');
    await rejectsWith(() => normaliseSession({ ...active, v: 2 }), 'invalid-session');
  });

  it('rejects an id that does not hash its own header', async () => {
    await rejectsWith(() => normaliseSession({ ...active, id: 'f'.repeat(64) }), 'invalid-session');
  });

  it('rejects a start reading that disagrees with the header', async () => {
    const meterStart = active.meterStart as MeterReading;
    await rejectsWith(
      () =>
        normaliseSession({
          ...active,
          meterStart: { ...meterStart, wh: meterStart.wh + 1 },
        }),
      'invalid-session'
    );
  });

  it('rejects a start receipt that is not a receipt id', async () => {
    await rejectsWith(
      () => normaliseSession({ ...active, startReceiptId: 'not-a-receipt' }),
      'invalid-session'
    );
  });

  it('rejects an unknown status', async () => {
    await rejectsWith(() => normaliseSession({ ...active, status: 'pending' }), 'invalid-session');
  });

  it('rejects an active session that carries settled fields', async () => {
    await rejectsWith(() => normaliseSession({ ...active, amountSatang: 0 }), 'invalid-session');
  });

  it('rejects a settled session with no settlement receipt', async () => {
    await rejectsWith(
      () => normaliseSession({ ...settled, settlementReceiptId: undefined }),
      'invalid-session'
    );
  });

  it('rejects a settled session with no stop reading', async () => {
    await rejectsWith(
      () => normaliseSession({ ...settled, meterStop: undefined }),
      'invalid-session'
    );
  });

  it('rejects a stop reading that disagrees with meterStopWh', async () => {
    const meterStop = settled.meterStop as MeterReading;
    await rejectsWith(
      () =>
        normaliseSession({
          ...settled,
          meterStop: { ...meterStop, wh: meterStop.wh + 1 },
        }),
      'invalid-session'
    );
  });

  it('rejects start and stop readings from different meters', async () => {
    const meterStop = settled.meterStop as MeterReading;
    await rejectsWith(
      () =>
        normaliseSession({
          ...settled,
          meterStop: { ...meterStop, meterId: 'meter-2' },
        }),
      'invalid-session'
    );
  });

  it('rejects a meter that runs backwards', async () => {
    const reading = { ...(settled.meterStop as MeterReading), wh: 1 };
    await rejectsWith(
      () => normaliseSession({ ...settled, meterStop: reading, meterStopWh: 1 }),
      'invalid-session'
    );
  });

  it('rejects a charger that runs backwards', async () => {
    await rejectsWith(() => normaliseSession({ ...settled, chargerStopWh: 1 }), 'invalid-session');
  });

  it('rejects energies that do not equal stop minus start', async () => {
    await rejectsWith(() => normaliseSession({ ...settled, chargerWh: 13_501 }), 'invalid-session');
    await rejectsWith(() => normaliseSession({ ...settled, meterWh: 13_601 }), 'invalid-session');
  });

  it('rejects a drift that does not match the two energies', async () => {
    await rejectsWith(() => normaliseSession({ ...settled, driftWh: 99 }), 'invalid-session');
  });

  it('rejects an amount that is not meterWh × price', async () => {
    await rejectsWith(
      () => normaliseSession({ ...settled, amountSatang: 6_121 }),
      'invalid-session'
    );
    await rejectsWith(() => normaliseSession({ ...settled, amountSatang: -1 }), 'invalid-session');
    await rejectsWith(() => normaliseSession({ ...settled, amountSatang: 1.5 }), 'invalid-session');
  });

  it('rejects a missing or invalid end time', async () => {
    await rejectsWith(() => normaliseSession({ ...settled, endAt: 0 }), 'invalid-session');
    await rejectsWith(() => normaliseSession({ ...settled, endAt: undefined }), 'invalid-session');
  });
});

describe('settlement body', () => {
  let settled: ChargeSession;

  beforeAll(async () => {
    const fixture = await makeEnergy();
    const active = await startCharge(fixture, {
      chargerStartWh: 900_000,
      meterStart: fixture.signed(900_000),
    });
    fixture.at(1_000_500);
    const result = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });
    settled = result.session;
  });

  it('names every number an auditor needs', () => {
    const body = settlementBody(settled, DEFAULT_TOLERANCE_WH);
    expect(body).toEqual({
      v: SESSION_VERSION,
      sessionId: settled.id,
      site: 'home-a',
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      meterId: 'meter-1',
      chargerWh: 13_500,
      meterWh: 13_600,
      driftWh: 100,
      toleranceWh: 100,
      amountSatang: 6_120,
      currency: CURRENCY,
      startedAt: 1_000_000,
      endedAt: 1_000_500,
    });
  });

  it('refuses to describe an active session', async () => {
    const fixture = await makeEnergy();
    const active = await startCharge(fixture);
    await rejectsWith(() => settlementBody(active, 100), 'invalid-session');
  });

  it('changes when the tolerance changes, so the digest binds it', () => {
    expect(settlementDigest(settled, 100)).not.toBe(settlementDigest(settled, 101));
  });
});
