/**
 * Boundary Preprocessor
 * Converts incompatible GeoJSON files (projected CRS, LineString geometry)
 * into WGS84 Polygon/MultiPolygon suitable for the points generator.
 */

const proj4 = require('proj4');

// Define common projected CRS
const CRS_DEFINITIONS = {
  'EPSG:25829': '+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25830': '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25831': '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:32629': '+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs',
  'EPSG:32630': '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs',
  'EPSG:3857':  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs',
};

class BoundaryPreprocessor {
  /**
   * Preprocess a GeoJSON object to make it compatible with PointsGenerator.
   * - Detects and reprojects non-WGS84 CRS
   * - Converts LineString/MultiLineString to Polygon by assembling rings
   * @param {Object} geojson - Raw GeoJSON
   * @returns {Object} WGS84 FeatureCollection with Polygon/MultiPolygon
   */
  static async preprocess(geojson) {
    // Step 1: Detect CRS
    const crsCode = this._detectCRS(geojson);
    const needsReprojection = crsCode && crsCode !== 'EPSG:4326';

    if (needsReprojection) {
      console.log(`[Preprocessor] Detected CRS: ${crsCode}, reprojecting to WGS84...`);
    }

    // Step 2: Check geometry types
    const geomTypes = new Set();
    for (const feature of geojson.features || []) {
      if (feature.geometry) {
        geomTypes.add(feature.geometry.type);
      }
    }
    console.log(`[Preprocessor] Geometry types found: ${[...geomTypes].join(', ')}`);

    const hasLines = geomTypes.has('LineString') || geomTypes.has('MultiLineString');
    const hasPolygons = geomTypes.has('Polygon') || geomTypes.has('MultiPolygon');

    // Step 3: Convert to polygons
    let features;
    if (hasLines && !hasPolygons) {
      // Extract all vertices from line segments, reproject, then compute concave/convex hull
      console.log(`[Preprocessor] Extracting vertices from ${geojson.features.length} line features...`);
      const allSegments = this._extractLineSegments(geojson, needsReprojection ? crsCode : null);

      // Collect all unique points
      const allPoints = [];
      for (const seg of allSegments) {
        for (const coord of seg) {
          allPoints.push(coord);
        }
      }
      console.log(`[Preprocessor] Total vertices: ${allPoints.length}`);

      // Subsample if too many points (concave hull is slow with 100k+ points)
      let samplePoints = allPoints;
      if (allPoints.length > 5000) {
        const step = Math.ceil(allPoints.length / 5000);
        samplePoints = allPoints.filter((_, i) => i % step === 0);
        console.log(`[Preprocessor] Subsampled to ${samplePoints.length} points for hull computation`);
      }

      // Build concave hull using turf
      const { getTurf } = require('./turf-loader');
      const turf = getTurf instanceof Function ? await getTurf() : getTurf;
      const pointFeatures = samplePoints.map(c => turf.point(c));
      const pointsFC = turf.featureCollection(pointFeatures);

      // Try concave hull first (tighter fit), fall back to convex hull
      let hull = null;
      try {
        hull = turf.concave(pointsFC, { maxEdge: 50, units: 'kilometers' });
        if (hull) console.log(`[Preprocessor] Concave hull computed successfully`);
      } catch (e) {
        console.log(`[Preprocessor] Concave hull failed: ${e.message}, using convex hull`);
      }
      if (!hull) {
        hull = turf.convex(pointsFC);
        console.log(`[Preprocessor] Convex hull computed`);
      }

      if (!hull) {
        throw new Error('Could not compute boundary hull from line vertices');
      }

      // Strip inner rings (holes) from hull — concave hull can produce
      // spurious holes that cause ring-shaped point distributions
      if (hull.geometry.type === 'Polygon' && hull.geometry.coordinates.length > 1) {
        console.log(`[Preprocessor] Removing ${hull.geometry.coordinates.length - 1} hole(s) from hull`);
        hull.geometry.coordinates = [hull.geometry.coordinates[0]];
      } else if (hull.geometry.type === 'MultiPolygon') {
        hull.geometry.coordinates = hull.geometry.coordinates.map(poly => [poly[0]]);
      }

      hull.properties = { name: 'Boundary hull', source: 'preprocessor' };
      features = [hull];
    } else if (hasPolygons) {
      // Already has polygons, just reproject if needed
      features = geojson.features
        .filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        .map(f => {
          if (needsReprojection) {
            return { ...f, geometry: this._reprojectGeometry(f.geometry, crsCode) };
          }
          return f;
        });
    } else {
      throw new Error(`Unsupported geometry types: ${[...geomTypes].join(', ')}. Need LineString, MultiLineString, Polygon, or MultiPolygon.`);
    }

    // Step 4: Simplify polygons for performance
    // turf.intersect is O(n) per vertex — keep under ~2000 total for reasonable Lloyd speed
    const MAX_VERTICES = 2000;
    const MIN_HOLE_VERTICES = 10; // Drop tiny holes
    for (const feature of features) {
      const coords = feature.geometry.coordinates;
      let totalVerts = 0;
      for (const ring of coords) totalVerts += ring.length;

      // Remove small holes (keep outer ring [0] always)
      if (coords.length > 1) {
        const outerArea = Math.abs(this._ringArea(coords[0]));
        const kept = [coords[0]];
        for (let i = 1; i < coords.length; i++) {
          const holeArea = Math.abs(this._ringArea(coords[i]));
          // Keep hole only if it's >1% of outer area and has enough vertices
          if (coords[i].length >= MIN_HOLE_VERTICES && holeArea > outerArea * 0.01) {
            kept.push(coords[i]);
          }
        }
        const removed = coords.length - kept.length;
        if (removed > 0) {
          console.log(`[Preprocessor] Removed ${removed} small holes (kept ${kept.length - 1})`);
        }
        feature.geometry.coordinates = kept;
      }

      // Recalculate total
      totalVerts = 0;
      for (const ring of feature.geometry.coordinates) totalVerts += ring.length;

      if (totalVerts > MAX_VERTICES) {
        console.log(`[Preprocessor] Simplifying polygon: ${totalVerts} vertices → target ~${MAX_VERTICES}`);
        const tolerance = this._autoTolerance(feature.geometry.coordinates, MAX_VERTICES);
        feature.geometry.coordinates = feature.geometry.coordinates.map(ring =>
          this._simplifyRing(ring, tolerance)
        );
        let newTotal = 0;
        for (const ring of feature.geometry.coordinates) newTotal += ring.length;
        console.log(`[Preprocessor] Simplified to ${newTotal} vertices (tolerance=${tolerance.toFixed(6)})`);
      }
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  /**
   * Detect CRS from GeoJSON metadata
   */
  static _detectCRS(geojson) {
    if (geojson.crs && geojson.crs.properties) {
      const crsName = geojson.crs.properties.name || '';
      // Extract EPSG code from URN like "urn:ogc:def:crs:EPSG::25829"
      const match = crsName.match(/EPSG::?(\d+)/i);
      if (match) {
        return `EPSG:${match[1]}`;
      }
    }

    // Heuristic: check if coordinates look like projected (large values)
    if (geojson.features && geojson.features.length > 0) {
      const firstCoord = this._getFirstCoord(geojson.features[0]);
      if (firstCoord && (Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90)) {
        console.log(`[Preprocessor] Warning: Coordinates look projected but no CRS declared. Assuming EPSG:25829.`);
        return 'EPSG:25829';
      }
    }

    return null; // Assume WGS84
  }

  static _getFirstCoord(feature) {
    const coords = feature.geometry?.coordinates;
    if (!coords) return null;
    let c = coords;
    while (Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][0])) {
      c = c[0];
    }
    if (Array.isArray(c) && Array.isArray(c[0])) {
      return c[0];
    }
    return c;
  }

