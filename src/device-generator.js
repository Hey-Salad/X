const crypto = require('crypto');
const QRCode = require('qrcode');

const DEFAULT_DEVICE_TYPES = ['KIO', 'TAB', 'POS', 'KDS'];
const DEFAULT_BASE_URL = 'https://provision.heysalad.app';

function ensureDeviceType(type = 'KIO') {
  const candidate = (type || 'KIO').toUpperCase();
  if (!DEFAULT_DEVICE_TYPES.includes(candidate)) {
    throw new Error(
      `Unsupported device type "${type}". Allowed values: ${DEFAULT_DEVICE_TYPES.join(', ')}`
    );
  }
  return candidate;
}

class DeviceGenerator {
  constructor(seed = null) {
    this.seed = seed || crypto.randomBytes(16).toString('hex');
    this.rng = this.createSeededRNG(this.seed);
  }

  createSeededRNG(seed) {
    let state = crypto.createHash('sha256').update(seed).digest();
    let cursor = 0;

    return (max = 1) => {
      if (max <= 0) {
        return 0;
      }
      if (cursor >= state.length - 4) {
        state = crypto.createHash('sha256').update(state).digest();
        cursor = 0;
      }
      const value = state.readUInt32BE(cursor) / 0xffffffff;
      cursor += 4;
      return Math.floor(value * max);
    };
  }

  padNumber(num, length) {
    return num.toString().padStart(length, '0');
  }

  generateIMEI14() {
    const tac = `35${this.padNumber(this.rng(1000000), 6)}`;
    const snr = this.padNumber(this.rng(1000000), 6);
    return `${tac}${snr}`;
  }

  calculateLuhnCheckDigit(number) {
    const digits = number.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let digit = digits[digits.length - 1 - i];
      if (i % 2 === 0) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      sum += digit;
    }
    return (10 - (sum % 10)) % 10;
  }

  validateIMEI(imei) {
    if (!/^\d{15}$/.test(imei)) {
      return false;
    }
    const imei14 = imei.slice(0, 14);
    const providedCheck = Number(imei.slice(14));
    return this.calculateLuhnCheckDigit(imei14) === providedCheck;
  }

  generateIMEI() {
    const imei14 = this.generateIMEI14();
    const checkDigit = this.calculateLuhnCheckDigit(imei14);
    return `${imei14}${checkDigit}`;
  }

  generateHeySaladSerial(deviceType = 'KIO', sequence = null) {
    const normalizedType = ensureDeviceType(deviceType);
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const seq =
      sequence === null || sequence === undefined
        ? this.padNumber(this.rng(1000), 3)
        : this.padNumber(Number(sequence) % 1000, 3);

    return `HS-${normalizedType}-${datePart}-${seq}`;
  }

  validateHeySaladSerial(serial) {
    const pattern = new RegExp(`^HS-(${DEFAULT_DEVICE_TYPES.join('|')})-\\d{8}-\\d{3}$`);
    return pattern.test(serial);
  }

  generateProvisioningURL(serial, baseURL = DEFAULT_BASE_URL) {
    const normalizedBase = baseURL || DEFAULT_BASE_URL;
    const url = new URL('/setup', normalizedBase);
    url.searchParams.set('serial', serial);
    url.searchParams.set('ts', Date.now().toString());
    return url.toString();
  }

  async generateQRCode(url) {
    if (!url) {
      throw new Error('QR generation failed: URL is required');
    }
    try {
      return await QRCode.toDataURL(url, {
        type: 'png',
        width: 300,
        margin: 2,
        color: {
          dark: '#2E8B57',
          light: '#FFFFFF'
        }
      });
    } catch (error) {
      throw new Error(`QR generation failed: ${error.message}`);
    }
  }

  async generateDevice(options = {}) {
    const {
      deviceType = 'KIO',
      sequence = null,
      seed = this.seed,
      baseURL = DEFAULT_BASE_URL
    } = options;

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
        deviceType: ensureDeviceType(deviceType),
        generatedAt: new Date().toISOString(),
        imei14: imei.slice(0, 14),
        luhnCheckDigit: Number(imei.slice(14))
      }
    };
  }

  async generateBatch(count, options = {}) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('count must be a positive integer');
    }
    const devices = [];
    for (let i = 0; i < count; i += 1) {
      const device = await this.generateDevice({
        ...options,
        sequence: options.sequence !== undefined ? options.sequence : i
      });
      devices.push(device);
    }
    return devices;
  }
}

const validateIMEI = imei => new DeviceGenerator().validateIMEI(imei);
const validateHeySaladSerial = serial => new DeviceGenerator().validateHeySaladSerial(serial);

module.exports = {
  DeviceGenerator,
  validateIMEI,
  validateHeySaladSerial,
  DEFAULT_DEVICE_TYPES
};
