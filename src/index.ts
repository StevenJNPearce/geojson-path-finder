import { lineString } from "@turf/helpers";
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
import type PathFinderWorkerPool from "./worker-pool";
import type { WorkerSearchOptions } from "./worker-pool";
import {
  DirectionBiasContext,
  Key,
  Path,
  PathFinderGraph,
  PathFinderOptions,
  PathFinderSearchOptions,
  PathFinderWorkerOptions,
} from "./types";

type PathFinderInternalOptions = {
  hasEdgeDataReducer?: boolean;
  disableWorkerPool?: boolean;
};

let workerPoolModulePromise:
  | Promise<typeof import("./worker-pool") | undefined>
  | undefined;

function loadWorkerPoolModule() {
  if (!workerPoolModulePromise) {
    workerPoolModulePromise = new Promise((resolve) => {
      const requireFn: undefined | ((id: string) => unknown) =
        typeof require === "function"
          ? require
          : Function(
              "return typeof require !== 'undefined' ? require : undefined;"
            )();
      if (typeof requireFn !== "function") {
        resolve(undefined);
        return;
      }

      const pathModule = requireFn("path") as typeof import("path");
      const fsModule = requireFn("fs") as typeof import("fs");
      const moduleDir =
        Function(
          "return typeof __dirname !== 'undefined' ? __dirname : undefined;"
        )() || process.cwd();
      const candidates = [
        pathModule.resolve(moduleDir, "worker-pool.js"),
        pathModule.resolve(moduleDir, "worker-pool.ts"),
        pathModule.resolve(moduleDir, "../dist/cjs/worker-pool.js"),
        pathModule.resolve(moduleDir, "../dist/esm/worker-pool.js"),
      ];

      for (const candidate of candidates) {
        if (fsModule.existsSync(candidate)) {
          resolve(requireFn(candidate) as typeof import("./worker-pool"));
          return;
        }
      }

      resolve(undefined);
    });
  }

  return workerPoolModulePromise;
}

export default class PathFinder<
  TEdgeReduce,
  TProperties extends GeoJsonProperties
