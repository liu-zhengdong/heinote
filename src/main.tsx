import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { NotebookPen } from "lucide-react";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { AuthGate } from "./features/account/AuthGate";
import "./styles/index.css";
import "./features/account/account.css";
import "./styles/standalone.css";

const PublicShare = lazy(() => import("./features/share/PublicShare").then((module) => ({ default: module.PublicShare })));
const WorkspaceShell = lazy(() => import("./app/WorkspaceShell").then((module) => ({ default: module.WorkspaceShell })));

const loadingScreen = (
  <div className="state-screen state-screen--loading" role="status" aria-label="正在打开小黑笔记">
    <span className="state-screen__mark"><NotebookPen size={20} /></span>
    <p>正在打开小黑笔记…</p>
  </div>
);

/* Two boundaries, so a render error never leaves a blank window. One inside
   the workspace, around what draws it: the workspace stays open behind the
   message and goes on saving what was written. One outside everything, for
   an error in the workspace itself: Try again opens it afresh. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {window.location.pathname.startsWith("/s/") ? (
        <Suspense fallback={loadingScreen}><PublicShare /></Suspense>
      ) : (
        <AuthGate>
          <Suspense fallback={loadingScreen}>
            <WorkspaceShell />
          </Suspense>
        </AuthGate>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
