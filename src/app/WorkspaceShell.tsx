// The app's collections, declared before anything opens one.
import "../../schema";
import "./workspace.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { UiProvider } from "./ui-context";
import { WorkspaceProvider } from "./workspace-context";

/** Authenticated workspace shell, loaded lazily once AuthGate admits a user
 *  (or prefetched quietly while the user types their credentials). */
export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <ErrorBoundary>
        <UiProvider>
          <App />
        </UiProvider>
      </ErrorBoundary>
    </WorkspaceProvider>
  );
}
