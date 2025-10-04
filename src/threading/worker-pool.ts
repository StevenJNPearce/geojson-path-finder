import type { Worker, WorkerOptions } from "node:worker_threads";
import type { Feature, Point } from "geojson";
import type { Path, PathFinderSearchOptions } from "../types";
import type {
  WorkerInitData,
  WorkerRequestPayload,
  WorkerResponsePayload,
} from "./worker-types";

type WorkerConstructor = new (
  filename: string | URL,
  options?: WorkerOptions
) => Worker;

type PendingTask<TEdgeReduce> = {
  resolve: (value: Path<TEdgeReduce> | undefined) => void;
  reject: (reason?: unknown) => void;
};

export default class PathFinderWorkerPool<TEdgeReduce> {
  private readonly workers: Worker[] = [];
  private readonly idleWorkers: Worker[] = [];
  private readonly queue: WorkerRequestPayload<TEdgeReduce>[] = [];
  private readonly pending = new Map<number, PendingTask<TEdgeReduce>>();
  private readonly activeTask = new Map<Worker, number>();
  private nextTaskId = 0;
  private destroyed = false;

  constructor(
    private readonly WorkerCtor: WorkerConstructor,
    private readonly scriptPath: string,
    initData: WorkerInitData<TEdgeReduce>,
    workerCount: number
  ) {
    const size = Math.max(1, Math.floor(workerCount));
    for (let i = 0; i < size; i++) {
      const worker = new this.WorkerCtor(this.scriptPath, {
        workerData: initData,
      });
      this.workers.push(worker);
      this.idleWorkers.push(worker);
      worker.on("message", (message: WorkerResponsePayload<TEdgeReduce>) =>
        this.handleMessage(worker, message)
      );
      worker.on("error", (error) => this.handleWorkerError(worker, error));
      worker.on("exit", (code) => this.handleWorkerExit(worker, code));
    }
  }

  run(
    start: Feature<Point>,
    finish: Feature<Point>,
    searchOptions: PathFinderSearchOptions
  ): Promise<Path<TEdgeReduce> | undefined> {
    if (this.destroyed) {
      return Promise.reject(new Error("Worker pool has been terminated"));
    }

    return new Promise<Path<TEdgeReduce> | undefined>((resolve, reject) => {
      const id = this.nextTaskId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, start, finish, searchOptions });
      this.flush();
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const pendingErrors = new Error("Worker pool terminated");
    for (const [, task] of this.pending) {
      task.reject(pendingErrors);
    }
    this.pending.clear();
    this.queue.length = 0;

    await Promise.allSettled(this.workers.map((worker) => worker.terminate()));
  }

  private flush() {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.pop();
      if (!worker) {
        return;
      }
      const payload = this.queue.shift();
      if (!payload) {
        this.idleWorkers.push(worker);
        return;
      }
      this.activeTask.set(worker, payload.id);
      worker.postMessage(payload);
    }
  }

  private handleMessage(
    worker: Worker,
    message: WorkerResponsePayload<TEdgeReduce>
  ) {
    const pendingTask = this.pending.get(message.id);
    if (!pendingTask) {
      return;
    }
    this.pending.delete(message.id);
    this.activeTask.delete(worker);
    if (message.error) {
      const error = new Error(message.error.message);
      error.stack = message.error.stack;
      pendingTask.reject(error);
    } else {
      pendingTask.resolve(message.result);
    }
    if (!this.destroyed) {
      this.idleWorkers.push(worker);
      this.flush();
    }
  }

  private handleWorkerError(worker: Worker, error: Error) {
    this.failActiveTask(worker, error);
    this.removeWorker(worker);
  }

  private handleWorkerExit(worker: Worker, code: number) {
    if (code !== 0) {
      this.failActiveTask(
        worker,
        new Error(`Worker exited with code ${code}`)
      );
    }
    this.removeWorker(worker);
  }

  private failActiveTask(worker: Worker, error: Error) {
    const taskId = this.activeTask.get(worker);
    if (taskId === undefined) {
      return;
    }
    this.activeTask.delete(worker);
    const pendingTask = this.pending.get(taskId);
    if (!pendingTask) {
      return;
    }
    this.pending.delete(taskId);
    pendingTask.reject(error);
  }

  private removeWorker(worker: Worker) {
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex >= 0) {
      this.workers.splice(workerIndex, 1);
    }
  }
}
