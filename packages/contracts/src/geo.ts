import { z } from "zod";
import { LIMITS } from "./limits";

export const latitudeSchema = z
  .number({ message: "Latitude must be a number" })
  .refine(Number.isFinite, { message: "Latitude must be finite" })
  .refine((v) => v >= -90 && v <= 90, { message: "Latitude must be between -90 and 90" });

export const longitudeSchema = z
  .number({ message: "Longitude must be a number" })
  .refine(Number.isFinite, { message: "Longitude must be finite" })
  .refine((v) => v >= -180 && v <= 180, { message: "Longitude must be between -180 and 180" });

export const coordinatesSchema = z.strictObject({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});
export type Coordinates = z.infer<typeof coordinatesSchema>;

/** [west, south, east, north] in degrees. Antimeridian-crossing boxes are not supported. */
export const bboxSchema = z
  .tuple([longitudeSchema, latitudeSchema, longitudeSchema, latitudeSchema])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: "Bounding box must have west < east and south < north",
  })
  .refine(
    ([west, south, east, north]) =>
      east - west <= LIMITS.maxBboxSpanDegrees && north - south <= LIMITS.maxBboxSpanDegrees,
    { message: `Bounding box may span at most ${LIMITS.maxBboxSpanDegrees} degrees per axis` },
  );
export type BBox = [west: number, south: number, east: number, north: number];

export function bboxContains(bbox: BBox, point: Coordinates): boolean {
  const [west, south, east, north] = bbox;
  return (
    point.longitude >= west &&
    point.longitude <= east &&
    point.latitude >= south &&
    point.latitude <= north
  );
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
