import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Turning the switches on brings the tabs back: nothing was deleted.
vi.mock('@/lib/features', () => ({
  FEATURES: { liveRecording: true, insights: true, benchmark: true },
}));

import Layout from '@/components/Layout';

afterEach(cleanup);

describe('navigation with every part switched on', () => {
  it('shows Record, Insights and Benchmark again', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<p>home</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Meetings',
      'Record',
      'Speakers',
      'Insights',
      'Benchmark',
      'Settings',
    ]);
  });
});
