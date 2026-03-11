import { Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Home from './pages/Home.tsx';
import Vault from './pages/Vault.tsx';
import Admin from './pages/Admin.tsx';
import Tos from './pages/Tos.tsx';
import Footer from './components/Footer.tsx';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <ScrollToTop />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/vault/:vaultId" element={<Vault />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/tos" element={<Tos />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
