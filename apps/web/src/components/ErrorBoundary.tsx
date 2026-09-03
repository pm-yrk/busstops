import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./primitives.js";

/**
 * Route-level error boundary.
 *
 * Without one, a single component throwing unmounts the whole React tree and the user gets a
 * blank white page — which reads as "the internet is broken" rather than "this part of the site
 * failed", and gives them nothing to do next. With one, the rest of the app keeps working and the
 * failure is a panel with a way out.
 *
 * The error itself is not shown. A stack trace tells a passenger nothing and can leak internal
 * detail; the console keeps it for whoever is actually debugging.
 */

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary, so navigating away from a broken route recovers. */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  resetKey: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A new route clears a previous route's failure without needing a reload.
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept out of the interface but available to anyone with the console open.
    console.error("Unhandled error in a page component:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorState
          title="This part of the page could not be shown"
          description="Something went wrong displaying this. The rest of the site still works, and reloading usually fixes it."
          onRetry={() => this.setState({ hasError: false })}
        />
      );
    }
    return this.props.children;
  }
}
