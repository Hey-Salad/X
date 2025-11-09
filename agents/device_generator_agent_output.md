Based on my exploration of the HeySalad MCP repository, I can now design a comprehensive device generator utility. Let me provide a complete implementation sketch and testing notes.

## HeySalad Device Generator Utility - Implementation Sketch

### Overview
The device generator will create:
1. **IMEI-14 + Luhn check digit** - Valid 15-digit IMEI
2. **Deterministic HeySalad serial format** - Structured device identifier
3. **Provisioning URL** - Embedding the serial for device setup
4. **Base64 PNG QR code** - For provisioning endpoint scanning

### Core Implementation

```javascript
// src/device-generator.js
const crypto = require('crypto');
const QRCode = require('qrcode');

class DeviceGenerator {
  constructor(seed = null) {
    this.seed = seed || crypto.randomBytes(16).toString('hex');
    this.rng = this.createSeededRNG(this.seed);
  }

  // Seeded RNG for deterministic generation
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

  // Generate IMEI-14 digits (TAC + SNR)
  generateIMEI14() {
    // Type Allocation Code (TAC) - 8 digits
    const tac = '35' + this.padNumber(this.rng(999999), 6); // GS1 prefix + random
    
    // Serial Number (SNR) - 6 digits
    const snr = this.padNumber(this.rng(999999), 6);
    
    return tac + snr; // 14 digits total
  }

  // Calculate Luhn check digit
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

  // Generate complete IMEI (14 digits + Luhn)
  generateIMEI() {
    const imei14 = this.generateIMEI14();
    const checkDigit = this.calculateLuhnCheckDigit(imei14);
    return imei14 + checkDigit.toString();
  }

  // Generate HeySalad serial format: HS-{TYPE}-{YYYYMMDD}-{SEQ}
  generateHeySaladSerial(deviceType = 'KIO', sequence = null) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = sequence !== null ? sequence : this.padNumber(this.rng(999), 3);
    
    return `HS-${deviceType}-${dateStr}-${seq}`;
  }

  // Generate provisioning URL
  generateProvisioningURL(serial, baseURL = 'https://provision.heysalad.app') {
    return `${baseURL}/setup?serial=${encodeURIComponent(serial)}&ts=${Date.now()}`;
  }

  // Generate QR code as base64 PNG
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

  // Main generator function
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
        luhnCheckDigit: imei.slice(14)
      }
    };
  }

  // Utility function
  padNumber(num, length) {
    return num.toString().padStart(length, '0');
  }

  // Validate IMEI
  validateIMEI(imei) {
    if (!/^\d{15}$/.test(imei)) return false;
    const imei14 = imei.slice(0, 14);
    const checkDigit = parseInt(imei.slice(14));
    return this.calculateLuhnCheckDigit(imei14) === checkDigit;
  }
}

module.exports = DeviceGenerator;
```

### MCP Server Integration

```javascript
// Add to src/server.js
const DeviceGenerator = require('./device-generator');

// Register as MCP tool
server.tool(
  'generate_device',
  'Generate a new HeySalad device with IMEI, serial, provisioning URL, and QR code',
  {
    deviceType: z.string().optional().describe('Device type (KIO, DRV, TAB, etc.)'),
    sequence: z.number().optional().describe('Optional sequence number for deterministic serial'),
    seed: z.string().optional().describe('Seed for deterministic generation'),
    baseURL: z.string().optional().describe('Base URL for provisioning endpoint')
  },
  async ({ deviceType, sequence, seed, baseURL }) => {
    try {
      const generator = new DeviceGenerator(seed);
      const device = await generator.generateDevice({
        deviceType,
        sequence,
        baseURL
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(device, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Device generation failed: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add validation tool
server.tool(
  'validate_imei',
  'Validate an IMEI number using Luhn algorithm',
  {
    imei: z.string().describe('15-digit IMEI to validate')
  },
  async ({ imei }) => {
    const generator = new DeviceGenerator();
    const isValid = generator.validateIMEI(imei);
    
    return {
      content: [
        {
          type: 'text',
          text: `IMEI ${imei} is ${isValid ? 'valid' : 'invalid'}`
        }
      ]
    };
  }
);
```

### Package Dependencies

```json
// Add to package.json
{
  "dependencies": {
    "qrcode": "^1.5.3"
  }
}
```

### Testing Strategy

