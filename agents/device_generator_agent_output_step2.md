Now I have enough context to implement the device generator. Let me proceed with the three steps:

## Step 1: Implement src/device-generator.js

```javascript
// src/device-generator.js
const crypto = require('crypto');
const QRCode = require('qrcode');

/**
 * HeySalad Device Generator
 * 
 * Generates device identifiers including:
 * - Valid 15-digit IMEI with Luhn check digit
 * - HeySalad serial format (HS-{TYPE}-{YYYYMMDD}-{SEQ})
 * - Provisioning URLs for device setup
 * - QR codes for provisioning endpoint scanning
 */
class DeviceGenerator {
  constructor(seed = null) {
    this.seed = seed || crypto.randomBytes(16).toString('hex');
    this.rng = this.createSeededRNG(this.seed);
  }

  /**
   * Create seeded random number generator for deterministic output
   * @param {string} seed - Seed string for deterministic generation
   * @returns {Function} RNG function
   */
  createSeededRNG(seed) {
    const hash = crypto.createHash('sha256').update(seed).digest();
    let position = 0;
    
    return (max = 1) => {
      if (position >= hash.length - 4) {
        position = 0;
      }
      const value = hash.readUInt32BE(position) / 0xFFFFFFFF;
      position += 4;
      return Math.floor(value * max);
    };
  }

  /**
   * Pad number with leading zeros
   * @param {number} num - Number to pad
   * @param {number} length - Target length
   * @returns {string} Padded string
   */
  padNumber(num, length) {
    return num.toString().padStart(length, '0');
  }

  /**
   * Generate IMEI-14 digits (TAC + SNR)
   * @returns {string} 14-digit IMEI without check digit
   */
  generateIMEI14() {
    // Type Allocation Code (TAC) - 8 digits (GS1 prefix + random)
    const tac = '35' + this.padNumber(this.rng(999999), 6);
    
    // Serial Number (SNR) - 6 digits
    const snr = this.padNumber(this.rng(999999), 6);
    
    return tac + snr; // 14 digits total
  }

  /**
   * Calculate Luhn check digit for a number
   * @param {string} number - Number string to calculate check digit for
   * @returns {number} Luhn check digit (0-9)
   */
  calculateLuhnCheckDigit(number) {
    const digits = number.split('').map(Number);
    let sum = 0;
    
    for (let i = 0; i < digits.length; i++) {
      let digit = digits[digits.length - 1 - i];
      if (i % 2 === 0) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    
    return (10 - (sum % 10)) % 10;
  }

  /**
   * Validate IMEI using Luhn algorithm
   * @param {string} imei - 15-digit IMEI to validate
   * @returns {boolean} True if valid
   */
  validateIMEI(imei) {
    if (!/^\d{15}$/.test(imei)) return false;
    
    const imei14 = imei.slice(0, 14);
    const checkDigit = parseInt(imei[14], 10);
    const calculatedCheck = this.calculateLuhnCheckDigit(imei14);
    
    return checkDigit === calculatedCheck;
  }

  /**
   * Generate complete IMEI (14 digits + Luhn check digit)
   * @returns {string} 15-digit valid IMEI
   */
  generateIMEI() {
    const imei14 = this.generateIMEI14();
    const checkDigit = this.calculateLuhnCheckDigit(imei14);
    return imei14 + checkDigit.toString();
  }

  /**
   * Generate HeySalad serial format: HS-{TYPE}-{YYYYMMDD}-{SEQ}
   * @param {string} deviceType - Device type (e.g., 'KIO', 'TAB', 'POS')
   * @param {number|null} sequence - Optional sequence number
   * @returns {string} HeySalad serial
   */
  generateHeySaladSerial(deviceType = 'KIO', sequence = null) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = sequence !== null ? sequence : this.padNumber(this.rng(999), 3);
    
    return `HS-${deviceType}-${dateStr}-${seq}`;
  }

  /**
   * Validate HeySalad serial format
   * @param {string} serial - Serial to validate
   * @returns {boolean} True if valid format
   */
  validateHeySaladSerial(serial) {
    return /^HS-(KIO|TAB|POS|KDS)-\d{8}-\d{3}$/.test(serial);
  }

  /**
   * Generate provisioning URL
   * @param {string} serial - Device serial
   * @param {string} baseURL - Base provisioning URL
   * @returns {string} Complete provisioning URL
   */
  generateProvisioningURL(serial, baseURL = 'https://provision.heysalad.app') {
    return `${baseURL}/setup?serial=${encodeURIComponent(serial)}&ts=${Date.now()}`;
  }

  /**
   * Generate QR code as base64 PNG
   * @param {string} url - URL to encode in QR code
   * @returns {Promise<string>} Base64 PNG data URL
   */
  async generateQRCode(url) {
    try {
      return await QRCode.toDataURL(url, {
        type: 'png',
        width: 300,
        margin: 2,
        color: {
          dark: '#2E8B57', // HeySalad green
          light: '#FFFFFF'
        }
      });
    } catch (error) {
      throw new Error(`QR generation failed: ${error.message}`);
    }
  }

  /**
   * Generate batch of devices
   * @param {number} count - Number of devices to generate
   * @param {Object} options - Generation options
   * @returns {Promise<Array>} Array of device objects
   */
  async generateBatch(count, options = {}) {
    const devices = [];
    
    for (let i = 0; i < count; i++) {
      const device = await this.generateDevice({
        ...options,
        sequence: i
      });
      devices.push(device);
    }
    
    return devices;
  }

  /**
   * Main device generator function
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Complete device object
   */
  async generateDevice(options = {}) {
    const {
      deviceType = 'KIO',
      sequence = null,
      seed = this.seed,
      baseURL = 'https://provision.heysalad.app'
    } = options;

    // Reset RNG if seed changed
    if (seed !== this.seed) {
      this.seed = seed;
      this.rng = this.createSeededRNG(seed);
    }

    const imei = this.generateIMEI();
    const serial = this.generateHeySaladSerial(deviceType, sequence);
    const provisioningURL = this.generateProvisioningURL(serial, baseURL);
    const qrCode = await this.generateQRCode(provisioningURL);

    return {
      imei,
      serial,
      provisioningURL,
      qrCode,
      metadata: {
        seed: this.seed,
        deviceType,
        generatedAt: new Date().toISOString(),
        imei14: imei.slice(0, 14),
        luhnCheckDigit: parseInt(imei[14], 10)
      }
    };
  }
}

// Export validation helpers as standalone functions
const validateIMEI = (imei) => {
  const generator = new DeviceGenerator();
  return generator.validateIMEI(imei);
};

const validateHeySaladSerial = (serial) => {
  const generator = new DeviceGenerator();
  return generator.validateHeySaladSerial(serial);
};

module.exports = {
  DeviceGenerator,
  validateIMEI,
  validateHeySaladSerial
};
```

