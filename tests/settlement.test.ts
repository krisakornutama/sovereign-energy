import { beforeAll, describe, expect, it } from 'vitest';
import { loadReceipt } from 'sovereign-attest';
import {
  ACTION_CHARGE_SETTLED,
  ACTION_CHARGE_STARTED,
  Energy,
  EnergyError,
  amountSatang,
  type ChargeSession,
} from '../src/index.js';
import {
  METER_ID,
  makeEnergy,
  reopen,
  rejectsWith,
  signedReading,
  startCharge,
  type Fixture,
} from './helpers.js';

/** Starts at 900 kWh on the charger and 900 kWh on the meter. */
const START_WH = 900_000;

async function startAt(fixture: Fixture, overrides: Parameters<typeof startCharge>[1] = {}) {
  return startCharge(fixture, {
    chargerStartWh: START_WH,
    meterStart: fixture.signed(START_WH),
    ...overrides,
  });
}

describe('meter-verified settlement', () => {
  it('settles a matching session and signs every number', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    expect(active.status).toBe('active');
    expect(active.meterStartWh).toBe(START_WH);

    const startReceipt = await loadReceipt(fixture.vault, active.startReceiptId);
    expect(startReceipt?.body.action).toBe(ACTION_CHARGE_STARTED);
    expect(startReceipt?.body.actor).toBe('home-a');

    fixture.at(1_000_500);
    const { session, settlement } = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });

    expect(session.status).toBe('settled');
    expect(session.endAt).toBe(1_000_500);
    expect(session.settlementReceiptId).toBe(settlement.receiptId);
    expect(settlement).toMatchObject({
      sessionId: active.id,
      site: 'home-a',
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      meterId: METER_ID,
      chargerWh: 13_500,
      meterWh: 13_600,
      driftWh: 100,
      toleranceWh: 100,
      withinTolerance: true,
      amountSatang: 6_120,
      currency: 'THB',
      status: 'matched',
    });
    expect(settlement.receipt.body.action).toBe(ACTION_CHARGE_SETTLED);
    expect(settlement.receipt.body.artifact.name).toBe(`settlement:${active.id}`);
    expect(fixture.energy.get(active.id)).toEqual(session);
  });

  it('bills the meter, not the charger', async () => {
    const fixture = await makeEnergy({ toleranceWh: 1_000 });
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const { settlement } = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_900, // charger over-reports by 300 Wh
      meterStop: fixture.signed(913_600),
    });
    expect(settlement.chargerWh).toBe(13_900);
    expect(settlement.meterWh).toBe(13_600);
    expect(settlement.driftWh).toBe(300);
    expect(settlement.amountSatang).toBe(amountSatang(13_600, 450));
  });

  it('accepts drift exactly at the tolerance and refuses one Wh more', async () => {
    const ok = await makeEnergy();
    const active = await startAt(ok);
    ok.at(1_000_500);
    const { settlement } = await ok.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: ok.signed(913_600),
    });
    expect(settlement.driftWh).toBe(100);

    const bad = await makeEnergy();
    const busy = await startAt(bad);
    bad.at(1_000_500);
    const error = await rejectsWith(
      () =>
        bad.energy.stop(busy.id, {
          chargerStopWh: 913_499,
          meterStop: bad.signed(913_600),
        }),
      'meter-mismatch'
    );
    expect(error.details).toMatchObject({
      sessionId: busy.id,
      chargerWh: 13_499,
      meterWh: 13_600,
      driftWh: 101,
      toleranceWh: 100,
    });
  });

  it('leaves the session active after a mismatch so the reading can be retried', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    await rejectsWith(
      () =>
        fixture.energy.stop(active.id, {
          chargerStopWh: 920_000,
          meterStop: fixture.signed(913_600),
        }),
      'meter-mismatch'
    );

    const still = fixture.energy.get(active.id) as ChargeSession;
    expect(still.status).toBe('active');
    expect(still.settlementReceiptId).toBeUndefined();
    expect(still.amountSatang).toBeUndefined();

    fixture.at(1_000_600);
    const retry = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });
    expect(retry.session.status).toBe('settled');
    expect(retry.settlement.amountSatang).toBe(6_120);
  });

  it('reconcile reports the drift without touching the session', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const quote = fixture.energy.reconcile(active.id, {
      chargerStopWh: 913_900,
      meterStop: fixture.signed(913_600),
    });
    expect(quote).toMatchObject({
      chargerWh: 13_900,
      meterWh: 13_600,
      driftWh: 300,
      withinTolerance: false,
      amountSatang: 6_120,
    });
    expect(fixture.energy.get(active.id)).toEqual(active);
  });

  it('refuses to stop or quote a session twice', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const input = { chargerStopWh: 913_500, meterStop: fixture.signed(913_600) };
    await fixture.energy.stop(active.id, input);
    await rejectsWith(() => fixture.energy.stop(active.id, input), 'session-not-active');
    await rejectsWith(() => fixture.energy.reconcile(active.id, input), 'session-not-active');
  });

  it('rejects unknown sessions and malformed ids', async () => {
    const fixture = await makeEnergy();
    await rejectsWith(
      () =>
        fixture.energy.reconcile('a'.repeat(64), {
          chargerStopWh: 1,
          meterStop: fixture.signed(1),
        }),
      'session-not-found'
    );
    await rejectsWith(
      () => fixture.energy.reconcile('nope', { chargerStopWh: 1, meterStop: fixture.signed(1) }),
      'invalid-session'
    );
    expect(() => fixture.energy.get('nope')).toThrow(EnergyError);
  });

  it('holds a connector until its session is settled, then frees it', async () => {
    const fixture = await makeEnergy();
    const first = await startAt(fixture);
    await rejectsWith(() => startAt(fixture), 'connector-busy');
    fixture.at(1_000_500);
    await fixture.energy.stop(first.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });
    const second = await startAt(fixture, {
      vehicleId: 'ev:second',
      meterStart: fixture.signed(START_WH),
    });
    expect(second.connectorId).toBe('1');
    expect(second.id).not.toBe(first.id);
  });

  it('refuses to overwrite a session when the same header is replayed', async () => {
    const fixture = await makeEnergy();
    const first = await startAt(fixture);
    // Settle without moving the clock, so the connector is free again and the
    // next start would rebuild the *same* header.
    await fixture.energy.stop(first.id, {
      chargerStopWh: 913_600,
      meterStop: fixture.signed(913_600),
    });
    await rejectsWith(() => startAt(fixture), 'invalid-session');
    expect(fixture.energy.sessions()).toHaveLength(1);
    expect(fixture.energy.get(first.id)?.startReceiptId).toBe(first.startReceiptId);
  });

  it('honours a zero tolerance', async () => {
    const fixture = await makeEnergy({ toleranceWh: 0 });
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const { settlement } = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_600,
      meterStop: fixture.signed(913_600),
    });
    expect(settlement.driftWh).toBe(0);

    const strict = await makeEnergy({ toleranceWh: 0 });
    const busy = await startAt(strict);
    strict.at(1_000_500);
    await rejectsWith(
      () =>
        strict.energy.stop(busy.id, {
          chargerStopWh: 913_601,
          meterStop: strict.signed(913_600),
        }),
      'meter-mismatch'
    );
  });

  it('orders settled sessions before active ones', async () => {
    const fixture = await makeEnergy();
    const first = await startAt(fixture);
    fixture.at(1_000_100);
    const second = await startAt(fixture, {
      connectorId: '2',
      vehicleId: 'ev:second',
      meterStart: fixture.signed(START_WH),
    });
    fixture.at(1_000_500);
    await fixture.energy.stop(first.id, {
      chargerStopWh: 913_600,
      meterStop: fixture.signed(913_600),
    });
    expect(fixture.energy.sessions().map((session) => session.id)).toEqual([first.id, second.id]);
  });

  it('orders active sessions by start time', async () => {
    const fixture = await makeEnergy();
    const first = await startAt(fixture);
    fixture.at(1_000_100);
    const second = await startAt(fixture, {
      connectorId: '2',
      vehicleId: 'ev:second',
      meterStart: fixture.signed(START_WH),
    });
    expect(fixture.energy.sessions().map((session) => session.id)).toEqual([first.id, second.id]);
  });

  it('derives the same session id on independent devices', async () => {
    const a = await makeEnergy();
    const b = await makeEnergy();
    const first = await startAt(a);
    const second = await startAt(b);
    expect(first.id).toBe(second.id);
  });
});