> {
  graph: PathFinderGraph<TEdgeReduce>;
  options: PathFinderOptions<TEdgeReduce, TProperties>;
  private readonly hasEdgeDataReducer: boolean;
  private readonly workerOptions?: PathFinderWorkerOptions;
  private workerPool?: PathFinderWorkerPool<TEdgeReduce> | null;

  constructor(
    network: FeatureCollection<LineString, TProperties>,
    options?: PathFinderOptions<TEdgeReduce, TProperties>
  );
  constructor(
    graph: PathFinderGraph<TEdgeReduce>,
    options?: PathFinderOptions<TEdgeReduce, TProperties>,
    internal?: PathFinderInternalOptions
  );
  constructor(
    networkOrGraph:
      | FeatureCollection<LineString, TProperties>
      | PathFinderGraph<TEdgeReduce>,
    options: PathFinderOptions<TEdgeReduce, TProperties> = {},
    internal: PathFinderInternalOptions = {}
  ) {
    if (isPathFinderGraph<TEdgeReduce>(networkOrGraph)) {
      this.graph = networkOrGraph;
    } else {
      this.graph = preprocess(networkOrGraph, options);
    }
    this.options = options;
    this.hasEdgeDataReducer =
      internal.hasEdgeDataReducer ?? "edgeDataReducer" in options;
    this.workerOptions = options.worker;
    this.workerPool = internal.disableWorkerPool ? null : undefined;

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
    const start = this._resolveVertexKey(
      roundCoord(a.geometry.coordinates, tolerance),
      key,
      tolerance
    );
    const finish = this._resolveVertexKey(
      roundCoord(b.geometry.coordinates, tolerance),
      key,
      tolerance
    );

    // We can't find a path if start or finish isn't in the
    // set of non-compacted vertices
    if (!this.graph.vertices[start] || !this.graph.vertices[finish]) {
      return undefined;
    }

    return this.findPathFromVertexKeys(start, finish, searchOptions);
  }

  findPathFromVertexKeys(
    start: Key,
    finish: Key,
    searchOptions: PathFinderSearchOptions = {}
  ): Path<TEdgeReduce> | undefined {
    if (!this.graph.vertices[start] || !this.graph.vertices[finish]) {
      return undefined;
    }

    const phantomStart = this._createPhantom(start);
    const phantomEnd = this._createPhantom(finish);
    try {
      const goalCoordinate = this.graph.sourceCoordinates[finish];
      const buildTraversalContext = ({
        cost,
        from,
        to,
        path,
      }: {
        cost: number;
        from: Key;
        to: Key;
        path: Key[];
      }) => {
        const previousKey = path.length > 1 ? path[path.length - 2] : undefined;
        const fromCoordinate =
          this.graph.sourceCoordinates[from] ??
          (previousKey !== undefined
            ? this._resolveCompactedCoordinate(previousKey, from)
            : undefined);
        const toCoordinate =
          this.graph.sourceCoordinates[to] ??
          this._resolveCompactedCoordinate(from, to);

        if (!fromCoordinate || !toCoordinate || !goalCoordinate) {
          return undefined;
        }

        const fromToVector = [
          toCoordinate[0] - fromCoordinate[0],
          toCoordinate[1] - fromCoordinate[1],
        ] as [number, number];
        const fromGoalVector = [
          goalCoordinate[0] - fromCoordinate[0],
          goalCoordinate[1] - fromCoordinate[1],
        ] as [number, number];
        const toGoalVector = [
          goalCoordinate[0] - toCoordinate[0],
          goalCoordinate[1] - toCoordinate[1],
        ] as [number, number];

        const context: DirectionBiasContext = {
          cost,
          from: fromCoordinate,
          to: toCoordinate,
          goal: goalCoordinate,
          fromToVector,
          fromGoalVector,
          toGoalVector,
          path,
        };

        if (previousKey !== undefined) {
          const previousCoordinate =
            this.graph.sourceCoordinates[previousKey] ??
            this._resolveCompactedCoordinate(previousKey, from);

          if (previousCoordinate) {
            context.previous = previousCoordinate;
            context.previousToFromVector = [
              fromCoordinate[0] - previousCoordinate[0],
              fromCoordinate[1] - previousCoordinate[1],
            ] as [number, number];
          }
        }

        return context;
      };

      const directionBias =
        searchOptions.directionBias && goalCoordinate
          ? ({ cost, from, to, path }: {
              cost: number;
              from: Key;
              to: Key;
              path: Key[];
            }) => {
              const context = buildTraversalContext({ cost, from, to, path });
              if (!context) {
                return 0;
              }
              return searchOptions.directionBias!(context);
            }
          : undefined;
      const transitionGuard =
        searchOptions.transitionGuard && goalCoordinate
          ? ({ cost, from, to, path }: {
              cost: number;
              from: Key;
              to: Key;
              path: Key[];
            }) => {
              const context = buildTraversalContext({ cost, from, to, path });
              if (!context) {
                return true;
              }

              const result = searchOptions.transitionGuard!(context);
              return result !== false;
            }
          : undefined;
      const sharedOptions = {
        ...(directionBias ? { directionBias } : {}),
        ...(transitionGuard ? { transitionGuard } : {}),
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
          edgeDatas: this.hasEdgeDataReducer
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
    const pool = await this._ensureWorkerPool();
    if (!pool || this._hasWorkerSearchCallbacks(searchOptions)) {
      return this.findPath(a, b, searchOptions);
    }

    const { key = defaultKey, tolerance = 1e-5 } = this.options;
    const start = this._resolveVertexKey(
      roundCoord(a.geometry.coordinates, tolerance),
      key,
      tolerance
    );
    const finish = this._resolveVertexKey(
      roundCoord(b.geometry.coordinates, tolerance),
      key,
      tolerance
    );

    if (!this.graph.vertices[start] || !this.graph.vertices[finish]) {
      return undefined;
    }

    return pool.schedule(start, finish, this._toWorkerSearchOptions(searchOptions));
  }

  async close() {
    if (this.workerPool && this.workerPool !== null) {
      await this.workerPool.close();
      this.workerPool = undefined;
    }
  }

  private _hasWorkerSearchCallbacks(options: PathFinderSearchOptions) {
    return Boolean(
      options.directionBias ||
        options.transitionGuard ||
        options.onNodeExpanded
    );
  }

  private _toWorkerSearchOptions(
    options: PathFinderSearchOptions
  ): WorkerSearchOptions {
    const workerOptions: WorkerSearchOptions = {};
    if (options.algorithm) {
      workerOptions.algorithm = options.algorithm;
    }
    return workerOptions;
  }

  private async _ensureWorkerPool(): Promise<
    PathFinderWorkerPool<TEdgeReduce> | undefined
  > {
    if (this.workerPool === null) {
      return undefined;
    }

    if (!this.workerOptions?.enabled || this.hasEdgeDataReducer) {
      this.workerPool = null;
      return undefined;
    }

    if (this.workerPool) {
      return this.workerPool;
    }

    const module = await loadWorkerPoolModule();
    if (!module) {
      this.workerPool = null;
      return undefined;
    }
    if (!module.isWorkerThreadsAvailable()) {
      this.workerPool = null;
      return undefined;
    }

    const pool = new module.default<TEdgeReduce>({
      graph: this.graph,
      hasEdgeDataReducer: this.hasEdgeDataReducer,
      options: this.workerOptions,
    });
    this.workerPool = pool;
    return pool;
  }

  private _resolveCompactedCoordinate(from: Key, to: Key) {
    const coordinates = this.graph.compactedCoordinates[from]?.[to];
    if (!coordinates || coordinates.length === 0) {
      return undefined;
    }
    return coordinates[coordinates.length - 1];
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

    if (this.hasEdgeDataReducer) {
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
    if (this.hasEdgeDataReducer) {
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

function isPathFinderGraph<TEdgeReduce>(
  value:
    | FeatureCollection<LineString, GeoJsonProperties>
    | PathFinderGraph<TEdgeReduce>
): value is PathFinderGraph<TEdgeReduce> {
  return (
    value !== null &&
    typeof value === "object" &&
    "vertices" in value &&
    "edgeData" in value &&
    "sourceCoordinates" in value &&
    "compactedVertices" in value
  );
}
