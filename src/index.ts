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
import {
  Key,
  Path,
  PathFinderGraph,
  PathFinderOptions,
  PathFinderSearchOptions,
} from "./types";

export default class PathFinder<
  TEdgeReduce,
  TProperties extends GeoJsonProperties
> {
  graph: PathFinderGraph<TEdgeReduce>;
  options: PathFinderOptions<TEdgeReduce, TProperties>;

  constructor(
    network: FeatureCollection<LineString, TProperties>,
    options: PathFinderOptions<TEdgeReduce, TProperties> = {}
  ) {
    this.graph = preprocess(network, options);
    this.options = options;

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