describe('settlement receipts', () => {
  let fixture: Fixture;
  let session: ChargeSession;
  let receiptId: string;

  beforeAll(async () => {
    fixture = await makeEnergy();
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const result = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });
    session = result.session;
    receiptId = result.settlement.receiptId;
  });

  it('re-opens the stored receipt and checks it against the record', async () => {
    const report = await fixture.energy.settlement(session.id);
    expect(report).toMatchObject({
      sessionId: session.id,
      chargerWh: 13_500,
      meterWh: 13_600,
      driftWh: 100,
      amountSatang: 6_120,
      receiptId,
      status: 'matched',
    });
    expect(report.receipt.id).toBe(receiptId);
    await rejectsWith(() => fixture.energy.settlement('a'.repeat(64)), 'session-not-found');
  });

  it('lets an auditor verify a receipt with nothing but the pinned key', async () => {
    const stored = await loadReceipt(fixture.vault, receiptId);
    const audited = Energy.verifySettlement(stored as NonNullable<typeof stored>, {
      publicKey: fixture.energy.publicKey(),
    });
    expect(audited.sessionId).toBe(session.id);
  });

  it('verifies offline and reproduces the settlement exactly', async () => {
    const stored = await loadReceipt(fixture.vault, receiptId);
    expect(stored).not.toBeNull();
    const audited = Energy.verifySettlement(stored as NonNullable<typeof stored>, {
      publicKey: fixture.energy.publicKey(),
    });
    expect(audited).toMatchObject({
      sessionId: session.id,
      chargerWh: 13_500,
      meterWh: 13_600,
      driftWh: 100,
      toleranceWh: 100,
      withinTolerance: true,
      amountSatang: 6_120,
      site: 'home-a',
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      meterId: METER_ID,
      currency: 'THB',
      status: 'matched',
      receiptId,
    });
  });

  it('refuses a receipt signed by a different site', async () => {
    const other = await makeEnergy({ site: 'home-b' });
    const active = await startAt(other);
    other.at(1_000_500);
    const result = await other.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: other.signed(913_600),
    });
    await rejectsWith(
      () =>
        Energy.verifySettlement(result.settlement.receipt, {
          publicKey: fixture.energy.publicKey(),
        }),
      'signature-invalid'
    );
  });

  it('anchors and checks the vault root', async () => {
    const report = await fixture.energy.anchor(fixture.anchors);
    expect(report).toMatchObject({ root: await fixture.vault.root() });
    const check = await fixture.energy.checkAnchor(fixture.anchors);
    expect(check).toMatchObject({
      root: await fixture.vault.root(),
      anchored: await fixture.vault.root(),
    });
    await expect(fixture.energy.checkAnchor(fixture.anchors, 'f'.repeat(64))).rejects.toThrow();
  });
});

