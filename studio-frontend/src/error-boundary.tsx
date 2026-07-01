import React from "react";

interface AppErrorBoundaryState {
  error: unknown;
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("Pocket Studio UI crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="max-w-lg rounded-2xl border border-white/10 bg-white/10 p-5 shadow-2xl">
          <h1 className="text-base font-bold">Pocket Studio 前端渲染异常</h1>
          <p className="mt-2 text-sm text-slate-300">页面没有白屏，已捕获错误。可以刷新页面重试。</p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-xl bg-black/40 p-3 text-xs text-rose-100">
            {errorMessage(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-400"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack || ""}`.trim();
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
