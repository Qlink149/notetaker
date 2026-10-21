import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, dueLabel, today } from '@/lib/kept';

const api = vi.hoisted(() => ({
  tasks: {
    list: vi.fn(),
    suggestions: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    skip: vi.fn(),
    setMe: vi.fn(),
  },
  speakers: { list: vi.fn() },
  search: vi.fn(),
}));
vi.mock('@/api/client', () => ({ api }));
const auth = vi.hoisted(() => ({ workspace: { mePersonId: 'heet' } }));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ workspace: auth.workspace, updateWorkspace: vi.fn(), logout: vi.fn() }),
}));

import Layout from '@/components/Layout';
import Today from '@/pages/Today';
import Team from '@/pages/Team';
import Search from '@/pages/Search';

const people = [
  { id: 'heet', name: 'Heet Dholakia' },
  { id: 'paresh', name: 'Paresh Shah' },
  { id: 'anon', name: 'Speaker B (Meeting AOM)', anonymous: true },
];

const task = (id, x = {}) => ({
  id,
  title: `Task ${id}`,
  ownerId: 'heet',
  ownerName: 'Heet Dholakia',
  buddyId: null,
  buddyName: null,
  priority: 'med',
  due: today(),
  status: 'open',
  doneAt: null,
  createdById: 'heet',
  createdByName: 'Heet Dholakia',
  meetingId: null,
  meetingTitle: null,
  source: null,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...x,
});

const suggestion = (index, x = {}) => ({
  meetingId: 'm1',
  meetingTitle: 'Diwali planning',
  index,
  title: `Suggested ${index}`,
  due: addDays(1),
  priority: 'high',
  quote: `Do suggested ${index} by tomorrow`,
  speakerName: 'Paresh',
  ownerId: 'paresh',
  ...x,
});

const show = (path, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path={path} element={element} />
          <Route path="/meetings/:id" element={<p>meeting page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  auth.workspace = { mePersonId: 'heet' };
  api.speakers.list.mockResolvedValue(people);
  api.tasks.suggestions.mockResolvedValue([]);
  api.tasks.list.mockResolvedValue([]);
  api.tasks.skip.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Today', () => {
  it('splits my open tasks into today, pending and upcoming, and counts them', async () => {
    api.tasks.list.mockResolvedValue([
      task('a', { priority: 'low' }),
      task('b', { priority: 'high' }),
      task('late', { due: addDays(-3) }),
      task('soon', { due: addDays(2) }),
      task('later', { due: addDays(20) }),
      task('nodate', { due: null }),
      task('others', { ownerId: 'paresh', ownerName: 'Paresh Shah' }),
      task('buddy', {
        ownerId: 'paresh',
        ownerName: 'Paresh Shah',
        buddyId: 'heet',
        buddyName: 'Heet Dholakia',
      }),
      task('done', { status: 'done', doneAt: new Date().toISOString() }),
    ]);
    show('/', <Today />);
    const summary = await screen.findByTestId('today-summary');
    await waitFor(() => expect(summary.textContent).toBe('3Today1Pending3Upcoming'));
    // high priority first in Today; a task where I am the buddy is mine too
    const rows = screen
      .getAllByTestId('task-row')
      .map((r) => r.querySelector('.k-ttl').textContent);
    expect(rows.slice(0, 3)).toEqual(['Task b', 'Task buddy', 'Task a']);
    expect(rows).not.toContain('Task others');
    expect(screen.getByText('3 days late')).toBeTruthy();
    expect(screen.getByText('1 completed today')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Heet\./ })).toBeTruthy();

    // the ones I gave others, by person, with a WhatsApp nudge
    fireEvent.click(screen.getByRole('button', { name: 'Delegated' }));
    const nudge = await screen.findByRole('link', { name: 'Nudge Paresh on WhatsApp' });
    expect(nudge.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=.*Task%20others/);
  });

  it('asks who you are when nobody is set as me', async () => {
    auth.workspace = { mePersonId: null };
    api.tasks.list.mockResolvedValue([task('a', { ownerId: 'paresh', ownerName: 'Paresh Shah' })]);
    show('/', <Today />);
    expect(await screen.findByText('Who are you?')).toBeTruthy();
    // without a "me", every open task is listed
    expect(await screen.findByText('Task a')).toBeTruthy();
  });

  it('ticks a task off with an Undo', async () => {
    api.tasks.list.mockResolvedValue([task('a')]);
    api.tasks.update.mockImplementation(async (id, patch) =>
      task(id, {
        status: patch.status,
        doneAt: patch.status === 'done' ? new Date().toISOString() : null,
      }),
    );
    show('/', <Today />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Task a' }));
    await waitFor(() => expect(api.tasks.update).toHaveBeenCalledWith('a', { status: 'done' }), {
      timeout: 3000,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.tasks.update).toHaveBeenLastCalledWith('a', { status: 'open' }));
  });
});