  /**
   * Extract all line segments, optionally reprojecting
   */
  static _extractLineSegments(geojson, sourceCRS) {
    const segments = [];
    const projDef = sourceCRS ? CRS_DEFINITIONS[sourceCRS] : null;

    for (const feature of geojson.features) {
      const geom = feature.geometry;
      if (!geom) continue;

      let lineArrays = [];
      if (geom.type === 'LineString') {
        lineArrays = [geom.coordinates];
      } else if (geom.type === 'MultiLineString') {
        lineArrays = geom.coordinates;
      } else {
        continue;
      }

      for (const coords of lineArrays) {
        const segment = coords.map(c => {
          if (projDef) {
            const [lng, lat] = proj4(projDef, 'EPSG:4326', [c[0], c[1]]);
            return [lng, lat];
          }
          return [c[0], c[1]];
        });
        if (segment.length >= 2) {
          segments.push(segment);
        }
      }
    }

    return segments;
  }

  /**
   * Assemble line segments into closed rings
   */
  static _assembleRings(segments, tolerance) {
    const rings = [];
    const used = new Array(segments.length).fill(false);

    while (true) {
      // Find an unused segment to start
      const startIdx = used.indexOf(false);
      if (startIdx === -1) break;

      used[startIdx] = true;
      let ring = [...segments[startIdx]];

      let changed = true;
      while (changed && !this._isRingClosed(ring, tolerance)) {
        changed = false;
        const ringEnd = ring[ring.length - 1];
        const ringStart = ring[0];

        for (let i = 0; i < segments.length; i++) {
          if (used[i]) continue;
          const seg = segments[i];
          const segStart = seg[0];
          const segEnd = seg[seg.length - 1];

          if (this._coordsClose(ringEnd, segStart, tolerance)) {
            ring = ring.concat(seg.slice(1));
            used[i] = true;
            changed = true;
            break;
          } else if (this._coordsClose(ringEnd, segEnd, tolerance)) {
            ring = ring.concat([...seg].reverse().slice(1));
            used[i] = true;
            changed = true;
            break;
          } else if (this._coordsClose(ringStart, segEnd, tolerance)) {
            ring = seg.slice(0, -1).concat(ring);
            used[i] = true;
            changed = true;
            break;
          } else if (this._coordsClose(ringStart, segStart, tolerance)) {
            ring = [...seg].reverse().slice(0, -1).concat(ring);
            used[i] = true;
            changed = true;
            break;
          }
        }
      }

      // Close the ring if nearly closed
      if (ring.length >= 4) {
        if (!this._isRingClosed(ring, tolerance)) {
          ring.push(ring[0]);
        }
        // Ensure last == first exactly
        ring[ring.length - 1] = [...ring[0]];
        rings.push(ring);
      }
    }

    return rings;
  }

