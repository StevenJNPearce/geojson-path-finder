import { parentPort, workerData } from "worker_threads";
import type { GeoJsonProperties } from "geojson";
import PathFinder from "..";
import type {
  WorkerInitData,
  WorkerRequest,
  WorkerResponse,
} from "../worker-pool";

const data = workerData as WorkerInitData<unknown>;

const pathFinder = new PathFinder<unknown, GeoJsonProperties>(
  data.graph,
  {},
  {
    hasEdgeDataReducer: data.hasEdgeDataReducer,
    disableWorkerPool: true,
  }
);

const port = parentPort;
if (!port) {
  throw new Error("Worker threads require a parent port.");
}

port.on("message", (message: WorkerRequest<unknown>) => {
  try {
    const result = pathFinder.findPathFromVertexKeys(
      message.start,
      message.finish,
      message.searchOptions
    );
    const response: WorkerResponse<unknown> = {
      id: message.id,
      path: result,
    };
    port.postMessage(response);
  } catch (error) {
    const err =
      error instanceof Error ? error : new Error(String(error ?? "Unknown error"));
    const response: WorkerResponse<unknown> = {
      id: message.id,
      error: { message: err.message, stack: err.stack },
    };
    port.postMessage(response);
  }
});
