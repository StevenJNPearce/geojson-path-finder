import { expect, test } from "vitest";

import PathFinder from "../src/index";
import geojson from "./network.json";
import geojson66 from "./66.json";
import largeNetwork from "./large-network.json";
import linestring3d from "./linestring-3d.json";
import { point } from "@turf/helpers";
import distance from "@turf/distance";
import osmWeight from "./osm-weight";

test("can create PathFinder", () => {
  const pathfinder = new PathFinder(geojson);
  expect(pathfinder).toBeTruthy();
});

test("can find path (simple)", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network);
  const path = pathfinder.findPath(point([0, 0]), point([1, 1]));

  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.path.length).toBe(3);
  expect(path.weight).toBeGreaterThan(0);
});

test("can find path (medium)", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [0, 1],
            [1, 1],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network),
    path = pathfinder.findPath(point([0, 0]), point([1, 1]));

  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.path.length).toBe(3);
  expect(path.weight).toBeGreaterThan(0);
});

test("can find path (complex)", () => {
  const pathfinder = new PathFinder(geojson),
    path = pathfinder.findPath(
      point([8.44460166, 59.48947469]),
      point([8.44651, 59.513920000000006])
    );

  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.weight).toBeGreaterThan(0);
  expect(path.path.length).toBe(220);
  expect(path.weight).toBeCloseTo(6.3751);
});

test("can handle network without forks", () => {
  const pathFinder = new PathFinder(require("./advent24.json"), {
    weight: function (a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      return Math.sqrt(dx * dx + dy * dy);
    },
  });
  const path = pathFinder.findPath(point([1, 1]), point([9, 1]));
  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.weight).toBe(8);
});

test("can handle multiple path searches in network without forks", () => {
  const pathFinder = new PathFinder(require("./advent24.json"), {
    weight: function (a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      return Math.sqrt(dx * dx + dy * dy);
    },
  });

  for (let i = 0; i < 2; i++) {
    pathFinder.findPath(point([1, 1]), point([9, 1]));
  }
});

// test("can handle island network", () => {
//   const pathFinder = new PathFinder(require("./islands.json"));
//   for (let i = 0; i < 2; i++) {
//   const path = pathFinder.findPath(point([12.7237479, 55.9095736]), point([12.6766066, 55.9092587]));
//   }
// })

test("does not remove vertices from result", (t) => {
  const pathfinder = new PathFinder(geojson66, {
      weight: (a, b) => {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
      },
      tolerance: 1,
    }),
    path = pathfinder.findPath(point([0, 0]), point([15, 12]));

  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.weight).toBeGreaterThan(0);
  expect(path.path.length).toBe(7);
  expect(path.weight).toBeCloseTo(21.9574);
});

test("direction bias favours moving toward the destination", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [5, 5],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [5, 5],
            [10, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [-1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [-1, 0],
            [10, 0],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network);
  const start = point([0, 0]);
  const finish = point([10, 0]);

  const unbiased = pathfinder.findPath(start, finish);
  expect(unbiased).toBeTruthy();
  expect(unbiased.path.some((coord) => coord[0] === -1 && coord[1] === 0)).toBe(
    true
  );

  const biased = pathfinder.findPath(start, finish, {
    directionBias({ fromToVector, fromGoalVector }) {
      const stepLength = Math.hypot(fromToVector[0], fromToVector[1]);
      const goalLength = Math.hypot(fromGoalVector[0], fromGoalVector[1]);
      if (stepLength === 0 || goalLength === 0) {
        return 0;
      }

      const alignment =
        (fromToVector[0] * fromGoalVector[0] +
          fromToVector[1] * fromGoalVector[1]) /
        (stepLength * goalLength);

      return alignment < 0 ? Math.abs(alignment) * 1000 : 0;
    },
  });

  expect(biased).toBeTruthy();
  expect(
    biased.path.some((coord) => coord[0] === -1 && coord[1] === 0)
  ).toBe(false);
  expect(unbiased.weight).toBeLessThan(biased.weight);
});

