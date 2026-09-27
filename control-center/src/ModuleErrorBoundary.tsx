import { Component, type ErrorInfo, type ReactNode } from "react";

export class ModuleErrorBoundary extends Component<
  { moduleId: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Control Center module failed", this.props.moduleId, error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <section className="module module-failed">
        <header><strong>{this.props.moduleId}</strong><div className="state state-degraded">DEGRADED</div></header>
        <div className="module-body"><div className="truth-banner"><b>Module isolated</b><span>שגיאת תצוגה מקומית בודדה; שאר מרכז השליטה ממשיך לפעול.</span></div></div>
      </section>;
    }
    return this.props.children;
  }
}
