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

let workerThreadsModule:
  | (typeof import("worker_threads"))
  | undefined;
let workerThreadsChecked = false;

function loadWorkerThreads():
  | (typeof import("worker_threads"))
  | undefined {
  if (workerThreadsChecked) {
    return workerThreadsModule;
  }
  workerThreadsChecked = true;

  if (typeof process === "undefined" || !process.versions?.node) {
    return undefined;
  }

  const requireFn: undefined | ((module: string) => unknown) =
    typeof require === "function"
      ? require
      : Function(
          "return typeof require !== 'undefined' ? require : undefined;"
        )();

  if (typeof requireFn !== "function") {
    return undefined;
  }

  workerThreadsModule = requireFn("worker_threads") as typeof import("worker_threads");
  return workerThreadsModule;
}

export function isWorkerThreadsAvailable() {
  return Boolean(loadWorkerThreads());
}

const workerRelativePath = path.join("worker", "pathfinder-worker.js");

function resolveWorkerSpecifier() {
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, workerRelativePath);
  }

  return undefined;
}

export default class PathFinderWorkerPool<TEdgeReduce> {
  private readonly workerThreads = loadWorkerThreads();
  private readonly workers: WorkerContainer<TEdgeReduce>[] = [];
  private readonly idleWorkers: WorkerContainer<TEdgeReduce>[] = [];
  private readonly queue: (PendingTask<TEdgeReduce> & { id: number })[] = [];
  private readonly tasks = new Map<number, PendingTask<TEdgeReduce> & { id: number }>();
  private readonly poolSize: number;
  private readonly specifier: string | URL;
  private nextId = 0;
  private disposed = false;

  constructor(private readonly config: WorkerPoolConfig<TEdgeReduce>) {
    const specifier = resolveWorkerSpecifier();
    if (!this.workerThreads || !specifier) {
      throw new Error("Worker threads are not available on this platform.");
    }
    this.specifier = specifier;

    const desiredSize = this.config.options?.poolSize;
    this.poolSize = desiredSize && desiredSize > 0 ? desiredSize : Math.max(1, os.cpus()?.length ?? 1);

    for (let i = 0; i < this.poolSize; i += 1) {
      this._spawnWorker();
    }
  }

  schedule(
    start: Key,
    finish: Key,
    searchOptions: WorkerSearchOptions
  ): Promise<Path<TEdgeReduce> | undefined> {
    if (this.disposed) {
      return Promise.reject(new Error("Worker pool has been closed."));
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

  private _spawnWorker() {
    if (!this.workerThreads) {
      return;
    }

    const worker = new this.workerThreads.Worker(this.specifier, {
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
