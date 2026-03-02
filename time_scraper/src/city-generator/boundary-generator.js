/**
 * City Boundary Generator
 * Generates GeoJSON boundary for a city using Overpass API (OpenStreetMap data)
 */

const https = require('https');
const http = require('http');
const fs = require('fs').promises;

class BoundaryGenerator {
  constructor() {
    this.overpassUrl = 'https://overpass-api.de/api/interpreter';
  }

  /**
   * Fetch city boundary from Overpass API
   * @param {string} cityName - City name (e.g., "Singapore", "Tokyo, Japan")
   * @returns {Promise<Object>} GeoJSON object
   */
  async fetchCityBoundary(cityName, options = {}) {
    console.log(`Fetching boundary for: ${cityName}`);

    // Generate alternative city names
    const cityVariants = this._generateCityVariants(cityName);
    console.log(`City variants to try: ${cityVariants.join(', ')}`);

    // Get bbox constraint if specified
    const bbox = options.bbox;
    const bboxStr = bbox ? `[bbox:${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}]` : '';

    // Try multiple query strategies
    const queries = [];

    for (const variant of cityVariants) {
      queries.push(
        // Strategy 1: Exact name match with bbox
        `
        [out:json][timeout:60]${bboxStr};
        (
          relation["name"="${variant}"]["boundary"="administrative"];
        );
        out geom;
        `,
        // Strategy 2: Case-insensitive search with bbox
        `
        [out:json][timeout:60]${bboxStr};
        (
          relation["name"~"^${variant}$",i]["boundary"="administrative"];
        );
        out geom;
        `,
        // Strategy 3: English name match with bbox
        `
        [out:json][timeout:60]${bboxStr};
        (
          relation["name:en"="${variant}"]["boundary"="administrative"];
        );
        out geom;
        `,
        // Strategy 4: Admin level 8 (ward/district level) with name search
        `
        [out:json][timeout:60]${bboxStr};
        (
          relation["name"~"${variant}",i]["admin_level"="8"]["boundary"="administrative"];
        );
        out geom;
        `
      );
    }

    let lastError = null;

    for (let i = 0; i < queries.length; i++) {
      try {
        console.log(`Trying query strategy ${i + 1}/${queries.length}...`);
        const data = await this._queryOverpass(queries[i]);
        const geojson = this._convertToGeoJSON(data);
        console.log(`Success with strategy ${i + 1}`);
        return geojson;
      } catch (error) {
        lastError = error;
        // Only log every 4th failure to reduce noise
        if (i % 4 === 3) {
          console.log(`Strategies ${i - 2}-${i + 1} failed`);
        }
      }
    }

    throw lastError || new Error('All query strategies failed');
  }

  /**
   * Generate alternative city name variants
   * @private
   */
  _generateCityVariants(cityName) {
    const variants = [cityName];

    // Remove country suffix
    const baseName = cityName.split(',')[0].trim();
    if (baseName !== cityName) {
      variants.push(baseName);
    }

    // Special cases for major cities
    const specialCases = {
      'Tokyo': ['東京23区', 'Tokyo 23 wards', 'Special wards of Tokyo'],
      'Singapore': ['Republic of Singapore'],
      'Hong Kong': ['香港 Hong Kong', 'Hongkong', '香港'],
      'Hongkong': ['Hong Kong', '香港 Hong Kong', '香港'],
      'New York': ['New York City'],
      'Los Angeles': ['Los Angeles County'],
      'Beijing': ['北京市', 'Beijing Municipality'],
      'Shanghai': ['上海市', 'Shanghai Municipality']
    };

    for (const [key, alternatives] of Object.entries(specialCases)) {
      if (baseName.toLowerCase().includes(key.toLowerCase())) {
        variants.push(...alternatives);
      }
    }

    return [...new Set(variants)]; // Remove duplicates
  }

