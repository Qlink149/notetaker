import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  BarChart3,
  CalendarDays,
  Gauge,
  Home,
  Mic2,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { KeptProvider, useKept } from '@/lib/keptStore';
import { FEATURES } from '@/lib/features';
import { Avatar } from '@/components/kept/bits';
import { daysUntil } from '@/lib/kept';

// "Kept" navigation (client prototype, 20 Oct). Phones: the bottom tab bar Today · Meetings · + · Team · Search,
// with Speakers and Settings behind the profile button on Today. Desktop (≥1024 px): a sidebar with all of it.
const TABS = [
  { to: '/', label: 'Today', icon: Home, end: true },
  { to: '/meetings', label: 'Meetings', icon: CalendarDays, end: false },
  { to: '/team', label: 'Team', icon: Users, end: false },
  { to: '/search', label: 'Search', icon: Search, end: false },
];

/** Pages laid out in columns on a desktop; the rest (forms, lists of settings) stay at a reading width. */
const WIDE = [/^\/$/, /^\/meetings/, /^\/team/];

function Tab({ to, label, icon: Icon, end }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon className="w-[22px] h-[22px]" strokeWidth={1.8} />
      <span>{label}</span>
    </NavLink>
  );
}

function SideLink({ to, label, icon: Icon, end, badge }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `k-side-link${isActive ? ' active' : ''}`}
    >
      <Icon className="w-[19px] h-[19px]" strokeWidth={1.8} />
      <span className="flex-1">{label}</span>
      {badge > 0 && <span className="k-side-badge">{badge}</span>}
    </NavLink>
  );
}

function Sidebar() {
  const { me, tasks, people, openProfile } = useKept();
  const mine = people.find((p) => p.id === me);
  // what needs attention today: due today or past its date
  const due = (tasks ?? []).filter(
    (t) =>
      t.status === 'open' &&
      (!me || t.ownerId === me || t.buddyId === me) &&
      t.due &&
      daysUntil(t.due) <= 0,
  ).length;
  return (
    <aside className="k-side" aria-label="Sidebar">
      <div className="k-wordmark text-[28px] px-3 pt-1">Kept.</div>
      <NavLink to="/record" className="k-btn k-primary !h-11 !text-sm mt-6">
        <Plus className="w-[18px] h-[18px]" strokeWidth={2.2} /> New meeting
      </NavLink>
      <nav className="mt-6 flex flex-col gap-0.5" aria-label="Sections">
        <SideLink {...TABS[0]} badge={due} />
        {TABS.slice(1).map((t) => (
          <SideLink key={t.to} {...t} />
        ))}
      </nav>
      <div className="k-side-sep" />
      <nav className="flex flex-col gap-0.5" aria-label="More">
        <SideLink to="/speakers" label="Speakers" icon={Mic2} />
        {FEATURES.insights && <SideLink to="/dashboard" label="Insights" icon={BarChart3} />}
        {FEATURES.benchmark && <SideLink to="/benchmark" label="Benchmark" icon={Gauge} />}
        <SideLink to="/settings" label="Settings" icon={Settings} />
      </nav>
      <button
        type="button"
        className="k-side-me"
        onClick={openProfile}
        aria-label="Your profile and settings"
      >
        <Avatar id={me} name={mine?.name ?? 'Me'} />
        <span className="truncate">{mine?.name ?? 'Who are you?'}</span>
      </button>
    </aside>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const wide = WIDE.some((re) => re.test(pathname));
  return (
    <KeptProvider>
      <div className="min-h-screen bg-background lg:pl-[248px]">
        <Sidebar />
        <main
          className={`w-full max-w-xl mx-auto px-4 pb-32 pt-6 lg:px-10 lg:pt-8 lg:pb-16 ${
            wide ? 'lg:max-w-[1200px]' : 'lg:max-w-3xl'
          }`}
        >
          <Outlet />
        </main>
        <nav className="k-tabbar" aria-label="Main">
          <Tab {...TABS[0]} />
          <Tab {...TABS[1]} />
          <NavLink to="/record" className="k-plus" aria-label="New meeting">
            <Plus className="w-[26px] h-[26px]" strokeWidth={2.2} />
          </NavLink>
          <Tab {...TABS[2]} />
          <Tab {...TABS[3]} />
        </nav>
      </div>
    </KeptProvider>
  );
}
