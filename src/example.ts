/**
 * CLI demo: one charge session, an OCPP 2.0.1 start event, and a settlement that
 * a third party can verify offline. Run with `npm run example`.
 */
import { MemoryBlobStore, Vault, randomBytes } from 'sovereign-vault';
import { createSigningKey, signBytes, canonicalJson, utf8 } from 'sovereign-attest';
import {
  Energy,
  EnergyError,
  parseTransactionEvent,
  verifyMeterSignature,
  type MeterReading,
} from './index.js';

const meterKey = createSigningKey('meter-1', 1_700_000_000_000);

function signed(wh: number, at: number): MeterReading {
  const payload = { wh, at, meterId: 'meter-1' };
  return {
    wh,
    at,
    meterId: 'meter-1',
    signature: signBytes(meterKey.privateKey, utf8(canonicalJson(payload))),
  };
}

const vault = await Vault.open({ store: new MemoryBlobStore(), masterKey: randomBytes(32) });
const energy = await Energy.open({
  vault,
  site: 'home-a',
  keyId: 'energy',
  now: () => 1_700_000_100_000,
});
await energy.trustMeter('meter-1', meterKey.publicKey);

const started = parseTransactionEvent({
  eventType: 'Started',
  timestamp: '2023-11-14T22:13:20.000Z',
  transactionInfo: { transactionId: 'tx-1', meterStart: 500_000 },
  evse: { id: 1 },
  idToken: { type: 'ISO14443', idToken: 'ev:vin-hash' },
});
console.log('parsed OCPP event:', started);

const session = await energy.start({
  connectorId: '1',
  vehicleId: 'ev:vin-hash',
  priceSatangPerKwh: 450,
  chargerStartWh: 500_000,
  meterStart: signed(900_000, 1_700_000_000_000),
});
console.log(
  `session ${session.id.slice(0, 12)}… started, receipt ${session.startReceiptId.slice(0, 12)}…`
);

const stopReading = signed(913_600, 1_700_000_900_000);
console.log('meter signature verifies:', verifyMeterSignature(stopReading, meterKey.publicKey));

const { settlement } = await energy.stop(session.id, {
  chargerStopWh: 513_500,
  meterStop: stopReading,
});
console.log(
  `settled: charger ${settlement.chargerWh} Wh · meter ${settlement.meterWh} Wh · ` +
    `drift ${settlement.driftWh} Wh · ${settlement.amountSatang / 100} THB`
);

const audited = Energy.verifySettlement(settlement.receipt, { publicKey: energy.publicKey() });
console.log('verified offline:', audited.amountSatang === settlement.amountSatang, audited.status);

// A charger that over-reports is refused before anything is billed.
const second = await energy.start({
  connectorId: '2',
  vehicleId: 'ev:vin-hash',
  priceSatangPerKwh: 450,
  chargerStartWh: 0,
  meterStart: signed(1_000_000, 1_700_001_000_000),
});
try {
  await energy.stop(second.id, {
    chargerStopWh: 20_000,
    meterStop: signed(1_005_000, 1_700_001_500_000),
  });
} catch (error) {
  if (error instanceof EnergyError) {
    console.log('mismatch refused:', error.code, error.details);
  }
}
console.log('session 2 still active:', energy.get(second.id)?.status);