  /**
   * Query Overpass API
   * @private
   */
  _queryOverpass(query) {
    return new Promise((resolve, reject) => {
      const postData = `data=${encodeURIComponent(query)}`;
      const url = new URL(this.overpassUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 60000
      };

      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse Overpass response'));
            }
          } else {
            reject(new Error(`Overpass API returned status ${res.statusCode}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(e);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Convert Overpass data to GeoJSON
   * @private
   */
  _convertToGeoJSON(overpassData) {
    if (!overpassData.elements || overpassData.elements.length === 0) {
      throw new Error('No boundary data found');
    }

    const features = [];

    for (const element of overpassData.elements) {
      if (element.type === 'relation' && element.members) {
        const coordinates = this._extractCoordinates(element);
        if (coordinates.length > 0) {
          features.push({
            type: 'Feature',
            properties: {
              name: element.tags?.name || 'Unknown',
              admin_level: element.tags?.admin_level,
              osm_id: element.id
            },
            geometry: {
              type: coordinates.length === 1 ? 'Polygon' : 'MultiPolygon',
              coordinates: coordinates.length === 1 ? coordinates[0] : coordinates
            }
          });
        }
      } else if (element.type === 'area' && element.geometry) {
        // Handle area elements
        const coords = element.geometry.map(node => [node.lon, node.lat]);
        if (coords.length > 3) {
          coords.push(coords[0]); // Close the polygon
          features.push({
            type: 'Feature',
            properties: {
              name: element.tags?.name || 'Unknown',
              osm_id: element.id
            },
            geometry: {
              type: 'Polygon',
              coordinates: [coords]
            }
          });
        }
      }
    }

    if (features.length === 0) {
      throw new Error('Could not extract valid geometry from boundary data');
    }

    // If multiple features, try to merge them
    if (features.length > 1) {
      console.log(`Found ${features.length} features, attempting to merge...`);
      try {
        const turf = require('@turf/turf');
        let merged = features[0];
        for (let i = 1; i < features.length; i++) {
          try {
            const union = turf.union(turf.featureCollection([merged, features[i]]));
            if (union) {
              merged = union;
            }
          } catch (e) {
            console.warn(`Failed to merge feature ${i}: ${e.message}`);
          }
        }

        // Update properties to reflect merged result
        merged.properties = {
          name: features[0].properties.name,
          admin_level: features[0].properties.admin_level,
          osm_id: 'merged',
          merged_count: features.length
        };

        return {
          type: 'FeatureCollection',
          features: [merged]
        };
      } catch (error) {
        console.warn(`Merge failed, returning individual features: ${error.message}`);
      }
    }

    return {
      type: 'FeatureCollection',
      features: features
    };
  }

  /**
   * Extract coordinates from relation element
   * @private
   */
  _extractCoordinates(relation) {
    // Group members by role
    const outerWays = [];
    const innerWays = [];

    for (const member of relation.members) {
      if (member.type === 'way' && member.geometry) {
        const coords = member.geometry.map(node => [node.lon, node.lat]);
        if (member.role === 'outer') {
          outerWays.push(coords);
        } else if (member.role === 'inner') {
          innerWays.push(coords);
        }
      }
    }

    // Assemble outer ways into closed rings
    const outerRings = this._assembleRings(outerWays);

    // Assemble inner ways into closed rings
    const innerRings = this._assembleRings(innerWays);

    if (outerRings.length === 0) {
      return [];
    }

    // Build polygons: each outer ring becomes a polygon
    // Inner rings are assigned to the outer ring that contains them
    const polygons = [];

    for (const outerRing of outerRings) {
      const polygon = [outerRing];

      // Find inner rings that belong to this outer ring
      for (const innerRing of innerRings) {
        if (this._ringContainsRing(outerRing, innerRing)) {
          polygon.push(innerRing);
        }
      }

      polygons.push(polygon);
    }

    return polygons;
  }

  /**
   * Assemble multiple ways into closed rings using Ring Assembly algorithm
   * @private
   */
  _assembleRings(ways) {
    if (ways.length === 0) return [];

    const rings = [];
    const unassigned = ways.map((coords, index) => ({
      coords,
      index,
      used: false
    }));

    while (true) {
      // Find an unused way to start a new ring
      const startWay = unassigned.find(w => !w.used);
      if (!startWay) break;

      startWay.used = true;
      let currentRing = [...startWay.coords];

      // Try to close the ring by finding connecting ways
      let changed = true;
      while (changed && !this._isRingClosed(currentRing)) {
        changed = false;
        const ringStart = currentRing[0];
        const ringEnd = currentRing[currentRing.length - 1];

        for (const way of unassigned) {
          if (way.used) continue;

          const wayStart = way.coords[0];
          const wayEnd = way.coords[way.coords.length - 1];

          // Check if this way can connect to the end of current ring
          if (this._coordsEqual(ringEnd, wayStart)) {
            // Append way (skip first point to avoid duplicate)
            currentRing = currentRing.concat(way.coords.slice(1));
            way.used = true;
            changed = true;
            break;
          } else if (this._coordsEqual(ringEnd, wayEnd)) {
            // Append reversed way
            const reversed = [...way.coords].reverse();
            currentRing = currentRing.concat(reversed.slice(1));
            way.used = true;
            changed = true;
            break;
          } else if (this._coordsEqual(ringStart, wayEnd)) {
            // Prepend way (skip last point to avoid duplicate)
            currentRing = way.coords.slice(0, -1).concat(currentRing);
            way.used = true;
            changed = true;
            break;
          } else if (this._coordsEqual(ringStart, wayStart)) {
            // Prepend reversed way
            const reversed = [...way.coords].reverse();
            currentRing = reversed.slice(0, -1).concat(currentRing);
            way.used = true;
            changed = true;
            break;
          }
        }
      }

      // Ensure the ring is closed
      if (currentRing.length > 3) {
        if (!this._isRingClosed(currentRing)) {
          currentRing.push(currentRing[0]);
        }
        rings.push(currentRing);
      }
    }

    return rings;
  }

  /**
   * Check if two coordinates are equal (with tolerance for floating point)
   * @private
   */
  _coordsEqual(coord1, coord2) {
    const tolerance = 1e-7;
    return Math.abs(coord1[0] - coord2[0]) < tolerance &&
           Math.abs(coord1[1] - coord2[1]) < tolerance;
  }

  /**
   * Check if a ring is closed (first point equals last point)
   * @private
   */
  _isRingClosed(ring) {
    if (ring.length < 4) return false;
    return this._coordsEqual(ring[0], ring[ring.length - 1]);
  }

  /**
   * Check if outer ring contains inner ring (simple point-in-polygon test)
   * @private
   */
  _ringContainsRing(outerRing, innerRing) {
    // Test if the first point of inner ring is inside outer ring
    const testPoint = innerRing[0];
    return this._pointInRing(testPoint, outerRing);
  }

  /**
   * Ray casting algorithm to check if point is inside polygon ring
   * @private
   */
  _pointInRing(point, ring) {
    const x = point[0];
    const y = point[1];
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];

      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  }

  /**
   * Save GeoJSON to file
   */
  async saveToFile(geojson, filepath) {
    await fs.writeFile(filepath, JSON.stringify(geojson, null, 2));
    console.log(`Boundary saved to: ${filepath}`);
  }

  /**
   * Simplify city name for API query
   */
  simplifyName(cityName) {
    // Remove country suffix for better matching
    return cityName.split(',')[0].trim();
  }
}

module.exports = BoundaryGenerator;
