// The app's collections, declared before anything opens one.
import "../schema";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { UiProvider } from "./app/ui-context";
import { WorkspaceProvider } from "./app/workspace-context";
import { AuthGate } from "./features/account/AuthGate";
import { SaveRecovery } from "./features/account/SaveRecovery";
import { PublicShare } from "./features/share/PublicShare";
import "./styles/index.css";
import "./features/account/account.css";
import "./styles/standalone.css";

/* Two boundaries, so a render error never leaves a blank window. One inside
   the workspace, around what draws it: the workspace stays open behind the
   message and goes on saving what was written. One outside everything, for
   an error in the workspace itself: Try again opens it afresh. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {window.location.pathname.startsWith("/s/") ? <PublicShare /> : (
        <AuthGate>
          <WorkspaceProvider>
            <ErrorBoundary>
              <UiProvider>
                <App />
                <SaveRecovery />
              </UiProvider>
            </ErrorBoundary>
          </WorkspaceProvider>
        </AuthGate>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
