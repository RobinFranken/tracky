'use client'
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // The Architect: We use a push redirect to ensure 
    // the user lands straight on their portfolio dashboard.
    router.push('/dashboard');
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-black text-white font-sans">
      <div className="text-center">
        {/* Branding Expert: Simple, clean logo/loading state */}
        <h1 className="text-4xl font-black tracking-tighter mb-4 animate-pulse">
          TRACKY
        </h1>
        <div className="flex flex-col items-center gap-2">
          <div className="w-48 h-1 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 animate-[loading_1.5s_ease-in-out_infinite]"></div>
          </div>
          <p className="text-slate-500 text-xs uppercase tracking-widest font-bold">
            Initializing Terminal...
          </p>
        </div>
      </div>

      <style jsx>{`
        @keyframes loading {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}