export class OtpService {
  constructor({
    ttlMs = 5 * 60 * 1000,
    resendIntervalMs = 60 * 1000,
    codeLength = 6,
    scope = 'internal'
  } = {}) {
    if (codeLength < 4) {
      throw new Error('codeLength must be at least 4 digits.');
    }
    this.ttlMs = ttlMs;
    this.resendIntervalMs = resendIntervalMs;
    this.codeLength = codeLength;
    this.scope = scope;
    this.codes = new Map(); // code -> record
    this.emailThrottle = new Map(); // email -> timestamp
  }

  normalizeEmail(email) {
    if (typeof email !== 'string') {
      return null;
    }
    const trimmed = email.trim().toLowerCase();
    return trimmed || null;
  }

  normalizeCode(code) {
    if (typeof code !== 'string') {
      return null;
    }
    const normalized = code.replace(/\s+/g, '').trim();
    return normalized || null;
  }

  generateCode() {
    const min = 10 ** (this.codeLength - 1);
    const max = 10 ** this.codeLength - 1;
    const value = Math.floor(Math.random() * (max - min + 1)) + min;
    return String(value);
  }

  createCode(email) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error('Email is required to generate an OTP code.');
    }
    const now = Date.now();
    if (this.resendIntervalMs > 0) {
      const lastSent = this.emailThrottle.get(normalizedEmail) || 0;
      const elapsed = now - lastSent;
      if (elapsed < this.resendIntervalMs) {
        const retryInMs = this.resendIntervalMs - elapsed;
        const error = new Error('OTP throttled.');
        error.code = 'OTP_THROTTLED';
        error.retryInMs = retryInMs;
        throw error;
      }
    }

    const code = this.generateCode();
    const record = {
      email: normalizedEmail,
      scope: this.scope,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      timeout: null
    };

    const timeout = setTimeout(() => {
      if (this.codes.get(code) === record) {
        this.codes.delete(code);
      }
    }, this.ttlMs + 1000);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }
    record.timeout = timeout;

    this.codes.set(code, record);
    this.emailThrottle.set(normalizedEmail, now);

    return {
      code,
      expiresAt: record.expiresAt
    };
  }

  invalidateCode(code, { resetThrottle = false } = {}) {
    const normalizedCode = this.normalizeCode(code);
    if (!normalizedCode) {
      return;
    }
    const record = this.codes.get(normalizedCode);
    if (record?.timeout) {
      clearTimeout(record.timeout);
    }
    this.codes.delete(normalizedCode);
    if (resetThrottle && record?.email) {
      this.emailThrottle.delete(record.email);
    }
  }

  verifyCode(code, email) {
    const normalizedCode = this.normalizeCode(code);
    if (!normalizedCode) {
      return null;
    }
    const record = this.codes.get(normalizedCode);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      this.invalidateCode(normalizedCode);
      return null;
    }

    const normalizedEmail = this.normalizeEmail(email);
    if (normalizedEmail && normalizedEmail !== record.email) {
      return null;
    }

    this.invalidateCode(normalizedCode);
    return {
      email: record.email,
      scope: record.scope
    };
  }
}
