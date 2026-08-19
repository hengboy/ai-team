import { execFile, type ChildProcess } from "node:child_process";
import { ValidationError } from "./errors.js";
import type { StateStore } from "./state.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

let currentInvocation: InvocationResources | undefined;

export const setInvocationResources = (resources?: InvocationResources): void => { currentInvocation = resources; };
export const registerInvocationFinalizer = (finalizer: () => Promise<void>): (() => void) => currentInvocation?.registerFinalizer(finalizer) ?? (() => {});

export const execFileForInvocation = (file: string, args: readonly string[], options: {
  cwd?: string;
  maxBuffer?: number;
} = {}): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  const resources = currentInvocation;
  resources?.assertRunning();
  const child = execFile(file, [...args], {
    ...options,
    encoding: "utf8",
    ...(resources ? { detached: true, signal: resources.signal } : {}),
  }, (error, stdout, stderr) => {
    unregister?.();
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
  const unregister = resources?.registerChild(child);
});

export class InvocationResources {
  readonly abortController = new AbortController();
  private readonly stores = new Set<StateStore>();
  private readonly children = new Set<ChildProcess>();
  private readonly finalizers = new Set<() => Promise<void>>();
  private state: "running" | "quiescing" | "forced" | "closed" = "running";
  private shutdownPromise?: Promise<void>;
  private deadline?: NodeJS.Timeout;

  constructor(private readonly deadlineMs = 5_000) {}

  get signal(): AbortSignal { return this.abortController.signal; }
  get quiescing(): boolean { return this.state !== "running"; }

  assertRunning(): void {
    if (this.quiescing) throw new ValidationError("command invocation is shutting down");
  }

  registerStore(store: StateStore): () => void {
    this.assertRunning();
    this.stores.add(store);
    return () => this.stores.delete(store);
  }

  registerChild(child: ChildProcess): () => void {
    this.assertRunning();
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    return () => this.children.delete(child);
  }

  registerFinalizer(finalizer: () => Promise<void>): () => void {
    this.assertRunning();
    this.finalizers.add(finalizer);
    return () => this.finalizers.delete(finalizer);
  }

  quiesce(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.state = "quiescing";
    this.abortController.abort();
    const release = Promise.allSettled([...this.finalizers].map((finalizer) => finalizer()))
      .then(async () => { await Promise.allSettled([...this.stores].map((store) => store.closeAsync())); });
    const timeout = new Promise<void>((resolve) => {
      this.deadline = setTimeout(() => { this.force(); resolve(); }, this.deadlineMs);
      this.deadline.unref();
    });
    this.shutdownPromise = Promise.race([release, timeout]).finally(() => {
      if (this.deadline) clearTimeout(this.deadline);
      if (this.state !== "forced") this.state = "closed";
    });
    return this.shutdownPromise;
  }

  force(): void {
    if (this.state === "forced" || this.state === "closed") return;
    this.state = "forced";
    this.abortController.abort();
    for (const child of this.children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* process already exited */ } }
    }
    this.children.clear();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    await this.quiesce();
  }
}
