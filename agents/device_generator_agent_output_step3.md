Now I have enough context to provide Step 3. Based on my analysis of the repository structure and the existing server.js implementation, here's Step 3:

## Step 3: NPM Dependencies, Package.json Scripts, and Server.js Diff

### NPM Dependency Additions

No additional npm dependencies are required since we're using built-in Node.js modules and the existing dependencies already include everything needed (zod for validation, express for the server).

### New Package.json Scripts

Add these test scripts to `package.json`:

```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "NODE_ENV=development node src/server.js",
    "test": "node --test test/device-generator.test.js",
    "test:watch": "node --test --watch test/device-generator.test.js",
    "test:coverage": "node --test --experimental-test-coverage test/device-generator.test.js"
  }
}
```

### Server.js Diff to Register Device Tools

Add the following imports and tool registrations to `src/server.js`:

**At the top with other imports:**
```javascript
const { generateDevice, validateIMEI } = require('./device-generator');
```

**Inside the `buildMcpContext` function, after the existing tool registrations:**
```javascript
  // Device Generator Tools
  server.registerTool(
    'generate_device',
    {
      title: 'Generate Random Mobile Device',
      description: 'Generate a realistic mobile device with random specifications including IMEI, brand, model, OS, and technical specs',
      inputSchema: {
        count: z
          .number()
          .min(1)
          .max(10)
          .default(1)
          .describe('Number of devices to generate (1-10)')
      },
      outputSchema: {
        devices: z.array(z.object({
          imei: z.string(),
          brand: z.string(),
          model: z.string(),
          os: z.string(),
          osVersion: z.string(),
          screenResolution: z.string(),
          ram: z.number(),
          storage: z.number(),
          batteryCapacity: z.number(),
          camera: z.string(),
          network: z.string(),
          price: z.number(),
          releaseDate: z.string()
        }))
      }
    },
    async ({ count = 1 }) => {
      const devices = Array.from({ length: count }, () => generateDevice());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ devices }, null, 2)
          }
        ],
        structuredContent: { devices }
      };
    }
  );

  server.registerTool(
    'validate_imei',
    {
      title: 'Validate IMEI Number',
      description: 'Validate an IMEI (International Mobile Equipment Identity) number using the Luhn algorithm',
      inputSchema: {
        imei: z
          .string()
          .describe('15-digit IMEI number to validate')
      },
      outputSchema: {
        imei: z.string(),
        valid: z.boolean(),
        message: z.string()
      }
    },
    async ({ imei }) => {
      const isValid = validateIMEI(imei);
      const message = isValid 
        ? 'IMEI is valid' 
        : 'IMEI is invalid - must be 15 digits and pass Luhn algorithm check';
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ imei, valid: isValid, message }, null, 2)
          }
        ],
        structuredContent: { imei, valid: isValid, message }
      };
    }
  );
```

This completes the integration by:
1. **Importing** the device generator module
2. **Registering** two new MCP tools: `generate_device` and `validate_imei`
3. **Defining** proper input/output schemas using Zod validation
4. **Providing** structured JSON responses with both text and structured content

The tools are now available to MCP clients and will be accessible through the existing authentication and authorization system.
