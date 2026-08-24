/**
 * Points Generator
 * Generates evenly distributed sampling points within a city boundary
 * Uses rejection sampling + Lloyd relaxation algorithm
 */

const turf = require('@turf/turf');

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

    // Get the main polygon from the GeoJSON
    this.polygon = this._extractMainPolygon(geojson);
    if (!this.polygon) {
      throw new Error('No valid polygon found in GeoJSON');
    }

    // Apply bbox filter if specified
    if (this.options.bbox) {
      this.polygon = this._clipToBbox(this.polygon, this.options.bbox);
      console.log(`Applied bbox filter: ${this.options.bbox.join(', ')}`);
    }
  }

  /**
   * Extract the main (largest) polygon from GeoJSON
   * @private
   */
  _extractMainPolygon(geojson) {
    if (!geojson.features || geojson.features.length === 0) {
      return null;
    }

    let largestPolygon = null;
    let largestArea = 0;

    for (const feature of geojson.features) {
      let polygon = feature;

      // Ensure we have a feature with geometry
      if (feature.geometry) {
        polygon = feature;
      }

      // Handle MultiPolygon - take the largest part
      if (polygon.geometry.type === 'MultiPolygon') {
        const polygons = polygon.geometry.coordinates.map(coords =>
          turf.polygon(coords)
        );

        for (const poly of polygons) {
          const area = turf.area(poly);
          if (area > largestArea) {
            largestArea = area;
            largestPolygon = poly;
          }
        }
      } else if (polygon.geometry.type === 'Polygon') {
        const area = turf.area(polygon);
        if (area > largestArea) {
          largestArea = area;
          largestPolygon = polygon;
        }
      }
    }

    return largestPolygon;
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
  generate(numPoints = null) {
    if (numPoints === null) {
      numPoints = this.calculateNumPoints();
    }

    console.log(`Generating ${numPoints} points...`);

    // Step 1: Generate random points using rejection sampling
    const initialPoints = this._generateRandomPoints(numPoints);
    console.log(`Generated ${initialPoints.length} initial random points`);

    // Step 2: Apply Lloyd relaxation
    const relaxedPoints = this._lloydRelaxation(initialPoints);
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
  _lloydRelaxation(points) {
    let currentPoints = points;

    for (let iter = 0; iter < this.options.lloydIterations; iter++) {
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

        // Calculate centroids of Voronoi cells clipped by city boundary
        const newPoints = [];

        for (let i = 0; i < voronoiPolygons.features.length; i++) {
          const voronoiCell = voronoiPolygons.features[i];

          try {
            // Clip Voronoi cell with city boundary
            const clipped = turf.intersect(
              turf.featureCollection([voronoiCell, this.polygon])
            );

            if (clipped) {
              // Use centroid of clipped cell
              const centroid = turf.centroid(clipped);

              // Ensure centroid is within boundary
              if (turf.booleanPointInPolygon(centroid, this.polygon)) {
                newPoints.push(centroid);
              } else {
                // If centroid is outside, keep original point
                newPoints.push(currentPoints[i]);
              }
            } else {
              // If no intersection, keep original point
              newPoints.push(currentPoints[i]);
            }
          } catch (e) {
            // If any error occurs, keep original point
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
