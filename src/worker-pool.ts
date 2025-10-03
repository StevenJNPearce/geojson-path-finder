import fs from "fs";
import os from "os";
import path from "path";
import type { Worker } from "worker_threads";
import type {
  Key,
  Path,
  PathFinderGraph,
  PathFinderWorkerOptions,
} from "./types";

export type WorkerSearchOptions = {
  algorithm?: "dijkstra" | "astar";
};

export type WorkerInitData<TEdgeReduce> = {
  graph: PathFinderGraph<TEdgeReduce>;
  hasEdgeDataReducer: boolean;
};

export type WorkerRequest<TEdgeReduce> = {
  id: number;
  start: Key;
  finish: Key;
  searchOptions: WorkerSearchOptions;
};

export type WorkerResponse<TEdgeReduce> = {
  id: number;
  path?: Path<TEdgeReduce> | undefined;
  error?: { message: string; stack?: string };
};

type PendingTask<TEdgeReduce> = {
  request: WorkerRequest<TEdgeReduce>;
  resolve: (path: Path<TEdgeReduce> | undefined) => void;
  reject: (reason: unknown) => void;
};

type WorkerContainer<TEdgeReduce> = {
  worker: Worker;
  currentTask?: PendingTask<TEdgeReduce> & { id: number };
};

type WorkerPoolConfig<TEdgeReduce> = {
  graph: PathFinderGraph<TEdgeReduce>;
  hasEdgeDataReducer: boolean;
  options?: PathFinderWorkerOptions;
};

let workerThreadsModulePromise:
  | Promise<typeof import("worker_threads") | undefined>
  | undefined;

function isModuleNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return (
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ERR_UNKNOWN_FILE_EXTENSION"
  );
}

function getImportMetaUrl(): string | undefined {
  try {
    return Function("return import.meta.url;")() as string;
  } catch (error) {
    return undefined;
  }
}

function loadWorkerThreads():
  | Promise<typeof import("worker_threads") | undefined> {
  if (workerThreadsModulePromise) {
    return workerThreadsModulePromise;
  }

  workerThreadsModulePromise = (async () => {
    if (typeof process === "undefined" || !process.versions?.node) {
      return undefined;
    }

    const requireFn: undefined | ((module: string) => unknown) =
      typeof require === "function"
        ? require
        : (() => {
            const createRequire = Function(
              "return typeof module !== 'undefined' && module.createRequire ? module.createRequire : undefined;"
            )() as ((url: string) => typeof require) | undefined;
            if (!createRequire) {
              return undefined;
            }

            const importMetaUrl = getImportMetaUrl();
            if (!importMetaUrl) {
              return undefined;
            }

            try {
              return createRequire(importMetaUrl);
            } catch (error) {
              return undefined;
            }
          })();

    if (typeof requireFn === "function") {
      try {
        return requireFn("worker_threads") as typeof import("worker_threads");
      } catch (error) {
        if (!isModuleNotFoundError(error)) {
          throw error;
        }
      }
    }

    const dynamicImport = Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;

    try {
      return (await dynamicImport("node:worker_threads")) as typeof import("worker_threads");
    } catch (error) {
      if (!isModuleNotFoundError(error)) {
        throw error;
      }
    }

    try {
      return (await dynamicImport("worker_threads")) as typeof import("worker_threads");
    } catch (error) {
      if (!isModuleNotFoundError(error)) {
        throw error;
      }
    }

    return undefined;
  })();

  return workerThreadsModulePromise;
}

export async function isWorkerThreadsAvailable() {
  return Boolean(await loadWorkerThreads());
}

const workerRelativePath = path.join("worker", "pathfinder-worker.js");

