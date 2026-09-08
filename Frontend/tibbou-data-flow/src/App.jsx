import { BrowserRouter as Router, Route, Routes } from "react-router-dom";

import Layout from "@/components/Layout";
import ProtectedRoute from "@/components/ProtectedRoute";
import WorkspaceGate from "@/components/WorkspaceGate";
import { AuthProvider } from "@/contexts/AuthContext";
import { OrganizationProvider } from "@/contexts/OrganizationContext";
import PageNotFound from "@/lib/PageNotFound";
import CostTracking from "@/pages/CostTracking";
import Dashboard from "@/pages/Dashboard";
import Datasets from "@/pages/Datasets";
import Lineage from "@/pages/Lineage";
import AuthCallback from "@/pages/AuthCallback";
import Login from "@/pages/Login";

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<OrganizationProvider><WorkspaceGate /></OrganizationProvider>}>
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/datasets" element={<Datasets />} />
                <Route path="/lineage" element={<Lineage />} />
                <Route path="/costs" element={<CostTracking />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<PageNotFound />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}
