import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-24 text-center">
      <p className="text-7xl font-bold text-vault-accent mb-4">404</p>
      <h1 className="text-2xl font-semibold text-gray-100 mb-3">Page not found</h1>
      <p className="text-gray-400 text-sm mb-8">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        to="/"
        className="inline-block px-5 py-2 rounded bg-vault-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
      >
        ← Back to Home
      </Link>
    </div>
  );
}