test("can find multiple paths concurrently using worker threads", async () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 1],
            [2, 1],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network, {
    worker: { enabled: true, poolSize: 2 },
  });

  const [pathA, pathB] = await Promise.all([
    pathfinder.findPathAsync(point([0, 0]), point([1, 1])),
    pathfinder.findPathAsync(point([1, 0]), point([2, 1])),
  ]);

  expect(pathA).toBeTruthy();
  expect(pathB).toBeTruthy();
  await pathfinder.close();
});

test("findPathAsync falls back to synchronous behaviour when callbacks are provided", async () => {
  const pathfinder = new PathFinder(geojson, {
    worker: { enabled: true, poolSize: 2 },
  });

  const result = await pathfinder.findPathAsync(
    point([8.44460166, 59.48947469]),
    point([8.44651, 59.513920000000006]),
    {
      directionBias: () => 0,
    }
  );

  expect(result).toBeTruthy();
  await pathfinder.close();
});

test("ESM build resolves worker pool for findPathAsync", async () => {
  const { default: ESMPathFinder } = await import("../dist/esm/index.js");
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [2, 0],
          ],
        },
      },
    ],
  };

  const pathfinder = new ESMPathFinder(network, {
    worker: { enabled: true, poolSize: 2 },
  });

  const [pathA, pathB] = await Promise.all([
    pathfinder.findPathAsync(point([0, 0]), point([1, 1])),
    pathfinder.findPathAsync(point([1, 0]), point([2, 0])),
  ]);

  expect(pathA).toBeTruthy();
  expect(pathB).toBeTruthy();
  expect(pathfinder.workerPool).toBeTruthy();
  await pathfinder.close();
});

test("transition guard blocks reversing moves", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [0, 1],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [2, 0],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network);
  const start = point([0, 0]);
  const finish = point([0, 1]);

  const allowed = pathfinder.findPath(start, finish);
  expect(allowed).toBeTruthy();
  expect(allowed?.path).toEqual([
    [0, 0],
    [1, 0],
    [0, 1],
  ]);

  let guardCalls = 0;
  let rejected = 0;
  const alignments = [];

  const blocked = pathfinder.findPath(start, finish, {
    transitionGuard({ previousToFromVector, fromToVector }) {
      guardCalls += 1;
      if (!previousToFromVector) {
        return true;
      }

      const prevLength = Math.hypot(
        previousToFromVector[0],
        previousToFromVector[1]
      );
      const stepLength = Math.hypot(fromToVector[0], fromToVector[1]);
      if (prevLength === 0 || stepLength === 0) {
        return true;
      }

      const alignment =
        (previousToFromVector[0] * fromToVector[0] +
          previousToFromVector[1] * fromToVector[1]) /
        (prevLength * stepLength);

      alignments.push(alignment);

      if (alignment < 0) {
        rejected += 1;
        return false;
      }

      return true;
    },
  });

  expect(blocked).toBeUndefined();
  expect(guardCalls).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
  expect(alignments.some((value) => value < 0)).toBe(true);
});

test("can make oneway network", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network, {
    weight: function (a, b) {
      return {
        forward: distance(point(a), point(b)),
      };
    },
  });
  const path1 = pathfinder.findPath(point([0, 0]), point([1, 1]));

  expect(path1).toBeTruthy();
  expect(path1.path).toBeTruthy();
  expect(path1.weight).toBeGreaterThan(0);

  const path2 = pathfinder.findPath(point([1, 1]), point([0, 0]));
  expect(path2).toBeUndefined();
});

