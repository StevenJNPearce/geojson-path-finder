import { parentPort, workerData } from "node:worker_threads";
import PathFinder from "../index";
import type { PathFinderSearchOptions } from "../types";
import type {
  WorkerInitData,
  WorkerRequestPayload,
  WorkerResponsePayload,
} from "./worker-types";

const initData = workerData as WorkerInitData<unknown> | undefined;
const port = parentPort;

if (!port || !initData) {
  throw new Error("PathFinder worker initialisation failed");
}

const pathFinder = new PathFinder(
  initData.graph,
  {
    tolerance: initData.options.tolerance,
  },
  { preprocessed: true }
);

port.on("message", (message: WorkerRequestPayload<unknown>) => {
  const response: WorkerResponsePayload<unknown> = { id: message.id };
  try {
    response.result = pathFinder.findPath(
      message.start,
      message.finish,
      message.searchOptions as PathFinderSearchOptions
    );
  } catch (error) {
    if (error instanceof Error) {
      response.error = {
        message: error.message,
        stack: error.stack,
      };
    } else {
      response.error = {
        message: String(error),
      };
    }
  }
  port.postMessage(response);
});
