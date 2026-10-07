import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  auth: { me: vi.fn(), login: vi.fn(), logout: vi.fn() },
  join: { join: vi.fn(), heartbeat: vi.fn(), sign: vi.fn(), part: vi.fn() },
  meetings: { list: vi.fn() },
  workspace: { settings: vi.fn() },
}));
vi.mock('@/api/client', () => ({
  api,
  ApiError: class extends Error {},
  getToken: () => null,
  setToken: () => undefined,
  onUnauthorized: () => () => undefined,
}));
vi.mock('@/lib/phoneRecorder', () => ({
  PhoneRecorder: class {},
  encodeWav: vi.fn(),
  partStore: { put: vi.fn(), del: vi.fn(), keys: vi.fn().mockResolvedValue([]), get: vi.fn() },
}));

import App from '@/App';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('who can see what', () => {
  it('a phone opening /join/<code> sees the join page without logging in', async () => {
    api.auth.me.mockRejectedValue(new Error('unauthenticated'));
    window.history.pushState({}, '', '/join/abc234');
    render(<App />);
    await screen.findByText('Join the recording');
    expect(screen.getByLabelText('Your name')).toBeTruthy();
    expect(screen.queryByText(/access code/i)).toBeNull();
  });

  it('every other address asks for the access code when logged out', async () => {
    api.auth.me.mockRejectedValue(new Error('unauthenticated'));
    window.history.pushState({}, '', '/meetings');
    render(<App />);
    await waitFor(() => expect(screen.queryByText('Join the recording')).toBeNull());
    await screen.findByText(/access code/i);
  });

  it('the audit and insights pages are inside the login wall', async () => {
    api.auth.me.mockRejectedValue(new Error('unauthenticated'));
    for (const path of ['/audit', '/dashboard']) {
      window.history.pushState({}, '', path);
      const { unmount } = render(<App />);
      await screen.findByText(/access code/i);
      expect(screen.queryByText('Blind audit')).toBeNull();
      expect(screen.queryByText('Cost and quality')).toBeNull();
      unmount();
    }
  });
});