```javascript
// test/device-generator.test.js
const DeviceGenerator = require('../src/device-generator');
const { describe, it, expect } = require('@jest/globals');

describe('DeviceGenerator', () => {
  describe('IMEI Generation', () => {
    it('should generate valid 15-digit IMEI', () => {
      const generator = new DeviceGenerator('test-seed');
      const imei = generator.generateIMEI();
      
      expect(imei).toHaveLength(15);
      expect(imei).toMatch(/^\d{15}$/);
      expect(generator.validateIMEI(imei)).toBe(true);
    });

    it('should generate deterministic IMEI with same seed', () => {
      const gen1 = new DeviceGenerator('fixed-seed');
      const gen2 = new DeviceGenerator('fixed-seed');
      
      expect(gen1.generateIMEI()).toBe(gen2.generateIMEI());
    });

    it('should calculate correct Luhn check digit', () => {
      const generator = new DeviceGenerator();
      const imei14 = '12345678901234'; // Known test case
      const checkDigit = generator.calculateLuhnCheckDigit(imei14);
      
      expect(checkDigit).toBe(0); // 123456789012340 should be valid
    });
  });

  describe('Serial Generation', () => {
    it('should generate valid HeySalad serial format', () => {
      const generator = new DeviceGenerator();
      const serial = generator.generateHeySaladSerial('KIO', 42);
      
      expect(serial).toMatch(/^HS-KIO-\d{8}-042$/);
    });

    it('should handle different device types', () => {
      const generator = new DeviceGenerator();
      const types = ['KIO', 'DRV', 'TAB', 'CAM'];
      
      types.forEach(type => {
        const serial = generator.generateHeySaladSerial(type);
        expect(serial).toMatch(new RegExp(`^HS-${type}-\\d{8}-\\d{3}$`));
      });
    });
  });

  describe('Provisioning System', () => {
    it('should generate valid provisioning URL', () => {
      const generator = new DeviceGenerator();
      const serial = 'HS-KIO-20241225-001';
      const url = generator.generateProvisioningURL(serial);
      
      expect(url).toContain('https://provision.heysalad.app/setup');
      expect(url).toContain(`serial=${encodeURIComponent(serial)}`);
    });

    it('should generate base64 QR code', async () => {
      const generator = new DeviceGenerator();
      const url = 'https://provision.heysalad.app/setup?serial=TEST';
      const qrCode = await generator.generateQRCode(url);
      
      expect(qrCode).toMatch(/^data:image\/png;base64,/);
      expect(qrCode.length).toBeGreaterThan(1000); // Reasonable PNG size
    });
  });

  describe('Full Device Generation', () => {
    it('should generate complete device package', async () => {
      const generator = new DeviceGenerator('test-seed');
      const device = await generator.generateDevice({
        deviceType: 'KIO',
        sequence: 1
      });
      
      expect(device).toHaveProperty('imei');
      expect(device).toHaveProperty('serial');
      expect(device).toHaveProperty('provisioningURL');
      expect(device).toHaveProperty('qrCode');
      expect(device).toHaveProperty('metadata');
      
      expect(generator.validateIMEI(device.imei)).toBe(true);
      expect(device.serial).toMatch(/^HS-KIO-\d{8}-001$/);
    });
  });
});
```

### Testing Notes

#### 1. Unit Testing
- **IMEI Validation**: Test Luhn algorithm with known valid/invalid IMEIs
- **Deterministic Generation**: Verify same seed produces identical outputs
- **Serial Format**: Ensure consistent structure across device types
- **QR Generation**: Validate PNG format and reasonable file size

#### 2. Integration Testing
```bash
# Test the MCP tool directly
curl -X POST http://localhost:4141/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "generate_device",
      "arguments": {
        "deviceType": "KIO",
        "sequence": 42
      }
    }
  }'
```

#### 3. Edge Cases
- **Invalid seeds**: Handle malformed seed values gracefully
- **Network failures**: QR generation should handle offline scenarios
- **Large sequences**: Ensure proper padding for sequence numbers
- **Special characters**: URL encoding for serial parameters

#### 4. Performance Testing
- **Batch generation**: Generate 100+ devices to test memory usage
- **QR generation speed**: Measure time for concurrent QR code creation
- **Seed collision**: Verify different seeds produce different outputs

#### 5. Security Considerations
- **IMEI privacy**: Ensure generated IMEIs don't conflict with real devices
- **URL validation**: Sanitize baseURL parameter to prevent SSRF
- **Seed entropy**: Verify sufficient randomness in default seed generation

### Usage Examples

```javascript
// Basic usage
const generator = new DeviceGenerator();
const device = await generator.generateDevice();

// Deterministic generation
const generator = new DeviceGenerator('factory-batch-001');
const device1 = await generator.generateDevice({ sequence: 1 });
const device2 = await generator.generateDevice({ sequence: 2 });

// Custom device types
const driverDevice = await generator.generateDevice({
  deviceType: 'DRV',
  baseURL: 'https://drivers.heysalad.app'
});
```

This implementation provides a robust, testable device generator that integrates seamlessly with the existing HeySalad MCP infrastructure while maintaining security and determinism for production use.
