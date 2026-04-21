/**
 * Points Generator
 * Generates evenly distributed sampling points within a city boundary
 * Uses rejection sampling + Lloyd relaxation algorithm
 */

const { getTurf } = require('./turf-loader');

let turf = null;

class PointsGenerator {
  /**
   * @param {Object} geojson - GeoJSON FeatureCollection containing city boundary
   * @param {Object} options - Configuration options
   */
  constructor(geojson, options = {}) {
    this.geojson = geojson;
    this.options = {
      cellSize: options.cellSize || 1000, // meters, for calculating number of points
      minPoints: options.minPoints || 10,
      lloydIterations: options.lloydIterations || 10,
      bbox: options.bbox || null, // Optional bounding box [minLng, minLat, maxLng, maxLat]
      ...options
    };
    this.polygon = null;
  }

  async init() {
    turf = await getTurf();

    // Collect the whole boundary (all sub-polygons) — cities like Amsterdam
    // are a MultiPolygon with disjoint pieces, and we want sampling points
    // in every piece, not just the largest.
    this.polygon = this._extractBoundaryFeature(this.geojson);
    if (!this.polygon) {
      throw new Error('No valid polygon found in GeoJSON');
    }

    // Apply bbox filter if specified
    if (this.options.bbox) {
      this.polygon = this._clipToBbox(this.polygon, this.options.bbox);
      console.log(`Applied bbox filter: ${this.options.bbox.join(', ')}`);
    }
    return this;
  }

