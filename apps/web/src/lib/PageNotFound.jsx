import { Link, useLocation } from "react-router-dom";

export default function PageNotFound() {
  const location = useLocation();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-7xl font-light text-muted-foreground/40">404</h1>
        <h2 className="text-2xl font-medium">Page not found</h2>
        <p className="text-muted-foreground">
          Nothing lives at <span className="font-medium text-foreground">{location.pathname}</span>.
        </p>
        <Link to="/" className="inline-block text-sm font-medium underline">
          Go to meetings
        </Link>
      </div>
    </div>
  );
}
