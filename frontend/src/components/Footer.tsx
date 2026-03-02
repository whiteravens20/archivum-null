export default function Footer() {
  return (
    <footer className="border-t border-vault-secondary/50 py-6 px-4 text-center text-xs text-gray-500">
      <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
        <span className="tracking-wider uppercase">Archivum Null</span>
        <div className="flex gap-4">
          <a
            href="/tos"
            className="hover:text-vault-accent transition-colors"
          >
            Terms of Service
          </a>
          <a
            href="https://github.com/whiteravens20/archivum-null"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-vault-accent transition-colors"
          >
            Source
          </a>
        </div>
        <span>Zero trust file relay.</span>
      </div>
    </footer>
  );
}
