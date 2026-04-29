export type BleRecoveryState = "connected" | "disconnected" | "reconnecting";

export type BleRecoveryBridge = {
  onEvent?: (name: string, handler: () => void) => void;
  addEventListener?: (name: string, handler: () => void) => void;
  reconnect?: () => void | Promise<void>;
};

export type BleRecoveryOptions = {
  bridge: BleRecoveryBridge;
  onStateChange?: (state: BleRecoveryState) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export class BleRecoveryController {
  private readonly bridge: BleRecoveryBridge;
  private readonly onStateChange?: (state: BleRecoveryState) => void;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private delayMs: number;
  state: BleRecoveryState = "connected";

  constructor(options: BleRecoveryOptions) {
    this.bridge = options.bridge;
    this.onStateChange = options.onStateChange;
    this.initialDelayMs = options.initialDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.delayMs = this.initialDelayMs;
  }

  start(): void {
    this.stopped = false;
    const on = this.bridge.onEvent || this.bridge.addEventListener;
    if (!on) return;
    for (const name of ["ble_disconnected", "bluetooth_disconnected", "g2_disconnected"]) {
      on.call(this.bridge, name, () => this.handleDisconnect());
    }
    for (const name of ["ble_connected", "bluetooth_connected", "g2_connected"]) {
      on.call(this.bridge, name, () => this.handleConnect());
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.setState("disconnected");
    this.scheduleReconnect();
  }

  private handleConnect(): void {
    this.delayMs = this.initialDelayMs;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState("connected");
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.state === "connected") return;
      this.setState("reconnecting");
      void this.bridge.reconnect?.();
      if ((this.state as BleRecoveryState) !== "connected") this.scheduleReconnect();
    }, delay);
  }

  private setState(state: BleRecoveryState): void {
    this.state = state;
    this.onStateChange?.(state);
  }
}
