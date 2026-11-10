import { log } from "../platform/schema";
import { CircleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/** What a render error leaves on screen: a message and a way on, never a
 *  blank window. Try again draws what it holds afresh; Reload reloads the
 *  window. Each one is told to the app's maintainers (`log.error`: what
 *  broke and where in the window — never the page's words). */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void log.error("Notes could not draw its window", {
      error: `${error.name}: ${error.message}`.slice(0, 300),
      where: (info.componentStack ?? "").slice(0, 2000),
    }).catch(() => undefined);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="state-screen" role="alert">
        <span className="state-screen__mark state-screen__mark--danger"><CircleAlert size={20} /></span>
        <h1>Something went wrong</h1>
        <div className="state-screen__actions">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>Reload Notes</button>
        </div>
      </main>
    );
  }
}
