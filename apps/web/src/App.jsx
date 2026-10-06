import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import ScrollToTop from './components/ScrollToTop';
// Add page imports here
import Layout from '@/components/Layout';
import Meetings from '@/pages/Meetings';
import Speakers from '@/pages/Speakers';
import Record from '@/pages/Record';
import MeetingDetail from '@/pages/MeetingDetail';
import Benchmark from '@/pages/Benchmark';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings } = useAuth();

  // Show loading spinner while checking app public settings
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Render the main app — public, no login required
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Meetings />} />
        <Route path="/speakers" element={<Speakers />} />
        <Route path="/record" element={<Record />} />
        <Route path="/meetings/:id" element={<MeetingDetail />} />
        <Route path="/benchmark" element={<Benchmark />} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )

}

export default App