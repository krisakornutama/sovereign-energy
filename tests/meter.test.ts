import { describe, expect, it } from 'vitest';
import { canonicalJson, createSigningKey, fromUtf8, signBytes, utf8 } from 'sovereign-attest';
import {
  MAX_ENERGY_WH,
  MAX_TIMESTAMP,
  assertMeterId,
  assertTimestamp,
  assertWh,
  meterPayload,
  normaliseMeterKey,
  normaliseMeterReading,
  sameMeterKey,
  verifyMeterSignature,
  type MeterReading,
} from '../src/index.js';
import { rejectsWith } from './helpers.js';

const meter = createSigningKey('meter-1', 1);

function signed(reading: { wh: number; at: number; meterId: string }): MeterReading {
  return {
    ...reading,
    signature: signBytes(meter.privateKey, utf8(canonicalJson(reading))),
  };
}

describe('meter readings', () => {
  it('normalises a signed reading without changing it', () => {
    const reading = signed({ wh: 913_600, at: 1_000_500, meterId: 'meter-1' });
    expect(normaliseMeterReading(reading)).toEqual(reading);
  });

  it('treats the signature as optional but bounded', () => {
    expect(normaliseMeterReading({ wh: 1, at: 1, meterId: 'm' })).toEqual({
      wh: 1,
      at: 1,
      meterId: 'm',
    });
    expect(() => normaliseMeterReading({ wh: 1, at: 1, meterId: 'm', signature: '' })).toThrow(
      /signature/
    );
    expect(() =>
      normaliseMeterReading({ wh: 1, at: 1, meterId: 'm', signature: 'a'.repeat(513) })
    ).toThrow(/too long/);
  });

  it('rejects unknown fields so a signed payload cannot hide extra meaning', () => {
    expect(() => normaliseMeterReading({ wh: 1, at: 1, meterId: 'm', price: 1 })).toThrow(
      /"price"/
    );
  });

  it('rejects shapes that are not objects', () => {
    for (const value of [null, [], 'reading', 42]) {
      expect(() => normaliseMeterReading(value)).toThrow(/must be an object/);
    }
  });

  it('caps energy and rejects fractional Wh', async () => {
    expect(assertWh(MAX_ENERGY_WH, 'wh')).toBe(MAX_ENERGY_WH);
    await rejectsWith(() => assertWh(MAX_ENERGY_WH + 1, 'wh'), 'invalid-meter');
    await rejectsWith(() => assertWh(1.5, 'wh'), 'invalid-meter');
    await rejectsWith(() => assertWh(-1, 'wh'), 'invalid-meter');
    await rejectsWith(() => assertWh('1', 'wh'), 'invalid-meter');
  });

  it('accepts positive integer timestamps only', async () => {
    expect(assertTimestamp(MAX_TIMESTAMP, 'at')).toBe(MAX_TIMESTAMP);
    await rejectsWith(() => assertTimestamp(0, 'at'), 'invalid-meter');
    await rejectsWith(() => assertTimestamp(-1, 'at'), 'invalid-meter');
    await rejectsWith(() => assertTimestamp(MAX_TIMESTAMP + 1, 'at'), 'invalid-meter');
    await rejectsWith(() => assertTimestamp(1.5, 'at'), 'invalid-meter');
  });

  it('accepts meter ids with the documented alphabet only', async () => {
    expect(assertMeterId('meter-1')).toBe('meter-1');
    expect(assertMeterId('site/meter:1')).toBe('site/meter:1');
    await rejectsWith(() => assertMeterId(''), 'invalid-meter');
    await rejectsWith(() => assertMeterId('-leading'), 'invalid-meter');
    await rejectsWith(() => assertMeterId('a'.repeat(129)), 'invalid-meter');
    await rejectsWith(() => assertMeterId('meter 1'), 'invalid-meter');
  });

  it('signs exactly the canonical {wh, at, meterId} payload', () => {
    const reading = signed({ wh: 10, at: 20, meterId: 'meter-1' });
    expect(fromUtf8(meterPayload(reading))).toBe(
      canonicalJson({ wh: 10, at: 20, meterId: 'meter-1' })
    );
  });

  it('verifies a genuine signature and rejects every mutation', () => {
    const reading = signed({ wh: 10, at: 20, meterId: 'meter-1' });
    expect(verifyMeterSignature(reading, meter.publicKey)).toBe(true);
    expect(verifyMeterSignature({ ...reading, wh: 11 }, meter.publicKey)).toBe(false);
    expect(verifyMeterSignature({ ...reading, at: 21 }, meter.publicKey)).toBe(false);
    expect(verifyMeterSignature({ ...reading, meterId: 'meter-2' }, meter.publicKey)).toBe(false);
    expect(verifyMeterSignature({ ...reading, signature: 'not base64' }, meter.publicKey)).toBe(
      false
    );
  });

  it('refuses a signature from a different key', () => {
    const other = createSigningKey('meter-2', 2);
    const reading = signed({ wh: 10, at: 20, meterId: 'meter-1' });
    expect(verifyMeterSignature(reading, other.publicKey)).toBe(false);
  });

  it('returns false instead of throwing for unusable keys and missing signatures', () => {
    const reading = signed({ wh: 10, at: 20, meterId: 'meter-1' });
    expect(verifyMeterSignature(reading, 'not a key')).toBe(false);
    expect(verifyMeterSignature(reading, undefined)).toBe(false);
    const { signature, ...unsigned } = reading;
    expect(signature).toBeDefined();
    expect(verifyMeterSignature(unsigned, meter.publicKey)).toBe(false);
  });

  it('normalises PEM keys and compares them by key material', () => {
    const normalised = normaliseMeterKey(meter.publicKey);
    expect(normalised).toContain('BEGIN PUBLIC KEY');
    expect(sameMeterKey(normalised, meter.publicKey)).toBe(true);
    const other = createSigningKey('meter-2', 2);
    expect(sameMeterKey(normalised, other.publicKey)).toBe(false);
  });

  it('rejects keys that are not usable public keys', async () => {
    await rejectsWith(() => normaliseMeterKey(''), 'untrusted-meter');
    await rejectsWith(() => normaliseMeterKey(meter.privateKey), 'untrusted-meter');
    await rejectsWith(
      () => normaliseMeterKey('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----'),
      'untrusted-meter'
    );
    await rejectsWith(() => normaliseMeterKey(42), 'untrusted-meter');
  });

  it('treats an unparsable key comparison as "not the same key"', () => {
    expect(sameMeterKey('nonsense', 'nonsense')).toBe(false);
  });
});
