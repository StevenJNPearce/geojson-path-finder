import type { Feature, Point } from "geojson";
import type { Path, PathFinderGraph, PathFinderSearchOptions } from "../types";

export type ThreadSafePathFinderOptions = {
  tolerance?: number;
};

export type WorkerInitData<TEdgeReduce> = {
  graph: PathFinderGraph<TEdgeReduce>;
  options: ThreadSafePathFinderOptions;
};

export type WorkerRequestPayload<TEdgeReduce> = {
  id: number;
  start: Feature<Point>;
  finish: Feature<Point>;
  searchOptions: PathFinderSearchOptions;
};

export type WorkerResponsePayload<TEdgeReduce> = {
  id: number;
  result?: Path<TEdgeReduce> | undefined;
  error?: {
    message: string;
    stack?: string;
  };
};
