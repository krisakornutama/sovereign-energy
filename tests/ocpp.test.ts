import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES, latestRegisterWh, parseTransactionEvent } from '../src/index.js';
import { rejectsWith } from './helpers.js';

const at = Date.parse('2023-11-14T22:13:20.000Z');

function started(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'Started',
    timestamp: '2023-11-14T22:13:20.000Z',
    transactionInfo: { transactionId: 'tx-1', meterStart: 500_000 },
    evse: { id: 1 },
    idToken: { idToken: 'ev:vin-hash' },
    ...overrides,
  };
}

function updated(meterValue: unknown[]): Record<string, unknown> {
  return {
    eventType: 'Updated',
    timestamp: '2023-11-14T22:13:30.000Z',
    transactionInfo: { transactionId: 'tx-1' },
    meterValue,
  };
}

function ended(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'Ended',
    timestamp: '2023-11-14T22:13:40.000Z',
    transactionInfo: { transactionId: 'tx-1', meterStop: 513_500, stoppedReason: 'EVDisconnected' },
    evse: { id: 1 },
    ...overrides,
  };
}

function sample(value: string, unit?: string): Record<string, unknown> {
  return {
    measurand: 'Energy.Active.Import.Register',
    value,
    ...(unit === undefined ? {} : { unit }),
  };
}