## Step 2: Implement test/device-generator.test.js

```javascript
// test/device-generator.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { DeviceGenerator, validateIMEI, validateHeySaladSerial } = require('../src/device-generator');

describe('DeviceGenerator', () => {
  describe('constructor', () => {
    it('should create instance with random seed by default', () => {
      const generator = new DeviceGenerator();
      assert.ok(generator.seed);
      assert.strictEqual(typeof generator.seed, 'string');
      assert.strictEqual(generator.seed.length, 32); // 16 bytes as hex
    });

    it('should create instance with provided seed', () => {
      const seed = 'test-seed-123';
      const generator = new DeviceGenerator(seed);
      assert.strictEqual(generator.seed, seed);
    });
  });

  describe('seeded RNG', () => {
    it('should generate deterministic values with same seed', () => {
      const seed = 'deterministic-test';
      const gen1 = new DeviceGenerator(seed);
      const gen2 = new DeviceGenerator(seed);
      
      const values1 = Array.from({ length: 10 }, () => gen1.rng(1000));
      const values2 = Array.from({ length: 10 }, () => gen2.rng(1000));
      
      assert.deepStrictEqual(values1, values2);
    });
  });

  describe('IMEI generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-imei');
    });

    describe('generateIMEI14', () => {
      it('should generate 14-digit IMEI', () => {
        const imei14 = generator.generateIMEI14();
        assert.strictEqual(imei14.length, 14);
        assert.ok(/^\d{14}$/.test(imei14));
      });

      it('should start with GS1 prefix', () => {
        const imei14 = generator.generateIMEI14();
        assert.ok(imei14.startsWith('35'));
      });
    });

    describe('calculateLuhnCheckDigit', () => {
      it('should calculate correct Luhn check digit', () => {
        // Test with known IMEI-14
        const imei14 = '49015420323751';
        const checkDigit = generator.calculateLuhnCheckDigit(imei14);
        assert.strictEqual(checkDigit, 8); // Known valid check digit
      });

      it('should handle edge cases', () => {
        assert.strictEqual(generator.calculateLuhnCheckDigit('0'), 0);
        assert.strictEqual(generator.calculateLuhnCheckDigit('1'), 8);
      });
    });

    describe('generateIMEI', () => {
      it('should generate valid 15-digit IMEI', () => {
        const imei = generator.generateIMEI();
        assert.strictEqual(imei.length, 15);
        assert.ok(/^\d{15}$/.test(imei));
        assert.ok(generator.validateIMEI(imei));
      });

      it('should generate different IMEIs with different seeds', () => {
        const gen1 = new DeviceGenerator('seed1');
        const gen2 = new DeviceGenerator('seed2');
        
        const imei1 = gen1.generateIMEI();
        const imei2 = gen2.generateIMEI();
        
        assert.notStrictEqual(imei1, imei2);
      });
    });
  });

  describe('IMEI validation', () => {
    it('should validate correct IMEI', () => {
      const validIMEI = '490154203237518'; // Known valid IMEI
      assert.ok(validateIMEI(validIMEI));
    });

    it('should reject invalid IMEI', () => {
      const invalidIMEI = '490154203237519'; // Wrong check digit
      assert.strictEqual(validateIMEI(invalidIMEI), false);
    });

    it('should reject non-numeric IMEI', () => {
      assert.strictEqual(validateIMEI('ABCDEFGHIJKLMNO'), false);
    });

    it('should reject wrong length IMEI', () => {
      assert.strictEqual(validateIMEI('123'), false);
      assert.strictEqual(validateIMEI('12345678901234567890'), false);
    });
  });

  describe('HeySalad serial generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-serial');
    });

    describe('generateHeySaladSerial', () => {
      it('should generate valid serial format', () => {
        const serial = generator.generateHeySaladSerial();
        assert.ok(/^HS-KIO-\d{8}-\d{3}$/.test(serial));
      });

      it('should accept custom device type', () => {
        const serial = generator.generateHeySaladSerial('TAB');
        assert.ok(serial.startsWith('HS-TAB-'));
      });

      it('should accept custom sequence', () => {
        const serial = generator.generateHeySaladSerial('KIO', 42);
        assert.ok(serial.endsWith('-042'));
      });

      it('should pad sequence numbers', () => {
        const serial = generator.generateHeySaladSerial('KIO', 5);
        assert.ok(serial.endsWith('-005'));
      });
    });

    describe('validateHeySaladSerial', () => {
      it('should validate correct serial format', () => {
        assert.ok(validateHeySaladSerial('HS-KIO-20231201-001'));
        assert.ok(validateHeySaladSerial('HS-TAB-20231201-999'));
        assert.ok(validateHeySaladSerial('HS-POS-20231201-123'));
      });

      it('should reject invalid serial format', () => {
        assert.strictEqual(validateHeySaladSerial('invalid'), false);
        assert.strictEqual(validateHeySaladSerial('HS-INVALID-20231201-001'), false);
        assert.strictEqual(validateHeySaladSerial('HS-KIO-20231301-001'), false); // Invalid date
        assert.strictEqual(validateHeySaladSerial('HS-KIO-20231201-1000'), false); // Sequence too long
      });
    });
  });

  describe('provisioning URL generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-url');
    });

    it('should generate valid provisioning URL', () => {
      const serial = 'HS-KIO-20231201-001';
      const url = generator.generateProvisioningURL(serial);
      
      assert.ok(url.startsWith('https://provision.heysalad.app/setup?serial='));
      assert.ok(url.includes(encodeURIComponent(serial)));
      assert.ok(url.includes('ts='));
    });

    it('should accept custom base URL', () => {
      const serial = 'HS-KIO-20231201-001';
      const customURL = 'https://staging.heysalad.app';
      const url = generator.generateProvisioningURL(serial, customURL);
      
      assert.ok(url.startsWith(customURL));
    });
  });

  describe('QR code generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-qr');
    });

    it('should generate base64 PNG data URL', async () => {
      const url = 'https://provision.heysalad.app/setup?serial=TEST';
      const qrCode = await generator.generateQRCode(url);
      
      assert.ok(qrCode.startsWith('data:image/png;base64,'));
      assert.ok(qrCode.length > 1000); // Reasonable base64 length for QR
    });

    it('should handle QR generation errors', async () => {
      await assert.rejects(
        async () => {
          await generator.generateQRCode(null);
        },
        {
          name: 'Error',
          message: /QR generation failed/
        }
      );
    });
  });

  describe('batch generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-batch');
    });

    it('should generate specified number of devices', async () => {
      const count = 5;
      const devices = await generator.generateBatch(count);
      
      assert.strictEqual(devices.length, count);
      
      // Verify all devices have required properties
      devices.forEach(device => {
        assert.ok(device.imei);
        assert.ok(device.serial);
        assert.ok(device.provisioningURL);
        assert.ok(device.qrCode);
        assert.ok(device.metadata);
      });
    });

    it('should apply options to all devices', async () => {
      const devices = await generator.generateBatch(3, {
        deviceType: 'TAB',
        baseURL: 'https://staging.heysalad.app'
      });
      
      devices.forEach(device => {
        assert.ok(device.serial.startsWith('HS-TAB-'));
        assert.ok(device.provisioningURL.startsWith('https://staging.heysalad.app'));
      });
    });
  });

  describe('complete device generation', () => {
    let generator;

    before(() => {
      generator = new DeviceGenerator('test-complete');
    });

    it('should generate complete device object', async () => {
      const device = await generator.generateDevice();
      
      // Required properties
      assert.ok(device.imei);
      assert.ok(device.serial);
      assert.ok(device.provisioningURL);
      assert.ok(device.qrCode);
      assert.ok(device.metadata);
      
      // Metadata validation
      assert.ok(device.metadata.seed);
      assert.ok(device.metadata.deviceType);
      assert.ok(device.metadata.generatedAt);
      assert.ok(device.metadata.imei14);
      assert.ok(device.metadata.luhnCheckDigit);
      
      // IMEI validation
      assert.strictEqual(device.imei.length, 15