function resolveWorkerSpecifier() {
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, workerRelativePath);
  }

  const importMetaUrl = getImportMetaUrl();

  if (importMetaUrl) {
    return new URL(workerRelativePath, importMetaUrl);
  }

  if (typeof process !== "undefined" && process.versions?.node) {
    const candidates = [
      path.resolve(process.cwd(), workerRelativePath),
      path.resolve(process.cwd(), "dist", "cjs", workerRelativePath),
      path.resolve(process.cwd(), "dist", "esm", workerRelativePath),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export default class PathFinderWorkerPool<TEdgeReduce> {
  private readonly workerThreadsPromise = loadWorkerThreads();
  private readonly readyPromise: Promise<void>;
  private readonly workers: WorkerContainer<TEdgeReduce>[] = [];
  private readonly idleWorkers: WorkerContainer<TEdgeReduce>[] = [];
  private readonly queue: (PendingTask<TEdgeReduce> & { id: number })[] = [];
  private readonly tasks = new Map<number, PendingTask<TEdgeReduce> & { id: number }>();
  private readonly poolSize: number;
  private readonly specifier: string | URL;
  private workerThreads?: typeof import("worker_threads");
  private nextId = 0;
  private disposed = false;

  constructor(private readonly config: WorkerPoolConfig<TEdgeReduce>) {
    const specifier = resolveWorkerSpecifier();
    if (!specifier) {
      throw new Error("Worker threads are not available on this platform.");
    }
    this.specifier = specifier;

    const desiredSize = this.config.options?.poolSize;
    this.poolSize = desiredSize && desiredSize > 0 ? desiredSize : Math.max(1, os.cpus()?.length ?? 1);

    this.readyPromise = this.workerThreadsPromise.then((workerThreads) => {
      if (!workerThreads) {
        throw new Error("Worker threads are not available on this platform.");
      }
      if (this.disposed) {
        return;
      }
      this.workerThreads = workerThreads;
      for (let i = 0; i < this.poolSize; i += 1) {
        this._spawnWorker(workerThreads);
      }
    });
    // Prevent unhandled rejections when the pool is disposed before initialisation.
    this.readyPromise.catch(() => undefined);
  }

  async schedule(
    start: Key,
    finish: Key,
    searchOptions: WorkerSearchOptions
  ): Promise<Path<TEdgeReduce> | undefined> {
    if (this.disposed) {
      throw new Error("Worker pool has been closed.");
    }

    await this.readyPromise;
    if (this.disposed) {
      throw new Error("Worker pool has been closed.");
    }

    const id = this.nextId++;
    const request: WorkerRequest<TEdgeReduce> = {
      id,
      start,
      finish,
      searchOptions,
    };

    return new Promise((resolve, reject) => {
      const task: PendingTask<TEdgeReduce> & { id: number } = {
        id,
        request,
        resolve,
        reject,
      };
      this.tasks.set(id, task);
      const worker = this.idleWorkers.pop();
      if (worker) {
        this._dispatch(worker, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  async close() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    await this.readyPromise.catch(() => undefined);

    const closingError = new Error("Worker pool has been closed.");

    this.queue.splice(0).forEach((task) => {
      this.tasks.delete(task.id);
      task.reject(closingError);
    });

    for (const container of this.workers) {
      const current = container.currentTask;
      if (current) {
        this.tasks.delete(current.id);
        current.reject(closingError);
        container.currentTask = undefined;
      }
    }

    this.tasks.clear();

    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));

    this.workers.length = 0;
    this.idleWorkers.length = 0;
  }

  private _spawnWorker(workerThreads?: typeof import("worker_threads")) {
    const threads = workerThreads ?? this.workerThreads;
    if (!threads) {
      return;
    }

    const worker = new threads.Worker(this.specifier, {
      workerData: {
        graph: this.config.graph,
        hasEdgeDataReducer: this.config.hasEdgeDataReducer,
      } as WorkerInitData<TEdgeReduce>,
    });

    const container: WorkerContainer<TEdgeReduce> = { worker };
    worker.on("message", (message: WorkerResponse<TEdgeReduce>) =>
      this._handleMessage(container, message)
    );
    worker.on("error", (error) => this._handleError(container, error));
    worker.on("exit", (code) => this._handleExit(container, code));

    this.workers.push(container);
    const nextTask = this.queue.shift();
    if (nextTask) {
      this._dispatch(container, nextTask);
    } else {
      this.idleWorkers.push(container);
    }
  }

  private _dispatch(
    container: WorkerContainer<TEdgeReduce>,
    task: PendingTask<TEdgeReduce> & { id: number }
  ) {
    container.currentTask = task;
    container.worker.postMessage(task.request);
  }

  private _release(container: WorkerContainer<TEdgeReduce>) {
    container.currentTask = undefined;
    if (this.disposed) {
      return;
    }

    const nextTask = this.queue.shift();
    if (nextTask) {
      this._dispatch(container, nextTask);
    } else {
      this.idleWorkers.push(container);
    }
  }

  private _handleMessage(
    container: WorkerContainer<TEdgeReduce>,
    message: WorkerResponse<TEdgeReduce>
  ) {
    const task = this.tasks.get(message.id);
    if (!task) {
      this._release(container);
      return;
    }

    this.tasks.delete(message.id);

    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.stack) {
        error.stack = message.error.stack;
      }
      task.reject(error);
    } else {
      task.resolve(message.path);
    }

    this._release(container);
  }

  private _handleError(container: WorkerContainer<TEdgeReduce>, error: unknown) {
    const task = container.currentTask;
    if (task) {
      this.tasks.delete(task.id);
      task.reject(error);
    }
    this._removeWorker(container);
    if (!this.disposed) {
      this._spawnWorker();
    }
  }

  private _handleExit(container: WorkerContainer<TEdgeReduce>, code: number) {
    const task = container.currentTask;
    if (task) {
      this.tasks.delete(task.id);
      task.reject(new Error("Worker terminated unexpectedly."));
    }
    this._removeWorker(container);
    if (!this.disposed && code !== 0) {
      this._spawnWorker();
    }
  }

  private _removeWorker(container: WorkerContainer<TEdgeReduce>) {
    const index = this.workers.indexOf(container);
    if (index >= 0) {
      this.workers.splice(index, 1);
    }
    const idleIndex = this.idleWorkers.indexOf(container);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
  }
}
