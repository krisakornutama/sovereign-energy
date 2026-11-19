# sovereign-energy

Meter-verified charge sessions for Sovereign OS. A charger reports its own counter; the billing meter reports the truth. `sovereign-energy` records the session in [`sovereign-vault`](https://github.com/krisakornutama/sovereign-vault), refuses to bill when the two counters disagree, and seals the settlement as an Ed25519 receipt with [`sovereign-attest`](https://github.com/krisakornutama/sovereign-attest) that anyone can verify offline.

No cloud, no payment processor, no clock authority. The unit of work is one charge session with numbers both sides signed.

## Scope (M1)

- Charge session lifecycle: `start()` → `reconcile()` → `stop()`
- Strict OCPP 2.0.1 `TransactionEvent` subset (`Started` / `Updated` / `Ended`)
- Signed meter readings (Ed25519) and pinned meter keys
- Signed start + settlement receipts, stored in the vault
- Offline audit with `Energy.verifySettlement()`
- Rollback/tamper detection at `open()`, anchored vault roots

Out of scope for this milestone: V2G dispatch and solar forecast (tracked as ENERGY-002/003 in the Sovereign OS roadmap), OCPP transport/WebSocket, payment capture.

## Install

```bash
npm install sovereign-energy sovereign-attest sovereign-vault
```

Plain ESM for Node 20+.

## Use

```ts
import { FileBlobStore, Vault, randomBytes } from 'sovereign-vault';
import { createSigningKey, canonicalJson, signBytes, utf8 } from 'sovereign-attest';
import { Energy, parseTransactionEvent, type MeterReading } from 'sovereign-energy';

const meterKey = createSigningKey('meter-1', Date.now());
const sign = (wh: number, at: number): MeterReading => ({
  wh,
  at,
  meterId: 'meter-1',
  signature: signBytes(meterKey.privateKey, utf8(canonicalJson({ wh, at, meterId: 'meter-1' }))),
});

const vault = await Vault.open({ store: new FileBlobStore('./vault'), masterKey });
const energy = await Energy.open({ vault, site: 'home-a', keyId: 'energy' });

// One-time trust: readings from any other key are refused, not "best effort".
await energy.trustMeter('meter-1', meterKey.publicKey);

// OCPP 2.0.1 Started event → the numbers settlement needs.
const started = parseTransactionEvent({
  eventType: 'Started',
  timestamp: '2026-11-19T08:00:00.000Z',
  transactionInfo: { transactionId: 'tx-1', meterStart: 900_000 },
  evse: { id: 1 },
  idToken: { idToken: 'ev:vin-hash' },
});
// { kind: 'start', transactionId: 'tx-1', connectorId: '1', chargerStartWh: 900000, at }

const session = await energy.start({
  connectorId: '1',
  vehicleId: 'ev:vin-hash',
  priceSatangPerKwh: 450,
  chargerStartWh: 900_000,
  meterStart: sign(900_000, Date.now()),
});

// Before stopping, see the drift while the session is still open.
const quote = energy.reconcile(session.id, {
  chargerStopWh: 913_500,
  meterStop: sign(913_600, Date.now()),
});

// Bills the meter, not the charger. Refuses with `meter-mismatch` beyond tolerance.
const { settlement } = await energy.stop(session.id, {
  chargerStopWh: 913_500,
  meterStop: sign(913_600, Date.now()),
});

// Later, on a different machine, with only the pinned site key:
const audited = Energy.verifySettlement(settlement.receipt, { publicKey: energy.publicKey() });
// { sessionId, chargerWh: 13500, meterWh: 13600, driftWh: 100, amountSatang: 6120, ... }
```

The session is stored as a single JSON record whose id is the SHA-256 of its immutable header, so two independent devices that see the same start event compute the same session id.

## What it guarantees

| Guarantee                           | How                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The meter is the source of truth    | `amountSatang` is computed from `meterWh`, and `meterWh` is the signed meter reading minus its signed start                                                                      |
| No billing with unverified numbers  | `stop()` compares signed meter energy with the charger counter; drift above `toleranceWh` (default 100 Wh) throws `meter-mismatch` and the session stays `active`                |
| Meter readings are attributable     | A reading verifies against the public key pinned for _that_ `meterId`. A pinned meter may not send unsigned readings                                                             |
| A receipt exists before a bill does | The settlement receipt is sealed before the settled record is written. If sealing fails, `stop()` throws `receipt-required` and nothing is billed                                |
| Receipts are offline-verifiable     | `Energy.verifySettlement()` rebuilds the claims from the signed body and rechecks the arithmetic: drift = \|charger − meter\|, drift ≤ tolerance, timestamps in range            |
| No silent edits on disk             | `open()` revalidates every stored session; a record that no longer hashes its header, a missing indexed session, a malformed index or meter file all fail closed with `rollback` |
| Rollback evidence                   | `anchor()` / `checkAnchor()` pin the vault root into an append-only log, so truncating the whole store is visible                                                                |
| Exact arithmetic                    | Every Wh and satang is an integer inside documented caps (`MAX_ENERGY_WH`, `MAX_PRICE_SATANG_PER_KWH`, `MAX_TOLERANCE_WH`), and amounts are whole satang, half-up                |
| Unknown fields are refused          | Meter readings and session records reject fields the code does not understand, so a signature cannot cover one payload while the verifier reads another                          |

## Failure codes are the contract

```ts
import { EnergyError } from 'sovereign-energy';

try {
  await energy.stop(session.id, { chargerStopWh, meterStop });
} catch (error) {
  if (error instanceof EnergyError) {
    // 'meter-mismatch' | 'invalid-meter' | 'untrusted-meter' | 'signature-invalid'
    // | 'connector-busy' | 'session-not-found' | 'session-not-active'
    // | 'receipt-required' | 'rollback' | 'invalid-ocpp' ...
    console.error(error.code, error.details);
  }
}
```

`meter-mismatch` carries the numbers an operator needs (`chargerWh`, `meterWh`, `driftWh`, `toleranceWh`) so a bridge can show "check the CT clamp" instead of a stack trace.

## Design notes

- **Sign what you mean.** A meter signs the UTF-8 bytes of `canonicalJson({ wh, at, meterId })`. The verifier rebuilds those exact bytes; it never re-serialises a mutable object.
- **Fail closed.** A receipt that cannot be written aborts the operation. A stored record that cannot be validated aborts `open()` rather than being repaired silently.
- **Bound the inputs.** `wh`, timestamps, tolerance, price and sample counts all have hard ceilings, so a hostile peer cannot turn one settlement into an overflow or a memory blow-up.
- **Tolerance is a parameter, not a hope.** It is stored in the signed settlement body, so a receipt proves the tolerance that was actually applied.

## Test

```bash
npm run lint
npm run typecheck
npm run format:check
npm run test:coverage   # 115 tests, thresholds 90/90/90/80
npm run build
npm run example
```

## License

MIT
