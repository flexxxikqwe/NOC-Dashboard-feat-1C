import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col items-center justify-center p-4 font-mono text-xs">
      <div className="p-4 border border-zinc-800 bg-zinc-900 rounded space-y-2 text-center max-w-sm">
        <h2 className="text-sm font-bold text-red-400">404: PAGE_NOT_FOUND</h2>
        <p className="text-zinc-500">Запрашиваемый ресурс не найден в системе мониторинга.</p>
        <Link
          href="/"
          className="inline-block mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-xs"
        >
          RETURN_TO_DASHBOARD
        </Link>
      </div>
    </div>
  );
}
