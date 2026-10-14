import { Outlet, NavLink } from 'react-router-dom';
import { Mic, Upload, Users, List, Gauge, Settings, BarChart3 } from 'lucide-react';
import { FEATURES } from '@/lib/features';

export default function Layout() {
  const navItems = [
    { to: '/', label: 'Meetings', icon: List, end: true },
    FEATURES.liveRecording
      ? { to: '/record', label: 'Record', icon: Mic, end: false }
      : { to: '/record', label: 'Upload', icon: Upload, end: false },
    { to: '/speakers', label: 'Speakers', icon: Users, end: false },
    ...(FEATURES.insights
      ? [{ to: '/dashboard', label: 'Insights', icon: BarChart3, end: false }]
      : []),
    ...(FEATURES.benchmark
      ? [{ to: '/benchmark', label: 'Benchmark', icon: Gauge, end: false }]
      : []),
    { to: '/settings', label: 'Settings', icon: Settings, end: false },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 w-full max-w-2xl mx-auto px-4 pb-28 pt-6">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 border-t bg-background/95 backdrop-blur z-40">
        <div className="max-w-2xl mx-auto flex">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
                    isActive ? 'text-foreground' : 'text-muted-foreground'
                  }`
                }
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
