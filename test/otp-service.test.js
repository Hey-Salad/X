import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OtpService } from '../src/otp-service.js';

test('OtpService generates and verifies codes', async () => {
  const service = new OtpService({ ttlMs: 1000, resendIntervalMs: 0, codeLength: 6, scope: 'internal' });
  const { code } = service.createCode('user@example.com');
  const verified = service.verifyCode(code, 'user@example.com');
  assert.ok(verified);
  assert.equal(verified.email, 'user@example.com');
  assert.equal(verified.scope, 'internal');
  assert.equal(service.verifyCode(code, 'user@example.com'), null, 'code cannot be reused');
});

test('OtpService enforces resend throttle', async () => {
  const service = new OtpService({ ttlMs: 1000, resendIntervalMs: 200, codeLength: 6, scope: 'internal' });
  service.createCode('user@example.com');
  let throttled = false;
  try {
    service.createCode('user@example.com');
  } catch (error) {
    throttled = error.code === 'OTP_THROTTLED';
  }
  assert.equal(throttled, true);
  await delay(220);
  const { code } = service.createCode('user@example.com');
  assert.ok(code);
});

test('OtpService expires codes after TTL', async () => {
  const service = new OtpService({ ttlMs: 50, resendIntervalMs: 0, codeLength: 6, scope: 'internal' });
  const { code } = service.createCode('user@example.com');
  await delay(80);
  const verified = service.verifyCode(code, 'user@example.com');
  assert.equal(verified, null);
});
