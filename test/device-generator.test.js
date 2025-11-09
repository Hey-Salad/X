const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceGenerator, validateIMEI, validateHeySaladSerial } = require('../src/device-generator');

describe('DeviceGenerator', () => {
  describe('seeding + rng', () => {
    it('uses random seed when omitted', () => {
      const generator = new DeviceGenerator();
      assert.equal(typeof generator.seed, 'string');
      assert.equal(generator.seed.length, 32);
    });

    it('produces deterministic sequences for the same seed', () => {
      const a = new DeviceGenerator('seed-a');
      const b = new DeviceGenerator('seed-a');
      const seqA = Array.from({ length: 5 }, () => a.rng(1000));
      const seqB = Array.from({ length: 5 }, () => b.rng(1000));
      assert.deepEqual(seqA, seqB);
    });
  });

  describe('IMEI utilities', () => {
    let generator;

    beforeEach(() => {
      generator = new DeviceGenerator('imei-seed');
    });

    it('generates valid IMEI-14 bodies', () => {
      const body = generator.generateIMEI14();
      assert.match(body, /^\d{14}$/);
      assert.equal(body.slice(0, 2), '35');
    });

    it('calculates correct Luhn check digit', () => {
      const known = '49015420323751';
      assert.equal(generator.calculateLuhnCheckDigit(known), 8);
    });

    it('creates 15-digit IMEIs passing validation', () => {
      const imei = generator.generateIMEI();
      assert.match(imei, /^\d{15}$/);
      assert.equal(generator.validateIMEI(imei), true);
    });

    it('validateIMEI helper rejects malformed values', () => {
      assert.equal(validateIMEI('490154203237518'), true);
      assert.equal(validateIMEI('490154203237519'), false);
      assert.equal(validateIMEI('abc'), false);
    });
  });

  describe('serial utilities', () => {
    let generator;

    beforeEach(() => {
      generator = new DeviceGenerator('serial-seed');
    });

    it('creates default serial with padded sequence', () => {
      const serial = generator.generateHeySaladSerial();
      assert.match(serial, /^HS-KIO-\d{8}-\d{3}$/);
    });

    it('supports explicit type + sequence', () => {
      const serial = generator.generateHeySaladSerial('TAB', 42);
      assert.match(serial, /^HS-TAB-\d{8}-042$/);
    });

    it('validates serial formats', () => {
      assert.equal(validateHeySaladSerial('HS-KIO-20231215-123'), true);
      assert.equal(validateHeySaladSerial('HS-BAD-2023-12-123'), false);
    });
  });

  describe('provisioning + qr', () => {
    let generator;

    beforeEach(() => {
      generator = new DeviceGenerator('qr-seed');
    });

    it('builds provisioning URLs with encoded serial', () => {
      const serial = 'HS-KIO-20240101-001';
      const url = generator.generateProvisioningURL(serial);
      assert.match(url, /^https:\/\/provision\.heysalad\.app\/setup\?serial=HS-KIO-20240101-001&ts=\d+$/);
    });

    it('accepts alternate base URLs', () => {
      const url = generator.generateProvisioningURL('HS-TAB-20240101-001', 'https://staging.heysalad.app');
      assert.match(url, /^https:\/\/staging\.heysalad\.app\/setup\?serial=HS-TAB-20240101-001&ts=\d+$/);
    });

    it('produces base64 PNG QR codes', async () => {
      const qr = await generator.generateQRCode('https://example.com');
      assert.ok(qr.startsWith('data:image/png;base64,'));
    });

    it('throws when QR URL missing', async () => {
      await assert.rejects(() => generator.generateQRCode(''), /QR generation failed/);
    });
  });

  describe('device generation', () => {
    let generator;

    beforeEach(() => {
      generator = new DeviceGenerator('device-seed');
    });

    it('produces full device payload', async () => {
      const device = await generator.generateDevice({ deviceType: 'TAB', sequence: 7 });
      assert.equal(generator.validateIMEI(device.imei), true);
      assert.equal(generator.validateHeySaladSerial(device.serial), true);
      assert.ok(device.provisioningURL.includes(device.serial));
      assert.ok(device.qrCode.startsWith('data:image/png;base64,'));
      assert.equal(device.metadata.deviceType, 'TAB');
      assert.equal(device.metadata.imei14, device.imei.slice(0, 14));
    });

    it('supports batch generation with option inheritance', async () => {
      const devices = await generator.generateBatch(3, { deviceType: 'POS', baseURL: 'https://staging.heysalad.app' });
      assert.equal(devices.length, 3);
      const imeis = new Set();
      const serials = new Set();
      devices.forEach(device => {
        imeis.add(device.imei);
        serials.add(device.serial);
        assert.ok(device.provisioningURL.startsWith('https://staging.heysalad.app/setup'));
      });
      assert.equal(imeis.size, 3);
      assert.equal(serials.size, 3);
    });

    it('rejects invalid batch counts', async () => {
      await assert.rejects(() => generator.generateBatch(0), /positive integer/);
    });
  });
});