describe('start and stop input guards', () => {
  it('rejects malformed start inputs with distinct codes', async () => {
    const fixture = await makeEnergy();
    const valid = {
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      priceSatangPerKwh: 450,
      chargerStartWh: 0,
      meterStart: fixture.signed(0),
    };
    await rejectsWith(
      () => fixture.energy.start({ ...valid, connectorId: '' }),
      'invalid-connector'
    );
    await rejectsWith(() => fixture.energy.start({ ...valid, vehicleId: '' }), 'invalid-session');
    await rejectsWith(
      () => fixture.energy.start({ ...valid, priceSatangPerKwh: 1.5 }),
      'invalid-session'
    );
    await rejectsWith(
      () => fixture.energy.start({ ...valid, chargerStartWh: -1 }),
      'invalid-meter'
    );
    await rejectsWith(
      () => fixture.energy.start({ ...valid, meterStart: undefined }),
      'invalid-meter'
    );
    expect(fixture.energy.sessions()).toHaveLength(0);
  });

  it('rejects a session that ends before it starts', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    await rejectsWith(
      () =>
        fixture.energy.stop(active.id, {
          chargerStopWh: 913_600,
          meterStop: fixture.signed(913_600),
          at: 999_999,
        }),
      'invalid-session'
    );
    await rejectsWith(
      () =>
        fixture.energy.stop(active.id, {
          chargerStopWh: 913_600,
          meterStop: fixture.signed(913_600),
          at: 0,
        }),
      'invalid-session'
    );
  });

  it('rejects a charger or meter that runs backwards', async () => {
    const fixture = await makeEnergy();
    const first = await startAt(fixture);
    fixture.at(1_000_500);
    await rejectsWith(
      () =>
        fixture.energy.stop(first.id, {
          chargerStopWh: START_WH - 1,
          meterStop: fixture.signed(913_600),
        }),
      'invalid-meter'
    );
    const second = await startAt(fixture, {
      connectorId: '2',
      vehicleId: 'ev:second',
      meterStart: fixture.signed(START_WH),
    });
    await rejectsWith(
      () =>
        fixture.energy.stop(second.id, {
          chargerStopWh: 913_600,
          meterStop: fixture.signed(START_WH - 1),
        }),
      'invalid-meter'
    );
  });

  it('rejects a stop reading older than the start reading', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    await rejectsWith(
      () =>
        fixture.energy.stop(active.id, {
          chargerStopWh: 913_600,
          meterStop: fixture.signed(913_600, 999_999),
        }),
      'invalid-meter'
    );
  });

  it('rejects a stop reading from a different meter', async () => {
    const fixture = await makeEnergy();
    const otherMeter = await makeEnergy();
    const active = await startAt(fixture);
    await fixture.energy.trustMeter('meter-2', otherMeter.meter.publicKey);
    fixture.at(1_000_500);
    await rejectsWith(
      () =>
        fixture.energy.stop(active.id, {
          chargerStopWh: 913_600,
          meterStop: signedReading(otherMeter.meter, 913_600, 1_000_500, 'meter-2'),
        }),
      'invalid-meter'
    );
  });
});

