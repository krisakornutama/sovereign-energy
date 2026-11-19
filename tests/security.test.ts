import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex, signBytes, utf8, type Receipt } from 'sovereign-attest';
import type { Vault } from 'sovereign-vault';
import {
  ACTION_CHARGE_SETTLED,
  ACTION_CHARGE_STARTED,
  Energy,
  EnergyError,
  MAX_PRICE_SATANG_PER_KWH,
  amountSatang,
  normaliseMeterReading,
  verifyMeterSignature,
} from '../src/index.js';
import {
  METER_ID,
  makeEnergy,
  readJson,
  rejectsWith,
  reopen,
  sealWith,
  signedReading,
  startCharge,
  wrapVault,
  writeJson,
  type Fixture,
} from './helpers.js';

const START_WH = 900_000;

async function settle(fixture: Fixture) {
  const active = await startCharge(fixture, {
    chargerStartWh: START_WH,
    meterStart: fixture.signed(START_WH),
  });
  fixture.at(1_000_500);
  const result = await fixture.energy.stop(active.id, {
    chargerStopWh: 913_500,
    meterStop: fixture.signed(913_600),
  });
  return { active, ...result };
}

function meta(overrides: Record<string, string> = {}): Record<string, string> {
  const chargerWh = 13_500;
  const meterWh = 13_600;
  const digest = sha256Hex('forged-settlement');
  return {
    digest,
    sessionId: 'a'.repeat(64),
    site: 'home-a',
    connectorId: '1',
    vehicleId: 'ev:vin-hash',
    meterId: METER_ID,
    chargerWh: String(chargerWh),
    meterWh: String(meterWh),
    driftWh: String(Math.abs(chargerWh - meterWh)),
    toleranceWh: '100',
    amountSatang: String(amountSatang(meterWh, 450)),
    currency: 'THB',
    startedAt: '1000000',
    endedAt: '1000500',
    ...overrides,
  };
}

async function forgeSettlement(
  vault: Vault,
  overrides: {
    name?: string;
    sha256?: string;
    action?: string;
    meta?: Record<string, string>;
  } = {}
): Promise<Receipt> {
  const sha256 = overrides.sha256 ?? sha256Hex('forged-settlement');
  return sealWith(vault, 'energy', {
    action: overrides.action ?? ACTION_CHARGE_SETTLED,
    actor: 'home-a',
    artifact: { name: overrides.name ?? `settlement:${'a'.repeat(64)}`, sha256 },
    meta: meta({ digest: sha256, ...overrides.meta }),
  });
}

describe('meter trust', () => {
  it('refuses unsigned readings by default', async () => {
    const fixture = await makeEnergy({ pin: false });
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: 0,
          meterStart: { wh: 0, at: 1_000_000, meterId: METER_ID },
        }),
      'invalid-meter'
    );
  });

  it('does not let a pinned meter fall back to unsigned readings', async () => {
    const fixture = await makeEnergy();
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: 0,
          meterStart: { wh: 0, at: 1_000_000, meterId: METER_ID },
        }),
      'invalid-meter'
    );
  });

  it('accepts unsigned readings only when explicitly allowed', async () => {
    const fixture = await makeEnergy({ pin: false, allowUnsignedMeter: true });
    const active = await fixture.energy.start({
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      priceSatangPerKwh: 450,
      chargerStartWh: 0,
      meterStart: { wh: 900_000, at: 1_000_000, meterId: METER_ID },
    });
    fixture.at(1_000_500);
    const { settlement } = await fixture.energy.stop(active.id, {
      chargerStopWh: 13_600,
      meterStop: { wh: 913_600, at: 1_000_500, meterId: METER_ID },
    });
    expect(settlement.amountSatang).toBe(6_120);
    await expect(fixture.energy.settlement(active.id)).resolves.toMatchObject({
      receiptId: settlement.receiptId,
    });
  });

  it('refuses a signed reading from a meter that was never pinned', async () => {
    const fixture = await makeEnergy({ pin: false });
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: fixture.signed(START_WH),
        }),
      'untrusted-meter'
    );
  });

  it('refuses a reading signed by an impostor that reuses the meter id', async () => {
    const fixture = await makeEnergy();
    const impostor = await makeEnergy({ pin: false });
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: signedReading(impostor.meter, START_WH, 1_000_000, METER_ID),
        }),
      'signature-invalid'
    );
  });

  it('refuses a reading whose numbers moved after signing', async () => {
    const fixture = await makeEnergy();
    const reading = fixture.signed(START_WH);
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: { ...reading, wh: START_WH + 1 },
        }),
      'signature-invalid'
    );
  });

  it('binds the signature to the canonical payload, not to JSON.stringify order', async () => {
    const fixture = await makeEnergy();
    const impostor = await makeEnergy({ pin: false });
    const payload = { meterId: METER_ID, wh: START_WH, at: 1_000_000 };
    const nonCanonical = {
      wh: payload.wh,
      at: payload.at,
      meterId: payload.meterId,
      signature: signBytes(impostor.meter.privateKey, utf8(JSON.stringify(payload))),
    };
    expect(verifyMeterSignature(nonCanonical, impostor.meter.publicKey)).toBe(false);
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: nonCanonical,
        }),
      'signature-invalid'
    );
  });

  it('rejects readings with fields the verifier would silently ignore', async () => {
    const fixture = await makeEnergy();
    const reading = fixture.signed(START_WH);
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: { ...reading, bonusWh: 1_000 },
        }),
      'invalid-meter'
    );
  });

  it('unpins a meter and then refuses its signatures', async () => {
    const fixture = await makeEnergy();
    expect(fixture.energy.meters()).toEqual([METER_ID]);
    await fixture.energy.untrustMeter(METER_ID);
    expect(fixture.energy.meters()).toEqual([]);
    await rejectsWith(
      () =>
        fixture.energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: fixture.signed(START_WH),
        }),
      'untrusted-meter'
    );
  });

  it('refuses to pin something that is not a public key', async () => {
    const fixture = await makeEnergy();
    await rejectsWith(
      () => fixture.energy.trustMeter('meter-9', fixture.meter.privateKey),
      'untrusted-meter'
    );
    await rejectsWith(
      () => fixture.energy.trustMeter('bad id', fixture.meter.publicKey),
      'invalid-meter'
    );
    await rejectsWith(() => fixture.energy.untrustMeter('bad id'), 'invalid-meter');
  });
});

