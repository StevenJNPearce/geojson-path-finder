import { expect, test } from "vitest";
import { point } from "@turf/helpers";

import PathFinder from "../src/index";
import geojson from "./network.json";
import linestring3d from "./linestring-3d.json";

test("can create PathFinder", () => {
  const pathfinder = new PathFinder(geojson);
  expect(pathfinder).toBeTruthy();
});

test("rejects paths that require acute turns", () => {
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
            [0.5, 0.5],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network);
  const path = pathfinder.findPath(point([0, 0]), point([0.5, 0.5]));

  expect(path).toBeUndefined();
});

test("allows routes where every turn is obtuse", () => {
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
            [2, 0.5],
          ],
        },
      },
    ],
  };

  const pathfinder = new PathFinder(network);
  const path = pathfinder.findPath(point([0, 0]), point([2, 0.5]));

  expect(path).toBeTruthy();
  const coordinates = path?.path ?? [];
  expect(coordinates.length).toBe(3);

  const [a, b, c] = coordinates;
  const vectorPrev = [a[0] - b[0], a[1] - b[1]];
  const vectorNext = [c[0] - b[0], c[1] - b[1]];
  const dot = vectorPrev[0] * vectorNext[0] + vectorPrev[1] * vectorNext[1];
  expect(dot).toBeLessThan(0);
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
