import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";

export default function ProtectedRoute() {
  const { loading, session } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center">Loading…</div>;
  return session ? <Outlet /> : <Navigate to="/login" replace />;
}
