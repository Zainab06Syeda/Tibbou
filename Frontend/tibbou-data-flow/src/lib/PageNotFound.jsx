import { Link, useLocation } from "react-router-dom";

export default function PageNotFound() {
  const location = useLocation();
  const pageName = location.pathname || "/";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl shadow-black/20">
        <p className="text-6xl font-semibold tracking-tight text-primary/60">404</p>
        <h1 className="mt-4 text-2xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          <span className="font-medium text-foreground">{pageName}</span> is not available in this
          view.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex rounded-full border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
        >
          Return to dashboard
        </Link>
      </div>
    </div>
  );
}