  /**
   * Return a single Feature covering the entire boundary. If the source has
   * multiple Polygon features, or a MultiPolygon with N rings, they're all
   * merged into one MultiPolygon so downstream steps see the full area.
   * @private
   */
  _extractBoundaryFeature(geojson) {
    if (!geojson.features || geojson.features.length === 0) return null;

    const polyCoords = []; // each entry is one polygon's ring-array
    for (const feature of geojson.features) {
      const geom = feature && feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        polyCoords.push(geom.coordinates);
      } else if (geom.type === 'MultiPolygon') {
        for (const rings of geom.coordinates) polyCoords.push(rings);
      }
    }
    if (polyCoords.length === 0) return null;
    if (polyCoords.length === 1) {
      return turf.polygon(polyCoords[0]);
    }
    const pieces = polyCoords.map((rings) => turf.area(turf.polygon(rings)));
    const totalKm2 = (pieces.reduce((a, b) => a + b, 0) / 1e6).toFixed(2);
    console.log(
      `Boundary has ${polyCoords.length} disjoint polygons (combined ${totalKm2} km²); ` +
      `sampling all of them.`
    );
    return turf.multiPolygon(polyCoords);
  }

  /**
   * Calculate number of points based on area
   */
  calculateNumPoints() {
    const area = turf.area(this.polygon); // in square meters
    const cellArea = this.options.cellSize * this.options.cellSize;
    const numPoints = Math.floor(area / cellArea);
    return Math.max(numPoints, this.options.minPoints);
  }

  /**
   * Generate evenly distributed points
   * @param {number} numPoints - Number of points to generate (optional)
   * @returns {Array} Array of point objects with {lat, lng}
   */
  generate(numPoints = null, onProgress = null) {
    if (numPoints === null) {
      numPoints = this.calculateNumPoints();
    }

    console.log(`Generating ${numPoints} points...`);

    // Step 1: Generate random points using rejection sampling
    const initialPoints = this._generateRandomPoints(numPoints);
    console.log(`Generated ${initialPoints.length} initial random points`);

    // Step 2: Apply Lloyd relaxation
    const relaxedPoints = this._lloydRelaxation(initialPoints, onProgress);
    console.log(`Applied Lloyd relaxation (${this.options.lloydIterations} iterations)`);

    return relaxedPoints;
  }

  /**
   * Generate random points within polygon using rejection sampling
   * @private
   */
  _generateRandomPoints(numPoints) {
    const bbox = turf.bbox(this.polygon);
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const points = [];

    let attempts = 0;
    const maxAttempts = numPoints * 100; // Prevent infinite loop

    while (points.length < numPoints && attempts < maxAttempts) {
      const lng = minLng + Math.random() * (maxLng - minLng);
      const lat = minLat + Math.random() * (maxLat - minLat);
      const point = turf.point([lng, lat]);

      if (turf.booleanPointInPolygon(point, this.polygon)) {
        points.push(point);
      }

      attempts++;
    }

    if (points.length < numPoints) {
      console.warn(`Only generated ${points.length}/${numPoints} points after ${maxAttempts} attempts`);
    }

    return points;
  }

  /**
   * Apply Lloyd relaxation to make points more evenly distributed
   * @private
   */
  _lloydRelaxation(points, onProgress = null) {
    let currentPoints = points;

    for (let iter = 0; iter < this.options.lloydIterations; iter++) {
      if (onProgress) {
        onProgress(iter + 1, this.options.lloydIterations);
      }
      try {
        // Create Voronoi diagram
        const pointsCollection = turf.featureCollection(currentPoints);
        const bbox = turf.bbox(this.polygon);

        // Voronoi needs a bbox that's slightly larger
        const padding = 0.1;
        const expandedBbox = [
          bbox[0] - padding,
          bbox[1] - padding,
          bbox[2] + padding,
          bbox[3] + padding
        ];

        const voronoiPolygons = turf.voronoi(pointsCollection, { bbox: expandedBbox });

        if (!voronoiPolygons || !voronoiPolygons.features) {
          console.warn(`Lloyd iteration ${iter + 1}: Voronoi generation failed`);
          break;
        }

        // Move each point toward its Voronoi cell centroid, constrained to boundary
        const newPoints = [];

        for (let i = 0; i < voronoiPolygons.features.length; i++) {
          const voronoiCell = voronoiPolygons.features[i];

          try {
            // Use Voronoi cell centroid directly (fast, avoids expensive intersect)
            const centroid = turf.centroid(voronoiCell);

            // If centroid is inside boundary, use it; otherwise keep original
            if (turf.booleanPointInPolygon(centroid, this.polygon)) {
              newPoints.push(centroid);
            } else {
              newPoints.push(currentPoints[i]);
            }
          } catch (e) {
            newPoints.push(currentPoints[i]);
          }
        }

        if (newPoints.length > 0) {
          currentPoints = newPoints;
        } else {
          console.warn(`Lloyd iteration ${iter + 1}: No valid points generated`);
          break;
        }
      } catch (error) {
        console.warn(`Lloyd iteration ${iter + 1} failed:`, error.message);
        break;
      }
    }

    // Convert to simple {lat, lng} format
    return currentPoints.map(point => ({
      lat: point.geometry.coordinates[1],
      lng: point.geometry.coordinates[0]
    }));
  }

  /**
   * Clip polygon to bounding box
   * @private
   */
  _clipToBbox(polygon, bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const bboxPolygon = turf.bboxPolygon(bbox);

    try {
      const clipped = turf.intersect(turf.featureCollection([polygon, bboxPolygon]));
      if (clipped) {
        return clipped;
      } else {
        console.warn('Bbox clipping resulted in no overlap, using original polygon');
        return polygon;
      }
    } catch (error) {
      console.warn('Bbox clipping failed:', error.message);
      return polygon;
    }
  }

  /**
   * Export points to various formats
   */
  exportPoints(points, format = 'json') {
    switch (format) {
      case 'json':
        return points;

      case 'csv':
        const header = 'latitude,longitude\n';
        const rows = points.map(p => `${p.lat},${p.lng}`).join('\n');
        return header + rows;

      case 'geojson':
        const features = points.map(p =>
          turf.point([p.lng, p.lat])
        );
        return turf.featureCollection(features);

      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }
}

module.exports = PointsGenerator;
