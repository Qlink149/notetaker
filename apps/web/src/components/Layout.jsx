import { Outlet, NavLink } from 'react-router-dom';
import { CalendarDays, Home, Plus, Search, Users } from 'lucide-react';
import { KeptProvider } from '@/lib/keptStore';

// The "Kept" tab bar (client prototype, 20 Oct): Today · Meetings · + · Team · Search. Speakers and Settings
// open from the profile button on Today and from Team.
const TABS = [
  { to: '/', label: 'Today', icon: Home, end: true },
  { to: '/meetings', label: 'Meetings', icon: CalendarDays, end: false },
  { to: '/team', label: 'Team', icon: Users, end: false },
  { to: '/search', label: 'Search', icon: Search, end: false },
];

function Tab({ to, label, icon: Icon, end }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon className="w-[22px] h-[22px]" strokeWidth={1.8} />
      <span>{label}</span>
    </NavLink>
  );
}

export default function Layout() {
  return (
    <KeptProvider>
      <div className="min-h-screen bg-background flex flex-col">
        <main className="flex-1 w-full max-w-xl mx-auto px-4 pb-32 pt-6">
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