describe('suggested tasks review', () => {
  it('approves with ✓, skips with ✕, and asks for an owner when the summary named an unknown voice', async () => {
    api.tasks.suggestions.mockResolvedValue([
      suggestion(0),
      suggestion(1),
      suggestion(2, { ownerId: null, speakerName: 'Speaker C' }),
    ]);
    api.tasks.create.mockImplementation(async (input) =>
      task('new', { title: input.title, ownerId: input.ownerId, ownerName: 'Paresh Shah' }),
    );
    show('/', <Today />);
    fireEvent.click(await screen.findByTestId('suggested'));
    const stack = await screen.findByTestId('review-stack');
    expect(within(stack).getByText('Suggested 0')).toBeTruthy();

    fireEvent.click(within(stack).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.tasks.create).toHaveBeenCalledWith({
        title: 'Suggested 0',
        ownerId: 'paresh',
        priority: 'high',
        due: addDays(1),
        fromSuggestion: { meetingId: 'm1', index: 0 },
      }),
    );
    fireEvent.click(await within(stack).findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(api.tasks.skip).toHaveBeenCalledWith('m1', 1));

    // nobody known as "Speaker C": approving opens the form to pick the owner
    expect(await within(stack).findByText('Pick someone (Speaker C)')).toBeTruthy();
    fireEvent.click(within(stack).getByRole('button', { name: 'Approve' }));
    const form = await screen.findByRole('dialog', { name: 'Approve task' });
    expect(within(form).getByText(/gave this to “Speaker C”/)).toBeTruthy();
    // only named people are offered
    fireEvent.change(within(form).getByLabelText('Who’s doing it?: search people'), {
      target: { value: 'speaker' },
    });
    expect(within(form).queryByText(/Meeting AOM/)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Who’s doing it?: search people'), {
      target: { value: 'pare' },
    });
    fireEvent.click(within(form).getByText('Paresh Shah'));
    fireEvent.click(within(form).getByRole('button', { name: 'Approve task' }));
    await waitFor(() =>
      expect(api.tasks.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ownerId: 'paresh',
          fromSuggestion: { meetingId: 'm1', index: 2 },
        }),
      ),
    );
    expect(await screen.findByText('All reviewed')).toBeTruthy();
    expect(screen.getByText('2 tasks added.')).toBeTruthy();
  });
});

describe('new task form', () => {
  it('needs an owner, then saves title, priority, buddy and deadline', async () => {
    api.tasks.create.mockImplementation(async (input) =>
      task('n', { ...input, ownerName: 'Paresh Shah' }),
    );
    show('/', <Today />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a task' }));
    const form = await screen.findByRole('dialog', { name: 'New task' });
    fireEvent.change(within(form).getByLabelText('What needs to be done?'), {
      target: { value: 'Call the foam supplier' },
    });
    // "me" is preselected for a task added under My tasks; give it to Paresh instead
    fireEvent.change(within(form).getByLabelText('Who’s doing it?: search people'), {
      target: { value: 'paresh' },
    });
    fireEvent.click(within(form).getByText('Paresh Shah'));
    fireEvent.click(within(form).getByRole('button', { name: /High/ }));
    fireEvent.click(
      within(within(form).getByRole('group', { name: 'Task buddy' })).getByRole('button', {
        name: /Me/,
      }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'No date' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    await waitFor(() =>
      expect(api.tasks.create).toHaveBeenCalledWith({
        title: 'Call the foam supplier',
        ownerId: 'paresh',
        buddyId: 'heet',
        priority: 'high',
        due: null,
        meetingId: null,
      }),
    );
    expect(await screen.findByText('Added for Paresh.')).toBeTruthy();
  });
});

describe('Team', () => {
  it('shows each person’s open, late and done work, with me first', async () => {
    api.tasks.list.mockResolvedValue([
      task('p1', { ownerId: 'paresh', ownerName: 'Paresh Shah', due: addDays(-2) }),
      task('p2', { ownerId: 'paresh', ownerName: 'Paresh Shah', due: addDays(3) }),
      task('h1', { status: 'done', doneAt: new Date().toISOString() }),
    ]);
    show('/team', <Team />);
    await screen.findByText('Paresh Shah');
    const heads = screen.getAllByRole('button', { expanded: false });
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining('Heet Dholakia (you)1 done'),
      expect.stringContaining('Paresh Shah2 open1 late'),
    ]);
    fireEvent.click(heads[1]);
    expect(await screen.findByText('Task p1')).toBeTruthy();
    expect(screen.getByText(dueLabel(addDays(-2)))).toBeTruthy();
    expect(screen.getByRole('link', { name: /Share standup/ }).getAttribute('href')).toMatch(
      /Standup/,
    );
  });
});

describe('Search', () => {
  it('finds tasks here and meetings on the server, linking to the moment it was said', async () => {
    api.tasks.list.mockResolvedValue([task('a', { title: 'Bhiwandi dispatch follow-up' })]);
    api.search.mockResolvedValue([
      {
        meetingId: 'm1',
        title: 'Ops',
        date: '2026-10-20',
        snippet: 'Bhiwandi ka dispatch',
        at: 125,
      },
    ]);
    show('/search', <Search />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'bhiwandi' } });
    });
    const results = await screen.findByTestId('search-results', {}, { timeout: 2000 });
    expect(within(results).getByText('Bhiwandi', { selector: 'mark' })).toBeTruthy();
    const link = await within(results).findByRole('link');
    expect(link.getAttribute('href')).toBe('/meetings/m1?t=125');
    expect(link.textContent).toContain('2:05');
    expect(api.search).toHaveBeenCalledWith('bhiwandi');
  });
});
