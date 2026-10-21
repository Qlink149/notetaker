import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Turning the switches on brings the pages back: nothing was deleted. Insights and Benchmark open from the
// profile sheet on Today since the "Kept" tab bar (20 Oct).
vi.mock('@/lib/features', () => ({
  FEATURES: { liveRecording: true, insights: true, benchmark: true },
}));
vi.mock('@/api/client', () => ({
  api: {
    tasks: { list: vi.fn().mockResolvedValue([]), suggestions: vi.fn().mockResolvedValue([]) },
    speakers: { list: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ workspace: { mePersonId: null }, updateWorkspace: vi.fn(), logout: vi.fn() }),
}));

import Layout from '@/components/Layout';
import Today from '@/pages/Today';

afterEach(cleanup);

describe('navigation with every part switched on', () => {
  it('offers Insights and Benchmark from the profile sheet', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Today />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }));
    const sheet = await screen.findByRole('dialog');
    expect([...sheet.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Speakers (voice directory)',
      'Insights',
      'Benchmark',
      'Settings',
    ]);
  });
});
