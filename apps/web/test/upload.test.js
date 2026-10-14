import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadToCloudinary } from '../src/lib/cloudinaryUpload';

// The browser upload helper picks its method from the server's signature: a presigned PUT for private
// storage (B2), the signed form POST for Cloudinary. A fake XMLHttpRequest records what is sent.
let sent;
class FakeXhr {
  constructor() {
    this.upload = {};
    this.headers = {};
    sent = this;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send(body) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.status = this.nextStatus ?? 200;
    this.responseText = this.nextText ?? '{}';
    this.onload?.();
  }
}

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

const file = new File(['audio'], 'rec.webm', { type: 'audio/webm' });
const b2 = {
  provider: 'b2',
  method: 'PUT',
  uploadUrl: 'https://s3.example/bucket/key?X-Amz-Signature=abc',
  folder: 'f',
  publicId: 'f/original-1',
  url: 'b2://f/original-1',
};

describe('browser upload', () => {
  it('private storage: PUTs the bare file to the presigned URL, reports progress, returns the b2 address', async () => {
    const progress = [];
    const out = await uploadToCloudinary(file, b2, (pct) => progress.push(pct));
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(b2.uploadUrl);
    expect(sent.body).toBe(file); // the file itself, not a form
    expect(sent.headers['Content-Type']).toBe('audio/webm');
    expect(progress).toEqual([50]);
    expect(out).toEqual({ url: 'b2://f/original-1', publicId: 'f/original-1' });
  });

  it('private storage: a rejected upload says so', async () => {
    FakeXhr.prototype.nextStatus = 403;
    try {
      await expect(uploadToCloudinary(file, b2)).rejects.toThrow('Upload failed (403)');
    } finally {
      delete FakeXhr.prototype.nextStatus;
    }
  });

  it('Cloudinary: still posts a signed form', async () => {
    FakeXhr.prototype.nextText = JSON.stringify({
      secure_url: 'https://res.cloudinary.com/x',
      public_id: 'p',
    });
    try {
      const out = await uploadToCloudinary(file, {
        cloudName: 'c',
        apiKey: 'k',
        timestamp: 1,
        signature: 's',
        folder: 'f',
        uploadUrl: 'https://api.cloudinary.com/up',
      });
      expect(sent.method).toBe('POST');
      expect(sent.body).toBeInstanceOf(FormData);
      expect(sent.body.get('signature')).toBe('s');
      expect(out).toEqual({ url: 'https://res.cloudinary.com/x', publicId: 'p' });
    } finally {
      delete FakeXhr.prototype.nextText;
    }
  });
});

describe('browser upload retries', () => {
  // each attempt replays the next scripted outcome
  let outcomes;
  let attempts;
  class ScriptedXhr extends FakeXhr {
    send(body) {
      attempts++;
      const next = outcomes.shift() ?? { status: 200 };
      this.body = body;
      if (next.error) this.onerror?.();
      else {
        this.status = next.status;
        this.responseText = '{}';
        this.onload?.();
      }
    }
  }
  beforeEach(() => {
    vi.useFakeTimers();
    attempts = 0;
    outcomes = [];
    vi.stubGlobal('XMLHttpRequest', ScriptedXhr);
  });
  afterEach(() => vi.useRealTimers());

  it('tries again after a dropped connection and succeeds', async () => {
    outcomes = [{ error: true }, { error: true }, { status: 200 }];
    const p = uploadToCloudinary(file, b2);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ url: 'b2://f/original-1', publicId: 'f/original-1' });
    expect(attempts).toBe(3);
  });

  it('retries a server error but gives up after the third attempt', async () => {
    outcomes = [{ status: 503 }, { status: 503 }, { status: 503 }];
    const p = uploadToCloudinary(file, b2);
    const settled = expect(p).rejects.toThrow('Upload failed (503)');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    expect(attempts).toBe(3);
  });

  it('does not retry a refused or expired link', async () => {
    outcomes = [{ status: 403 }, { status: 200 }];
    await expect(uploadToCloudinary(file, b2)).rejects.toThrow('Upload failed (403)');
    expect(attempts).toBe(1);
  });
});
