import { Component, ErrorInfo, ReactNode } from "react"

import { ErrorDetails } from "./ErrorDetails"

interface Props {
  children: ReactNode
  catchErrors: "always" | "dev" | "prod" | "never"
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

/**
 * A class component because, per the React documentation, only class components
 * can be error boundaries.
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/concept/Error-Boundary/}
 * @see [React Error Boundaries]{@link https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary}
 */
export class ErrorBoundary extends Component<Props, State> {
  state = { error: null, errorInfo: null }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (!this.isEnabled()) {
      return
    }
    this.setState({
      error,
      errorInfo,
    })

    // Deliberately not wired to a crash reporter. Hearth ships no third party
    // SDK, and a stack trace from a location app is not ours to collect.
    // reportCrash(error)
  }

  resetError = () => {
    this.setState({ error: null, errorInfo: null })
  }

  shouldComponentUpdate(nextProps: Readonly<Props>, nextState: Readonly<State>): boolean {
    return nextState.error !== this.state.error
  }

  isEnabled(): boolean {
    return (
      this.props.catchErrors === "always" ||
      (this.props.catchErrors === "dev" && __DEV__) ||
      (this.props.catchErrors === "prod" && !__DEV__)
    )
  }

  render() {
    return this.isEnabled() && this.state.error ? (
      <ErrorDetails
        onReset={this.resetError}
        error={this.state.error}
        errorInfo={this.state.errorInfo}
      />
    ) : (
      this.props.children
    )
  }
}
