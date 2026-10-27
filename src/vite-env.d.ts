/// <reference types="vite/client" />
import type { JinBridge } from "../shared/ipc";

declare global {
  interface Window {
    jin: JinBridge;
  }
}

export {};