describe('OCPP 2.0.1 transaction events', () => {
  it('parses a Started event into the numbers settlement needs', () => {
    expect(parseTransactionEvent(started())).toEqual({
      kind: 'start',
      transactionId: 'tx-1',
      connectorId: '1',
      vehicleId: 'ev:vin-hash',
      chargerStartWh: 500_000,
      at,
    });
  });

  it('ignores the parts of OCPP a meter check does not need', () => {
    const parsed = parseTransactionEvent(
      started({ seqNo: 1, offline: false, customData: { vendorId: 'x' } })
    );
    expect(parsed.kind).toBe('start');
  });

  it('parses the newest register sample, not the last one in the array', () => {
    const parsed = parseTransactionEvent(
      updated([
        {
          timestamp: '2023-11-14T22:13:35.000Z',
          sampledValue: [sample('513500')],
        },
        {
          timestamp: '2023-11-14T22:13:25.000Z',
          sampledValue: [sample('510000')],
        },
      ])
    );
    expect(parsed).toEqual({
      kind: 'reading',
      transactionId: 'tx-1',
      chargerWh: 513_500,
      at: Date.parse('2023-11-14T22:13:35.000Z'),
    });
  });

  it('converts kWh to whole Wh and rejects subunits', async () => {
    const parsed = parseTransactionEvent(
      updated([
        {
          timestamp: '2023-11-14T22:13:35.000Z',
          sampledValue: [sample('13.6', 'kWh')],
        },
      ])
    );
    expect(parsed).toMatchObject({ kind: 'reading', chargerWh: 13_600 });

    await rejectsWith(
      () =>
        parseTransactionEvent(
          updated([
            {
              timestamp: '2023-11-14T22:13:35.000Z',
              sampledValue: [sample('13.6005', 'kWh')],
            },
          ])
        ),
      'invalid-ocpp'
    );
  });

  it('skips samples that are not the import register', () => {
    const parsed = parseTransactionEvent(
      updated([
        {
          timestamp: '2023-11-14T22:13:35.000Z',
          sampledValue: [
            { measurand: 'Power.Active.Import', value: '11000', unit: 'W' },
            sample('513500'),
          ],
        },
      ])
    );
    expect(parsed).toMatchObject({ chargerWh: 513_500 });

    expect(
      latestRegisterWh([
        {
          timestamp: '2023-11-14T22:13:35.000Z',
          sampledValue: [{ measurand: 'SoC', value: '40', unit: 'Percent' }],
        },
      ])
    ).toBeNull();
  });

  it('parses an Ended event with and without a reason', () => {
    expect(parseTransactionEvent(ended())).toEqual({
      kind: 'end',
      transactionId: 'tx-1',
      connectorId: '1',
      chargerStopWh: 513_500,
      at: Date.parse('2023-11-14T22:13:40.000Z'),
      reason: 'EVDisconnected',
    });
    const { stoppedReason, ...withoutReason } = ended().transactionInfo as Record<string, unknown>;
    expect(stoppedReason).toBe('EVDisconnected');
    expect(parseTransactionEvent(ended({ transactionInfo: withoutReason }))).toEqual({
      kind: 'end',
      transactionId: 'tx-1',
      connectorId: '1',
      chargerStopWh: 513_500,
      at: Date.parse('2023-11-14T22:13:40.000Z'),
    });
  });

  it('rejects unknown event types and shapes it does not understand', async () => {
    const cases: unknown[] = [
      null,
      [],
      { ...started(), eventType: 'MeterValues' },
      { ...started(), transactionInfo: undefined },
      { ...started(), transactionInfo: { transactionId: 'tx 1', meterStart: 1 } },
      { ...started(), timestamp: 'not a date' },
      { ...started(), timestamp: 1_700_000_000_000 },
      { ...started(), evse: { id: 0 } },
      { ...started(), evse: { id: 1.5 } },
      { ...started(), evse: undefined },
      { ...started(), idToken: { idToken: '' } },
      { ...started(), idToken: undefined },
      { ...started(), transactionInfo: { transactionId: 'tx-1', meterStart: -1 } },
      { ...started(), transactionInfo: { transactionId: 'tx-1', meterStart: 1.5 } },
      { ...started(), transactionInfo: { transactionId: 'tx-1' } },
    ];
    for (const input of cases) {
      await rejectsWith(() => parseTransactionEvent(input), 'invalid-ocpp');
    }
  });

  it('rejects malformed meter value payloads', async () => {
    const cases: unknown[] = [
      undefined,
      {},
      [{ timestamp: '2023-11-14T22:13:35.000Z' }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: 'nope' }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [null] }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [sample('abc')] }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [sample('-1')] }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [sample('')] }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [sample('1', 'MWh')] }],
      [{ timestamp: '2023-11-14T22:13:35.000Z', sampledValue: [sample('1000000001')] }],
    ];
    for (const meterValue of cases) {
      await rejectsWith(
        () => parseTransactionEvent(updated(Array.isArray(meterValue) ? meterValue : [meterValue])),
        'invalid-ocpp'
      );
    }
    await rejectsWith(
      () =>
        parseTransactionEvent(
          updated([
            {
              timestamp: '2023-11-14T22:13:35.000Z',
              sampledValue: [{ measurand: 'Power.Active.Import', value: '1', unit: 'W' }],
            },
          ])
        ),
      'invalid-ocpp'
    );
  });

  it('rejects unbounded sample lists before reading them', async () => {
    const huge = new Array(MAX_SAMPLES + 1).fill({});
    await rejectsWith(() => latestRegisterWh(huge), 'invalid-ocpp');
    await rejectsWith(
      () => latestRegisterWh([{ timestamp: 'x', sampledValue: huge }]),
      'invalid-ocpp'
    );
    await rejectsWith(
      () =>
        latestRegisterWh([
          {
            timestamp: '2023-11-14T22:13:35.000Z',
            sampledValue: new Array(MAX_SAMPLES + 1).fill(sample('1')),
          },
        ]),
      'invalid-ocpp'
    );
  });

  it('rejects an unusable stopped reason', async () => {
    await rejectsWith(
      () =>
        parseTransactionEvent(
          ended({
            transactionInfo: { transactionId: 'tx-1', meterStop: 1, stoppedReason: 'bad reason' },
          })
        ),
      'invalid-ocpp'
    );
    await rejectsWith(
      () =>
        parseTransactionEvent(
          ended({ transactionInfo: { transactionId: 'tx-1', meterStop: 1, stoppedReason: 7 } })
        ),
      'invalid-ocpp'
    );
  });
});
