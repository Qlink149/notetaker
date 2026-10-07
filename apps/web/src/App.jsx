import { Toaster } from '@/components/ui/toaster';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import PageNotFound from '@/lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import ScrollToTop from '@/components/ScrollToTop';
import Layout from '@/components/Layout';
import Meetings from '@/pages/Meetings';
import Speakers from '@/pages/Speakers';
import Record from '@/pages/Record';
import MeetingDetail from '@/pages/MeetingDetail';
import Benchmark from '@/pages/Benchmark';
import Audit from '@/pages/Audit';
import Settings from '@/pages/Settings';
import Login from '@/pages/Login';

function AuthenticatedApp() {
  const { workspace, checking } = useAuth();

  if (checking) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!workspace) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Meetings />} />
        <Route path="/speakers" element={<Speakers />} />
        <Route path="/record" element={<Record />} />
        <Route path="/meetings/:id" element={<MeetingDetail />} />
        <Route path="/benchmark" element={<Benchmark />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <ScrollToTop />
        <AuthenticatedApp />
      </Router>
      <Toaster />
    </AuthProvider>
  );
}
