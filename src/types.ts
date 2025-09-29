import { Position } from "geojson";

/**
 * Vertex key, a unique identifier for a vertex of a graph
 */
export type Key = string;

/**
 * Edge from A to B, containing its vertex keys and associated properties
 */
export type Edge<TProperties> = [Key, Key, TProperties];

/**
 * A topology of coordinates and their connecting edges
 */
export type Topology<TProperties> = {
  vertices: Coordinates;
  edges: Edge<TProperties>[];
};

/**
 * A graph vertex, containing the edges
 * connecting it to other vertices;
 * edges are described as a lookup withthe target vertex's
 * key associated to the edge's weight
 */
export type Vertex = Record<Key, number>;

/**
 * A set of vertices, indexed by their keys.
 */
export type Vertices = Record<Key, Vertex>;

/**
 *
 */
export type Coordinates = Record<Key, Position>;

export type DirectionBiasContext = {
  /** Coordinate of the vertex being expanded. */
  from: Position;
  /** Coordinate of the neighbouring vertex being evaluated. */
  to: Position;
  /** Coordinate of the destination vertex. */
  goal: Position;
  /** Vector from the current vertex towards the neighbour. */
  fromToVector: [number, number];
  /** Vector from the current vertex towards the goal. */
  fromGoalVector: [number, number];
  /** Vector from the neighbour towards the goal. */
  toGoalVector: [number, number];
  /** Coordinate of the previous vertex on the path, when available. */
  previous?: Position;
  /** Vector from the previous vertex towards the current vertex, when available. */
  previousToFromVector?: [number, number];
  /**
   * The path (as vertex keys) that has been traversed so far, ending at the
   * current vertex.
   */
  path: Key[];
  /** The accumulated weight for the current vertex before evaluating the edge. */
  cost: number;
};

export type TransitionGuardContext = DirectionBiasContext;

export type PathFinderSearchOptions = {
  /**
   * Optional callback used to influence the traversal cost of each edge based
   * on how well it aligns with the direction of the goal. Returning a positive
   * number penalises the edge, while a negative number rewards it.
   */
  directionBias?: (context: DirectionBiasContext) => number;
  /**
   * Optional callback used to veto a candidate transition entirely. Returning
   * `false` prevents the neighbour from being explored, while throwing aborts
   * the search.
   */
  transitionGuard?: (context: TransitionGuardContext) => boolean | void;
  /**
   * Selects which search algorithm should be used. Defaults to Dijkstra.
   */
  algorithm?: "dijkstra" | "astar";
  /**
   * Optional callback invoked when a vertex is expanded during the search.
   */
  onNodeExpanded?: (context: { key: Key; cost: number }) => void;
};

export type PathFinderGraph<TEdgeData> = {
  vertices: Vertices;
  edgeData: Record<Key, Record<Key, TEdgeData | undefined>>;
  sourceCoordinates: Coordinates;
  compactedVertices: Vertices;
  compactedCoordinates: Record<Key, Record<Key, Position[]>>;
  compactedEdges: Record<Key, Record<Key, TEdgeData | undefined>>;
};

export type PathFinderOptions<TEdgeReduce, TProperties> = {
  tolerance?: number;
  key?: (coordinates: Position) => string;
  compact?: boolean;
  /**
   * Calculate weight for an edge from a node at position a to a node at position b
   * @param {Position} a coordinate of node A
   * @param {Position} b coordinate of node B
   * @param {Properties} properties the properties associated with the network's LineString from a to b
   * @returns the weight of the edge, zero indicates the edge is not passable
   */
  weight?: (
    a: Position,
    b: Position,
    properties: TProperties
  ) => number | { forward: number; backward: number } | undefined;
  progress?: (type: string, completed: number, total: number) => void;
} & (
  | {
      edgeDataReducer: (
        seed: TEdgeReduce,
        modifier: TEdgeReduce
      ) => TEdgeReduce;
      edgeDataSeed: (properties: TProperties) => TEdgeReduce;
    }
  | {}
);

export type Path<TEdgeReduce> = {
  path: Position[];
  weight: number;
  edgeDatas: (TEdgeReduce | undefined)[] | undefined;
};
