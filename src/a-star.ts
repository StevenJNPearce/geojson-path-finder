import Queue from "tinyqueue";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import { Coordinates, Key, Vertices } from "./types";

type State = {
  cost: number;
  estimate: number;
  path: Key[];
  node: Key;
};

type DirectionBiasEvaluator = (input: {
  cost: number;
  from: Key;
  to: Key;
  path: Key[];
}) => number;

type Options = {
  directionBias?: DirectionBiasEvaluator;
  coordinates?: Coordinates;
  onNodeExpanded?: (context: { key: Key; cost: number }) => void;
};

function heuristic(
  key: Key,
  goal: Key,
  coordinates: Coordinates | undefined
): number {
  if (!coordinates) return 0;

  const startCoordinate = coordinates[key];
  const goalCoordinate = coordinates[goal];
  if (!startCoordinate || !goalCoordinate) {
    return 0;
  }

  return distance(point(startCoordinate), point(goalCoordinate));
}

export default function findPath(
  graph: Vertices,
  start: Key,
  end: Key,
  options: Options = {}
): [number, Key[]] | undefined {
  const costs: Record<Key, number> = { [start]: 0 };
  const initialEstimate = heuristic(start, end, options.coordinates);
  const initialState: State = {
    cost: 0,
    estimate: initialEstimate,
    path: [start],
    node: start,
  };
  const queue = new Queue([initialState], (a: State, b: State) => a.estimate - b.estimate);

  while (true) {
    const state = queue.pop();
    if (!state) {
      return undefined;
    }

    const { cost, node } = state;

    if (cost > (costs[node] ?? Infinity)) {
      continue;
    }

    options.onNodeExpanded?.({ key: node, cost });

    if (node === end) {
      return [cost, state.path];
    }

    const neighbours = graph[node];
    Object.keys(neighbours).forEach(function (n) {
      const bias = options.directionBias
        ? options.directionBias({
            cost,
            from: node,
            to: n,
            path: state.path,
          })
        : 0;
      const newCost = cost + neighbours[n] + bias;
      if (newCost >= Infinity) {
        return;
      }
      if (!(n in costs) || newCost < costs[n]) {
        costs[n] = newCost;
        const estimate =
          newCost + heuristic(n, end, options.coordinates);
        queue.push({
          cost: newCost,
          estimate,
          path: state.path.concat([n]),
          node: n,
        });
      }
    });
  }
}
