export type BackgroundBridge = {
  setBackgroundState?: (state: unknown) => void | Promise<void>;
  onBackgroundRestore?: (handler: (state: unknown) => void) => void;
};

export type BackgroundLifecycleOptions = {
  snapshot: () => unknown;
  restore: (state: unknown) => void;
};

export function bindBackgroundLifecycle(bridge: BackgroundBridge, options: BackgroundLifecycleOptions) {
  bridge.onBackgroundRestore?.((state) => options.restore(state));

  return {
    async persist(): Promise<void> {
      await bridge.setBackgroundState?.(options.snapshot());
    },
  };
}