test("can reduce data on edges", () => {
  const pathfinder = new PathFinder(geojson, {
      edgeDataReducer: function (a, p) {
        return { id: p.id };
      },
      edgeDataSeed: () => -1,
    }),
    path = pathfinder.findPath(
      point([8.44460166, 59.48947469]),
      point([8.44651, 59.513920000000006])
    );

  expect(path).toBeTruthy();
  expect(path.edgeDatas).toBeTruthy();
  expect(
    path.edgeDatas.every(function (e) {
      return e;
    })
  ).toBeTruthy();
});

function edgeReduce(a, p) {
  const a_arr = a.id;
  p.id.forEach(function (id) {
    a_arr.push(id);
  });
  return { id: Array.from(new Set(a_arr)) };
}

test("captures all edge data", () => {
  const pathfinder = new PathFinder(geojson, {
      edgeDataReducer: edgeReduce,
      edgeDataSeed: (properties) => ({ id: [properties.id] }),
    }),
    path = pathfinder.findPath(
      point([8.44460166, 59.48947469]),
      point([8.44651, 59.513920000000006])
    );

  expect(path).toBeTruthy();
  expect(path.edgeDatas).toBeTruthy();
  expect(
    path.edgeDatas.some(function (e) {
      return e.id.indexOf(2001) > -1;
    })
  ).toBeTruthy();
});

test("finding a path between nodes not in original graph", () => {
  const pathfinder = new PathFinder(geojson, {
      edgeDataReducer: function (a, p) {
        return { id: p.id };
      },
      edgeDataSeed: (properties) => ({ id: properties.id }),
    }),
    path = pathfinder.findPath(point([8.3, 59.3]), point([8.5, 59.6]));

  expect(path).toBeUndefined();
});

test("can route through large, complex one-way network", () => {
  const pathfinder = new PathFinder(largeNetwork, {
    weight: osmWeight,
    tolerance: 1e-9,
  });
  const path = pathfinder.findPath(
    point([11.9954516, 57.7125743]),
    point([11.9608099, 57.6808616])
  );
  expect(path).toBeTruthy();
  expect(path.path).toBeTruthy();
  expect(path.weight).toBeGreaterThan(0);
});

test("findPath maps 2D start and finish onto 3D vertices", () => {
  const pathfinder = new PathFinder(linestring3d);
  const path = pathfinder.findPath(point([0, 0]), point([2, 0]));

  expect(path).toBeTruthy();
  expect(path?.path).toEqual([
    [0, 0, 0],
    [1, 0, 5],
    [2, 0, 10],
  ]);
});

test("A* finds the same route as Dijkstra on a simple network", () => {
  const network = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [2, 0],
            [2, 1],
            [2, 2],
          ],
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [1, 1],
            [2, 2],
          ],
        },
      },
    ],
  };

  const start = point([0, 0]);
  const end = point([2, 2]);
  const pathfinder = new PathFinder(network);

  const dijkstraPath = pathfinder.findPath(start, end);
  const astarPath = pathfinder.findPath(start, end, { algorithm: "astar" });

  expect(dijkstraPath).toBeTruthy();
  expect(astarPath).toBeTruthy();
  expect(astarPath).toEqual(dijkstraPath);
});

test.skip("A* expands fewer nodes than Dijkstra on a complex network", () => {
  const pathfinder = new PathFinder(geojson);
  const start = point([8.44460166, 59.48947469]);
  const end = point([8.44651, 59.513920000000006]);

  let dijkstraExpansions = 0;
  const dijkstraPath = pathfinder.findPath(start, end, {
    onNodeExpanded: () => {
      dijkstraExpansions += 1;
    },
  });

  let astarExpansions = 0;
  const astarPath = pathfinder.findPath(start, end, {
    algorithm: "astar",
    onNodeExpanded: () => {
      astarExpansions += 1;
    },
  });

  expect(dijkstraPath).toBeTruthy();
  expect(astarPath).toBeTruthy();
  expect(astarPath).toEqual(dijkstraPath);
  expect(astarExpansions).toBeLessThan(dijkstraExpansions);
});
