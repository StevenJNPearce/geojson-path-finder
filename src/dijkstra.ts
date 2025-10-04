import Queue from "tinyqueue";
import { Key, Vertices } from "./types";

type State = [number, Key[], Key];

type DirectionBiasEvaluator = (input: {
  cost: number;
  from: Key;
  to: Key;
  path: Key[];
}) => number;

type TurnEvaluator = (input: { path: Key[]; from: Key; to: Key }) => boolean;

type Options = {
  directionBias?: DirectionBiasEvaluator;
  isTurnAllowed?: TurnEvaluator;
  onNodeExpanded?: (context: { key: Key; cost: number }) => void;
};

export default function findPath(
  graph: Vertices,
  start: Key,
  end: Key,
  options: Options = {}
): [number, Key[]] | undefined {
  const costs: Record<Key, number> = { [start]: 0 };
  const initialState: State = [0, [start], start];
  const queue = new Queue([initialState], (a: State, b: State) => a[0] - b[0]);

  while (true) {
    const state = queue.pop();
    if (!state) {
      return undefined;
    }

    const cost = state[0];
    const node = state[2];

    options.onNodeExpanded?.({ key: node, cost });
    if (node === end) {
      return [state[0], state[1]];
    }

    const neighbours = graph[node];
    Object.keys(neighbours).forEach(function (n) {
      if (
        options.isTurnAllowed &&
        !options.isTurnAllowed({ path: state[1], from: node, to: n })
      ) {
        return;
      }
      const bias = options.directionBias
        ? options.directionBias({
            cost,
            from: node,
            to: n,
            path: state[1],
          })
        : 0;
      var newCost = cost + neighbours[n] + bias;
      if (newCost < Infinity && (!(n in costs) || newCost < costs[n])) {
        costs[n] = newCost;
        const newState: State = [newCost, state[1].concat([n]), n];
        queue.push(newState);
      }
    });
  }
}
