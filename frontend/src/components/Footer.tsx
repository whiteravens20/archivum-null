import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="border-t border-vault-secondary/50 py-6 px-4 text-center text-xs text-gray-500">
      <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="tracking-wider uppercase">Archivum Null</span>
          <span className="text-vault-secondary/50">|</span>
{/* If you like this project please keep "Powered by Archivum Null" or Source link in the footer ❤️ */}
          <a
            href="https://github.com/whiteravens20/archivum-null"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-vault-accent transition-colors"
          >
            Source
          </a>
          <span className="text-vault-secondary/50">|</span>
          <Link
            to="/tos"
            className="hover:text-vault-accent transition-colors"
          >
            Terms of Service
          </Link>
        </div>
        <span>Zero trust file relay.</span>
      </div>
    </footer>
  );
}