  static _coordsClose(a, b, tolerance) {
    return Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance;
  }

  static _isRingClosed(ring, tolerance) {
    if (ring.length < 4) return false;
    return this._coordsClose(ring[0], ring[ring.length - 1], tolerance);
  }

  /**
   * Build Polygon features from assembled rings.
   * Largest ring = outer boundary, smaller enclosed rings = holes.
   */
  static _buildPolygonsFromRings(rings) {
    if (rings.length === 0) return [];

    // Calculate ring areas (signed to determine winding)
    const ringData = rings.map((ring, i) => ({
      ring,
      index: i,
      area: Math.abs(this._ringArea(ring))
    }));

    // Sort by area descending (largest first)
    ringData.sort((a, b) => b.area - a.area);

    // Simple strategy: largest ring is the outer boundary
    // Check if smaller rings are inside it (holes)
    const outerRing = ringData[0].ring;

    // Ensure counter-clockwise winding for outer ring (GeoJSON standard)
    const outerCCW = this._ensureCCW(outerRing);
    const polygon = [outerCCW];

    // Check remaining rings - if inside outer, they're holes
    for (let i = 1; i < ringData.length; i++) {
      const testPoint = ringData[i].ring[0];
      if (this._pointInRing(testPoint, outerRing)) {
        // It's a hole - ensure clockwise winding
        polygon.push(this._ensureCW(ringData[i].ring));
      }
    }

    const feature = {
      type: 'Feature',
      properties: { name: 'Converted boundary', source: 'preprocessor' },
      geometry: {
        type: 'Polygon',
        coordinates: polygon
      }
    };

    return [feature];
  }

  static _ringArea(ring) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1];
      area -= ring[i + 1][0] * ring[i][1];
    }
    return area / 2;
  }

  static _ensureCCW(ring) {
    return this._ringArea(ring) < 0 ? [...ring].reverse() : ring;
  }

  static _ensureCW(ring) {
    return this._ringArea(ring) > 0 ? [...ring].reverse() : ring;
  }

  static _pointInRing(point, ring) {
    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Reproject a Polygon or MultiPolygon geometry
   */
  static _reprojectGeometry(geometry, sourceCRS) {
    const projDef = CRS_DEFINITIONS[sourceCRS];
    if (!projDef) {
      throw new Error(`Unknown CRS: ${sourceCRS}. Add its proj4 definition to CRS_DEFINITIONS.`);
    }

    const reprojectCoords = (coords) => {
      if (typeof coords[0] === 'number') {
        const [lng, lat] = proj4(projDef, 'EPSG:4326', [coords[0], coords[1]]);
        return [lng, lat];
      }
      return coords.map(reprojectCoords);
    };

    return {
      type: geometry.type,
      coordinates: reprojectCoords(geometry.coordinates)
    };
  }
  /**
   * Douglas-Peucker line simplification
   */
  static _simplifyRing(ring, tolerance) {
    if (ring.length <= 4) return ring;

    const simplified = this._douglasPeucker(ring, tolerance);

    // Ensure ring stays closed and has minimum 4 points
    if (simplified.length < 4) return ring;
    simplified[simplified.length - 1] = [...simplified[0]];
    return simplified;
  }

  static _douglasPeucker(points, tolerance) {
    if (points.length <= 2) return points;

    let maxDist = 0;
    let maxIdx = 0;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const dist = this._perpendicularDist(points[i], first, last);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance) {
      const left = this._douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
      const right = this._douglasPeucker(points.slice(maxIdx), tolerance);
      return left.slice(0, -1).concat(right);
    }

    return [first, last];
  }

  static _perpendicularDist(point, lineStart, lineEnd) {
    const dx = lineEnd[0] - lineStart[0];
    const dy = lineEnd[1] - lineStart[1];
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      const ex = point[0] - lineStart[0];
      const ey = point[1] - lineStart[1];
      return Math.sqrt(ex * ex + ey * ey);
    }

    const num = Math.abs(dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]);
    return num / Math.sqrt(lenSq);
  }

  /**
   * Auto-calculate tolerance to reduce vertices to target count
   */
  static _autoTolerance(coordinates, targetVerts) {
    // Get bbox extent of the outer ring
    const ring = coordinates[0];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of ring) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
    const extent = Math.max(maxX - minX, maxY - minY);
    let totalVerts = 0;
    for (const r of coordinates) totalVerts += r.length;

    // Start with a fraction of extent, scale by ratio
    return extent * (totalVerts / targetVerts) * 0.0001;
  }
}

module.exports = BoundaryPreprocessor;
