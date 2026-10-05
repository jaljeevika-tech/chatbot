import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] caught error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl">
            <p className="font-bold text-gray-900 mb-1">Something went wrong</p>
            <p className="text-xs text-gray-500 mb-4 font-mono break-all">
              {this.state.error?.message ?? 'Unknown error'}
            </p>
            <button
              onClick={this.handleReset}
              className="w-full py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:opacity-90 transition"
            >
              Dismiss
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
