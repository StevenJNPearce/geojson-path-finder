import { Position } from "geojson";

export default function roundCoord(
  coord: Position,
  tolerance: number
): Position {
  const rounded: Position = [
    Math.round(coord[0] / tolerance) * tolerance,
    Math.round(coord[1] / tolerance) * tolerance,
  ];

  for (let i = 2; i < coord.length; i++) {
    rounded[i] = coord[i];
  }

  return rounded;
}
