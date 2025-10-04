import { lineString } from "@turf/helpers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Position,
} from "geojson";
import { compactNode } from "./compactor";
import findPathDijkstra from "./dijkstra";
import findPathAStar from "./a-star";
import preprocess from "./preprocessor";
import roundCoord from "./round-coord";
import { defaultKey } from "./topology";
import {
  Key,
  Path,
  PathFinderGraph,
  PathFinderOptions,
  PathFinderSearchOptions,
} from "./types";
import PathFinderWorkerPool from "./threading/worker-pool";
import type {
  ThreadSafePathFinderOptions,
  WorkerInitData,
} from "./threading/worker-types";

export default class PathFinder<
  TEdgeReduce,
  TProperties extends GeoJsonProperties
> {
  graph: PathFinderGraph<TEdgeReduce>;
  options: PathFinderOptions<TEdgeReduce, TProperties>;
  private readonly concurrency: number;
  private readonly threadSafeOptions?: ThreadSafePathFinderOptions;
  private workerPoolPromise?: Promise<
    PathFinderWorkerPool<TEdgeReduce> | undefined
  >;
  private workerScriptPath?: string;

  constructor(
    network: FeatureCollection<LineString, TProperties>,
    options?: PathFinderOptions<TEdgeReduce, TProperties>
  );
  constructor(
    graph: PathFinderGraph<TEdgeReduce>,
    options: PathFinderOptions<TEdgeReduce, TProperties>,
    settings: { preprocessed: true }
  );
  constructor(
    networkOrGraph:
      | FeatureCollection<LineString, TProperties>
      | PathFinderGraph<TEdgeReduce>,
    options: PathFinderOptions<TEdgeReduce, TProperties> = {},
    settings?: { preprocessed?: boolean }
  ) {
    this.options = options;
    this.graph = settings?.preprocessed
      ? (networkOrGraph as PathFinderGraph<TEdgeReduce>)
      : preprocess(
          networkOrGraph as FeatureCollection<LineString, TProperties>,
          options
        );
    this.concurrency = this._normaliseConcurrency(options.concurrency);
    this.threadSafeOptions = this._createThreadSafeOptions(options);

    // if (
    //   Object.keys(this.graph.compactedVertices).filter(function (k) {
    //     return k !== "edgeData";
    //   }).length === 0
    // ) {
    //   throw new Error(
    //     "Compacted graph contains no forks (topology has no intersections)."
    //   );
    // }
  }

  findPath(
    a: Feature<Point>,
    b: Feature<Point>,
    searchOptions: PathFinderSearchOptions = {}
  ): Path<TEdgeReduce> | undefined {
    const { key = defaultKey, tolerance = 1e-5 } = this.options;
    const startCoordinates = roundCoord(a.geometry.coordinates, tolerance);
    const finishCoordinates = roundCoord(b.geometry.coordinates, tolerance);
    const start = this._resolveVertexKey(startCoordinates, key, tolerance);
    const finish = this._resolveVertexKey(finishCoordinates, key, tolerance);

    // We can't find a path if start or finish isn't in the
    // set of non-compacted vertices
    if (!this.graph.vertices[start] || !this.graph.vertices[finish]) {
      return undefined;
    }

    const phantomStart = this._createPhantom(start);
    const phantomEnd = this._createPhantom(finish);
    try {
      const goalCoordinate = this.graph.sourceCoordinates[finish];
      const directionBias =
        searchOptions.directionBias && goalCoordinate
          ? ({ cost, from, to, path }: {
              cost: number;
              from: Key;
              to: Key;
              path: Key[];
            }) => {
              const fromCoordinate = this.graph.sourceCoordinates[from];
              const toCoordinate =
                this.graph.sourceCoordinates[to] ??
                this._resolveCompactedCoordinate(from, to);

              if (!fromCoordinate || !toCoordinate) {
                return 0;
              }

              const fromToVector = ([
                toCoordinate[0] - fromCoordinate[0],
                toCoordinate[1] - fromCoordinate[1],
              ] as [number, number]);
              const fromGoalVector = ([
                goalCoordinate[0] - fromCoordinate[0],
                goalCoordinate[1] - fromCoordinate[1],
              ] as [number, number]);
              const toGoalVector = ([
                goalCoordinate[0] - toCoordinate[0],
                goalCoordinate[1] - toCoordinate[1],
              ] as [number, number]);

              return searchOptions.directionBias!({
                cost,
                from: fromCoordinate,
                to: toCoordinate,
                goal: goalCoordinate,
                fromToVector,
                fromGoalVector,
                toGoalVector,
                path,
              });
            }
          : undefined;
      const sharedOptions = {
        isTurnAllowed: ({ path, from, to }: { path: Key[]; from: Key; to: Key }) =>
          this._isTurnObtuse(path, from, to),
        ...(directionBias ? { directionBias } : {}),
        ...(searchOptions.onNodeExpanded
          ? { onNodeExpanded: searchOptions.onNodeExpanded }
          : {}),
      };

      const pathResult =
        searchOptions.algorithm === "astar"
          ? findPathAStar(this.graph.compactedVertices, start, finish, {
              ...sharedOptions,
              coordinates: this.graph.sourceCoordinates,
            })
          : findPathDijkstra(
              this.graph.compactedVertices,
              start,
              finish,
              sharedOptions
            );

      if (pathResult) {
        const [weight, path] = pathResult;
        return {
          path: path
            .reduce(
              (
                coordinates: Position[],
                vertexKey: Key,
                index: number,
                vertexKeys: Key[]
              ) => {
                if (index > 0) {
                  coordinates = coordinates.concat(
                    this.graph.compactedCoordinates[vertexKeys[index - 1]][
                      vertexKey
                    ]
                  );
                }

                return coordinates;
              },
              []
            )
            .concat([this.graph.sourceCoordinates[finish]]),
          weight,
          edgeDatas:
            "edgeDataReducer" in this.options
              ? path.reduce(
                  (
                    edges: (TEdgeReduce | undefined)[],
                    vertexKey: Key,
                    index: number,
                    vertexKeys: Key[]
                  ) => {
                    if (index > 0) {
                      edges.push(
                        this.graph.compactedEdges[vertexKeys[index - 1]][
                          vertexKey
                        ]
                      );
                    }

                    return edges;
                  },
                  []
                )
              : undefined,
        };
      } else {
        return undefined;
      }
    } finally {
      this._removePhantom(phantomStart);
      this._removePhantom(phantomEnd);
    }
  }

  async findPathAsync(
    a: Feature<Point>,
    b: Feature<Point>,
    searchOptions: PathFinderSearchOptions = {}
  ): Promise<Path<TEdgeReduce> | undefined> {
    if (!this._shouldUseWorker(searchOptions)) {
      return Promise.resolve(this.findPath(a, b, searchOptions));
    }

    const workerPool = await this._ensureWorkerPool();
    if (!workerPool) {
      return this.findPath(a, b, searchOptions);
    }

    return workerPool.run(a, b, searchOptions);
  }

  async close(): Promise<void> {
    if (!this.workerPoolPromise) {
      return;
    }

    const workerPool = await this.workerPoolPromise;
    this.workerPoolPromise = undefined;
    if (workerPool) {
      await workerPool.destroy();
    }
  }

  private _normaliseConcurrency(concurrency?: number): number {
    if (!concurrency || !Number.isFinite(concurrency) || concurrency < 2) {
      return 1;
    }
    return Math.max(1, Math.floor(concurrency));
  }

  private _createThreadSafeOptions(
    options: PathFinderOptions<TEdgeReduce, TProperties>
  ): ThreadSafePathFinderOptions | undefined {
    if (options.key) {
      return undefined;
    }
    if ("edgeDataReducer" in options) {
      return undefined;
    }

    const safeOptions: ThreadSafePathFinderOptions = {};
    if (options.tolerance !== undefined) {
      safeOptions.tolerance = options.tolerance;
    }

    return safeOptions;
  }

  private _shouldUseWorker(searchOptions: PathFinderSearchOptions) {
    if (this.concurrency <= 1 || !this.threadSafeOptions) {
      return false;
    }
    return !this._searchOptionsContainCallbacks(searchOptions);
  }

  private _searchOptionsContainCallbacks(
    searchOptions: PathFinderSearchOptions
  ): boolean {
    return (
      typeof searchOptions.directionBias === "function" ||
      typeof searchOptions.onNodeExpanded === "function"
    );
  }

  private _ensureWorkerPool() {
    if (!this.workerPoolPromise) {
      this.workerPoolPromise = this._createWorkerPool();
    }
    return this.workerPoolPromise;
  }

  private async _createWorkerPool(): Promise<
    PathFinderWorkerPool<TEdgeReduce> | undefined
  > {
    if (this.concurrency <= 1 || !this.threadSafeOptions) {
      return undefined;
    }

    let workerThreads: typeof import("node:worker_threads");
    try {
      const dynamicImport = Function(
        "specifier",
        "return import(specifier);"
      ) as (specifier: string) => Promise<
        typeof import("node:worker_threads")
      >;
      workerThreads = await dynamicImport("node:worker_threads");
    } catch (error) {
      return undefined;
    }

    if (!workerThreads.isMainThread) {
      return undefined;
    }

    const initData: WorkerInitData<TEdgeReduce> = {
      graph: this.graph,
      options: this.threadSafeOptions,
    };

    const scriptPath = this._resolveWorkerScriptPath();
    return new PathFinderWorkerPool<TEdgeReduce>(
      workerThreads.Worker,
      scriptPath,
      initData,
      this.concurrency
    );
  }

  private _resolveWorkerScriptPath(): string {
    if (!this.workerScriptPath) {
      if (typeof __dirname !== "undefined") {
        this.workerScriptPath = path.resolve(
          __dirname,
          "threading",
          "find-path.worker.js"
        );
      } else {
        const importMetaUrl = Function(
          "return import.meta.url;"
        )() as string;
        const workerUrl = new URL(
          "./threading/find-path.worker.js",
          importMetaUrl
        );
        this.workerScriptPath = fileURLToPath(workerUrl);
      }
    }
    return this.workerScriptPath;
  }

  private _resolveCompactedCoordinate(from: Key, to: Key) {
    const coordinates = this.graph.compactedCoordinates[from]?.[to];
    if (!coordinates || coordinates.length === 0) {
      return undefined;
    }
    return coordinates[coordinates.length - 1];
  }

  private _isTurnObtuse(path: Key[], from: Key, to: Key): boolean {
    const prevKey = path.length > 1 ? path[path.length - 2] : undefined;
    const prevPrevKey = path.length > 2 ? path[path.length - 3] : undefined;

    const currentCoordinate = this._getCoordinateForKey(from, prevKey);
    const nextCoordinate = this._getCoordinateForKey(to, from);

    if (!currentCoordinate || !nextCoordinate) {
      return false;
    }

    const intermediateCoordinates =
      this.graph.compactedCoordinates[from]?.[to] ?? [];

    const forwardCoordinates = [currentCoordinate];

    for (const coordinate of intermediateCoordinates) {
      if (
        coordinate &&
        !this._coordinatesEqual(
          coordinate,
          forwardCoordinates[forwardCoordinates.length - 1]
        )
      ) {
        forwardCoordinates.push(coordinate);
      }
    }

    if (
      !this._coordinatesEqual(
        nextCoordinate,
        forwardCoordinates[forwardCoordinates.length - 1]
      )
    ) {
      forwardCoordinates.push(nextCoordinate);
    }

    if (forwardCoordinates.length < 2) {
      return true;
    }

    if (prevKey) {
      const prevCoordinate = this._getCoordinateForKey(prevKey, prevPrevKey);
      if (!prevCoordinate) {
        return false;
      }

      if (
        !this._isAngleObtuse(
          prevCoordinate,
          forwardCoordinates[0],
          forwardCoordinates[1]
        )
      ) {
        return false;
      }
    }

    for (let i = 1; i < forwardCoordinates.length - 1; i++) {
      const before = forwardCoordinates[i - 1];
      const middle = forwardCoordinates[i];
      const after = forwardCoordinates[i + 1];
      if (!this._isAngleObtuse(before, middle, after)) {
        return false;
      }
    }

    return true;
  }

  private _getCoordinateForKey(key: Key, previousKey?: Key) {
    const directCoordinate = this.graph.sourceCoordinates[key];
    if (directCoordinate) {
      return directCoordinate;
    }

    if (!previousKey) {
      return undefined;
    }

    return this._resolveCompactedCoordinate(previousKey, key);
  }

  private _isAngleObtuse(
    before: Position,
    middle: Position,
    after: Position
  ): boolean {
    const vectorToBefore: [number, number] = [
      before[0] - middle[0],
      before[1] - middle[1],
    ];
    const vectorToAfter: [number, number] = [
      after[0] - middle[0],
      after[1] - middle[1],
    ];

    const lengthToBefore = Math.hypot(vectorToBefore[0], vectorToBefore[1]);
    const lengthToAfter = Math.hypot(vectorToAfter[0], vectorToAfter[1]);

    if (lengthToBefore === 0 || lengthToAfter === 0) {
      return true;
    }

    const dotProduct =
      vectorToBefore[0] * vectorToAfter[0] +
      vectorToBefore[1] * vectorToAfter[1];

    return dotProduct < 0;
  }

  private _coordinatesEqual(a: Position, b: Position) {
    const tolerance = this.options.tolerance ?? 1e-5;
    return (
      Math.abs(a[0] - b[0]) <= tolerance &&
      Math.abs(a[1] - b[1]) <= tolerance
    );
  }

  private _resolveVertexKey(
    coordinate: Position,
    keyFn: (coordinates: Position) => Key,
    tolerance: number
  ): Key {
    const directKey = keyFn(coordinate);
    if (this.graph.vertices[directKey]) {
      return directKey;
    }

    const matches: Key[] = [];
    for (const [vertexKey, sourceCoordinate] of Object.entries(
      this.graph.sourceCoordinates
    )) {
      const roundedSource = roundCoord(sourceCoordinate, tolerance);
      if (
        roundedSource[0] === coordinate[0] &&
        roundedSource[1] === coordinate[1]
      ) {
        matches.push(vertexKey);
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous vertex coordinate: ${JSON.stringify(coordinate)}. ` +
          `Matches multiple vertices (${matches.join(", ")}).`
      );
    }

    return directKey;
  }

  _createPhantom(n: Key) {
    if (this.graph.compactedVertices[n]) return undefined;

    const phantom = compactNode(
      n,
      this.graph.vertices,
      this.graph.compactedVertices,
      this.graph.sourceCoordinates,
      this.graph.edgeData,
      true,
      this.options
    );
    this.graph.compactedVertices[n] = phantom.edges;
    this.graph.compactedCoordinates[n] = phantom.coordinates;

    if ("edgeDataReducer" in this.options) {
      this.graph.compactedEdges[n] = phantom.reducedEdges;
    }

    Object.keys(phantom.incomingEdges).forEach((neighbor) => {
      this.graph.compactedVertices[neighbor][n] =
        phantom.incomingEdges[neighbor];
      if (!this.graph.compactedCoordinates[neighbor]) {
        this.graph.compactedCoordinates[neighbor] = {};
      }
      this.graph.compactedCoordinates[neighbor][n] = [
        this.graph.sourceCoordinates[neighbor],
        ...phantom.incomingCoordinates[neighbor].slice(0, -1),
      ];
      if (this.graph.compactedEdges) {
        if (!this.graph.compactedEdges[neighbor]) {
          this.graph.compactedEdges[neighbor] = {};
        }
        this.graph.compactedEdges[neighbor][n] = phantom.reducedEdges[neighbor];
      }
    });

    return n;
  }

  _removePhantom(n: Key | undefined) {
    if (!n) return;

    Object.keys(this.graph.compactedVertices[n]).forEach((neighbor) => {
      delete this.graph.compactedVertices[neighbor][n];
    });
    Object.keys(this.graph.compactedCoordinates[n]).forEach((neighbor) => {
      delete this.graph.compactedCoordinates[neighbor][n];
    });
    if ("edgeDataReducer" in this.options) {
      Object.keys(this.graph.compactedEdges[n]).forEach((neighbor) => {
        delete this.graph.compactedEdges[neighbor][n];
      });
    }

    delete this.graph.compactedVertices[n];
    delete this.graph.compactedCoordinates[n];

    if (this.graph.compactedEdges) {
      delete this.graph.compactedEdges[n];
    }
  }
}

export function pathToGeoJSON<TEdgeReduce>(
  path: Path<TEdgeReduce> | undefined
):
  | Feature<
      LineString,
      { weight: number; edgeDatas: (TEdgeReduce | undefined)[] | undefined }
    >
  | undefined {
  if (path) {
    const { weight, edgeDatas } = path;
    return lineString(path.path, { weight, edgeDatas });
  }
}