describe('recorded state cannot be rewritten quietly', () => {
  it('refuses to open a vault whose session record was edited', async () => {
    const fixture = await makeEnergy();
    const { active } = await settle(fixture);
    const path = `energy/session/${active.id}`;
    const stored = (await readJson(fixture.vault, path)) as Record<string, unknown>;
    await writeJson(fixture.vault, path, { ...stored, amountSatang: 1 });
    await rejectsWith(() => reopen(fixture), 'rollback');
  });

  it('refuses to open a vault whose index points at nothing', async () => {
    const fixture = await makeEnergy();
    await startCharge(fixture, { chargerStartWh: START_WH, meterStart: fixture.signed(START_WH) });
    await writeJson(fixture.vault, 'energy/index', { v: 1, sessions: ['b'.repeat(64)] });
    await rejectsWith(() => reopen(fixture), 'rollback');
  });

  it('refuses to open a malformed index', async () => {
    const fixture = await makeEnergy();
    await fixture.vault.put('energy/index', utf8('not json'));
    await rejectsWith(() => reopen(fixture), 'rollback');
    await fixture.vault.put('energy/index', utf8('[]'));
    await rejectsWith(() => reopen(fixture), 'rollback');
    await writeJson(fixture.vault, 'energy/index', { v: 2, sessions: [] });
    await rejectsWith(() => reopen(fixture), 'rollback');
  });

  it('refuses a session stored under a path that is not its own id', async () => {
    const fixture = await makeEnergy();
    const active = await startCharge(fixture, {
      chargerStartWh: START_WH,
      meterStart: fixture.signed(START_WH),
    });
    const record = await readJson(fixture.vault, `energy/session/${active.id}`);
    const fake = 'c'.repeat(64);
    await writeJson(fixture.vault, `energy/session/${fake}`, record);
    await writeJson(fixture.vault, 'energy/index', { v: 1, sessions: [fake] });
    await rejectsWith(() => reopen(fixture), 'rollback');
  });

  it('refuses to open a malformed meter pin file', async () => {
    const fixture = await makeEnergy();
    await fixture.vault.put('energy/meters', utf8('not json'));
    await rejectsWith(() => reopen(fixture), 'rollback');
    await writeJson(fixture.vault, 'energy/meters', { v: 1, meters: [] });
    await rejectsWith(() => reopen(fixture), 'rollback');
    await writeJson(fixture.vault, 'energy/meters', { v: 1, meters: { [METER_ID]: 1 } });
    await rejectsWith(() => reopen(fixture), 'rollback');
  });

  it('refuses to open a vault that belongs to another site', async () => {
    const fixture = await makeEnergy();
    await writeJson(fixture.vault, 'energy/site', { v: 1, site: 'home-b' });
    await rejectsWith(() => reopen(fixture), 'invalid-session');
  });

  it('surfaces a real store failure instead of treating it as "absent"', async () => {
    const fixture = await makeEnergy();
    const broken = wrapVault(fixture.vault, {
      failGet: (path) => path === 'energy/index',
    });
    await expect(
      Energy.open({ vault: broken, site: 'home-a', now: fixture.clock })
    ).rejects.toThrow(/injected get failure/);
  });

  it('rejects a settlement receipt that does not cover this session', async () => {
    const fixture = await makeEnergy();
    const { active } = await settle(fixture);
    const forged = await sealWith(fixture.vault, 'energy', {
      action: ACTION_CHARGE_SETTLED,
      actor: 'home-a',
      artifact: { name: `settlement:${'b'.repeat(64)}`, sha256: sha256Hex('other') },
    });
    const path = `energy/session/${active.id}`;
    const stored = (await readJson(fixture.vault, path)) as Record<string, unknown>;
    await writeJson(fixture.vault, path, { ...stored, settlementReceiptId: forged.id });
    const reopened = await reopen(fixture);
    await rejectsWith(() => reopened.settlement(active.id), 'signature-invalid');
  });

  it('reports a deleted settlement receipt as a rollback, not as success', async () => {
    const fixture = await makeEnergy();
    const { active, settlement } = await settle(fixture);
    await fixture.vault.delete(`attest/receipts/${settlement.receiptId}.json`);
    await rejectsWith(() => fixture.energy.settlement(active.id), 'rollback');
  });

  it('rejects a settlement receipt that no longer hashes its own body', async () => {
    const fixture = await makeEnergy();
    const { active, settlement } = await settle(fixture);
    const path = `attest/receipts/${settlement.receiptId}.json`;
    const stored = (await readJson(fixture.vault, path)) as {
      body: { meta: Record<string, string> };
    };
    stored.body.meta.amountSatang = '1';
    await writeJson(fixture.vault, path, stored);
    await rejectsWith(() => fixture.energy.settlement(active.id), 'signature-invalid');
  });

  it('rejects a stored receipt that is not a settlement', async () => {
    const fixture = await makeEnergy();
    const { active } = await settle(fixture);
    const forged = await sealWith(fixture.vault, 'energy', {
      action: ACTION_CHARGE_STARTED,
      actor: 'home-a',
      artifact: { name: `settlement:${active.id}`, sha256: sha256Hex('other') },
    });
    const path = `energy/session/${active.id}`;
    const stored = (await readJson(fixture.vault, path)) as Record<string, unknown>;
    await writeJson(fixture.vault, path, {
      ...stored,
      settlementReceiptId: forged.id,
    });
    const reopened = await reopen(fixture);
    await rejectsWith(() => reopened.settlement(active.id), 'signature-invalid');
  });
});