describe('opening a site', () => {
  it('refuses a vault that belongs to another site', async () => {
    const fixture = await makeEnergy();
    await expect(
      Energy.open({
        vault: fixture.vault,
        site: 'home-b',
        now: () => 1_000_000,
      })
    ).rejects.toThrow(EnergyError);
  });

  it('rejects invalid options', async () => {
    const fixture = await makeEnergy();
    const base = {
      vault: fixture.vault,
      site: 'home-a',
      now: () => fixture.clock(),
    };
    await rejectsWith(() => Energy.open(undefined as never), 'invalid-session');
    await rejectsWith(() => Energy.open({ ...base, site: 'BAD' }), 'invalid-session');
    await rejectsWith(() => Energy.open({ ...base, toleranceWh: -1 }), 'invalid-session');
    await rejectsWith(() => Energy.open({ ...base, toleranceWh: 1.5 }), 'invalid-session');
  });

  it('restores sessions and meter pins after a reopen', async () => {
    const fixture = await makeEnergy();
    const active = await startAt(fixture);
    fixture.at(1_000_500);
    const { settlement } = await fixture.energy.stop(active.id, {
      chargerStopWh: 913_500,
      meterStop: fixture.signed(913_600),
    });

    const reopened = await reopen(fixture);
    expect(reopened.site()).toBe('home-a');
    expect(reopened.meters()).toEqual([METER_ID]);
    expect(reopened.get(active.id)?.status).toBe('settled');
    const report = await reopened.settlement(active.id);
    expect(report.receiptId).toBe(settlement.receiptId);
    expect(report.amountSatang).toBe(6_120);

    fixture.at(1_000_900);
    const next = await reopened.start({
      connectorId: '2',
      vehicleId: 'ev:next',
      priceSatangPerKwh: 450,
      chargerStartWh: START_WH,
      meterStart: fixture.signed(START_WH),
    });
    expect(next.status).toBe('active');
  });

  it('refuses to open the same store under a different site name', async () => {
    const fixture = await makeEnergy();
    await rejectsWith(() => reopen(fixture, { site: 'home-b' }), 'invalid-session');
  });

  it('exposes the site public key that matches the receipts', async () => {
    const fixture = await makeEnergy();
    expect(fixture.energy.publicKey()).toContain('BEGIN PUBLIC KEY');
    expect(fixture.energy.site()).toBe('home-a');
  });
});