describe('settlement receipts are checked, not trusted', () => {
  it('accepts a well-formed receipt from the site key', async () => {
    const fixture = await makeEnergy();
    const receipt = await forgeSettlement(fixture.vault);
    const report = Energy.verifySettlement(receipt, {
      publicKey: fixture.energy.publicKey(),
    });
    expect(report).toMatchObject({
      sessionId: 'a'.repeat(64),
      chargerWh: 13_500,
      meterWh: 13_600,
      driftWh: 100,
      amountSatang: 6_120,
      withinTolerance: true,
      status: 'matched',
    });
  });

  it('rejects a tampered signature', async () => {
    const fixture = await makeEnergy();
    const receipt = await forgeSettlement(fixture.vault);
    await rejectsWith(
      () =>
        Energy.verifySettlement(
          { ...receipt, sig: `${receipt.sig.slice(0, -4)}AAAA` },
          { publicKey: fixture.energy.publicKey() }
        ),
      'signature-invalid'
    );
  });

  it('rejects receipts about something other than a settlement', async () => {
    const fixture = await makeEnergy();
    const wrongAction = await forgeSettlement(fixture.vault, {
      action: ACTION_CHARGE_STARTED,
    });
    await rejectsWith(
      () => Energy.verifySettlement(wrongAction, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );

    const wrongName = await forgeSettlement(fixture.vault, { name: 'charge:abc' });
    await rejectsWith(
      () => Energy.verifySettlement(wrongName, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );
  });

  it('rejects a meta digest that does not match the artifact', async () => {
    const fixture = await makeEnergy();
    const receipt = await forgeSettlement(fixture.vault, {
      meta: { digest: sha256Hex('somewhere else') },
    });
    await rejectsWith(
      () => Energy.verifySettlement(receipt, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );
  });

  it('rejects a receipt that bills outside its own tolerance', async () => {
    const fixture = await makeEnergy();
    const receipt = await forgeSettlement(fixture.vault, {
      meta: { driftWh: '50' },
    });
    await rejectsWith(
      () => Energy.verifySettlement(receipt, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );

    const overTolerance = await forgeSettlement(fixture.vault, {
      meta: { toleranceWh: '99' },
    });
    await rejectsWith(
      () => Energy.verifySettlement(overTolerance, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );
  });

  it('rejects malformed settlement metadata', async () => {
    const fixture = await makeEnergy();
    const cases: Record<string, string>[] = [
      { sessionId: 'b'.repeat(64) },
      { currency: 'USD' },
      { chargerWh: 'abc' },
      { meterWh: '-1' },
      { driftWh: '99999999999999999999' },
      { amountSatang: '1.5' },
      { startedAt: '0' },
      { endedAt: '999999' },
      { site: 'BAD' },
      { connectorId: '' },
      { vehicleId: '' },
      { meterId: ' meter' },
    ];
    for (const override of cases) {
      const receipt = await forgeSettlement(fixture.vault, { meta: override });
      await rejectsWith(
        () => Energy.verifySettlement(receipt, { publicKey: fixture.energy.publicKey() }),
        'signature-invalid'
      );
    }
  });

  it('rejects a receipt without metadata at all', async () => {
    const fixture = await makeEnergy();
    const receipt = await sealWith(fixture.vault, 'energy', {
      action: ACTION_CHARGE_SETTLED,
      actor: 'home-a',
      artifact: { name: `settlement:${'a'.repeat(64)}`, sha256: sha256Hex('x') },
    });
    await rejectsWith(
      () => Energy.verifySettlement(receipt, { publicKey: fixture.energy.publicKey() }),
      'signature-invalid'
    );
  });

  it('rejects a price that would overflow satang arithmetic', async () => {
    const fixture = await makeEnergy();
    const session = await startCharge(fixture, {
      chargerStartWh: START_WH,
      meterStart: fixture.signed(START_WH),
      priceSatangPerKwh: MAX_PRICE_SATANG_PER_KWH,
    });
    fixture.at(1_000_500);
    const { settlement } = await fixture.energy.stop(session.id, {
      chargerStopWh: 913_600,
      meterStop: fixture.signed(913_600),
    });
    expect(Number.isSafeInteger(settlement.amountSatang)).toBe(true);
    expect(settlement.amountSatang).toBe(amountSatang(13_600, MAX_PRICE_SATANG_PER_KWH));
  });
});

describe('fail closed when a receipt cannot be written', () => {
  it('refuses to start a session when its start receipt cannot be stored', async () => {
    const base = await makeEnergy();
    const broken = wrapVault(base.vault, {
      failPut: (path) => path.startsWith('attest/receipts/'),
    });
    const energy = await Energy.open({
      vault: broken,
      site: 'home-a',
      now: base.clock,
    });
    await rejectsWith(
      () =>
        energy.start({
          connectorId: '1',
          vehicleId: 'ev:vin-hash',
          priceSatangPerKwh: 450,
          chargerStartWh: START_WH,
          meterStart: base.signed(START_WH),
        }),
      'receipt-required'
    );
    expect(energy.sessions()).toHaveLength(0);
  });

  it('leaves a session active when its settlement receipt cannot be stored', async () => {
    const base = await makeEnergy();
    const active = await startCharge(base, {
      chargerStartWh: START_WH,
      meterStart: base.signed(START_WH),
    });
    const broken = wrapVault(base.vault, {
      failPut: (path) => path.startsWith('attest/receipts/'),
    });
    const energy = await Energy.open({ vault: broken, site: 'home-a', now: base.clock });
    base.at(1_000_500);
    await rejectsWith(
      () =>
        energy.stop(active.id, {
          chargerStopWh: 913_500,
          meterStop: base.signed(913_600),
        }),
      'receipt-required'
    );
    expect(energy.get(active.id)?.status).toBe('active');
    const stored = (await readJson(base.vault, `energy/session/${active.id}`)) as {
      status: string;
      amountSatang?: number;
    };
    expect(stored.status).toBe('active');
    expect(stored.amountSatang).toBeUndefined();
  });
});

describe('reading guards', () => {
  it('rejects a session id that is not a digest', async () => {
    const fixture = await makeEnergy();
    await rejectsWith(() => fixture.energy.settlement('nope'), 'invalid-session');
    expect(() => fixture.energy.get('nope')).toThrow(EnergyError);
  });

  it('round-trips a signed reading through the public normaliser', async () => {
    const fixture = await makeEnergy();
    const reading = fixture.signed(1, 1_000_000, METER_ID);
    expect(normaliseMeterReading(reading)).toEqual(reading);
    expect(canonicalJson(reading)).toContain('signature');
  });
});
