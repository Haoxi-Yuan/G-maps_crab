#!/usr/bin/env node

/**
 * City Data Generator - Main Entry Point
 *
 * This tool generates city boundaries and sampling points for use with the
 * Google Maps batch scraper.
 *
 * Usage:
 *   node src/city-generator/index.js --city "Singapore" --output data/singapore
 *   node src/city-generator/index.js --boundary boundary.geojson --points 500 --output data/output
 */

const fs = require('fs').promises;
const path = require('path');
const BoundaryGenerator = require('./boundary-generator');
const PointsGenerator = require('./points-generator');

class CityDataGenerator {
  constructor(options = {}) {
    this.options = {
      cityName: options.cityName || null,
      boundaryFile: options.boundaryFile || null,
      numPoints: options.numPoints || null,
      cellSize: options.cellSize || 1000,
      minPoints: options.minPoints || 10,
      lloydIterations: options.lloydIterations || 10,
      outputDir: options.outputDir || 'data',
      categoriesFile: options.categoriesFile || 'config/categories.json',
      ...options
    };
  }

  /**
   * Main execution flow
   */
  async run() {
    try {
      console.log('=== City Data Generator ===\n');

      // Step 1: Get or generate boundary
      let boundary;
      let cityName = this.options.cityName;

      if (this.options.boundaryFile) {
        console.log(`Loading boundary from: ${this.options.boundaryFile}`);
        boundary = await this.loadBoundary(this.options.boundaryFile);

        // Extract city name from boundary if available
        if (boundary.features && boundary.features[0]) {
          cityName = boundary.features[0].properties.name || cityName || 'unknown';
        }
      } else if (this.options.cityName) {
        console.log(`Generating boundary for: ${this.options.cityName}`);
        boundary = await this.generateBoundary(this.options.cityName);
        cityName = this.options.cityName;
      } else {
        throw new Error('Please provide either --city or --boundary parameter');
      }

      // Save boundary if generated from city name
      const sanitizedName = this.sanitizeName(cityName);
      const boundaryPath = path.join(this.options.outputDir, `${sanitizedName}_boundary.geojson`);

      if (!this.options.boundaryFile) {
        await this.saveBoundary(boundary, boundaryPath);
      }

      // Step 2: Generate sampling points
      console.log('\nGenerating sampling points...');
      const points = await this.generatePoints(boundary);

      // Step 3: Export points in multiple formats
      await this.exportPoints(points, sanitizedName);

      // Step 4: Generate summary
      await this.generateSummary(cityName, boundary, points);

      console.log('\n=== Generation Complete ===');
      console.log(`\nOutput directory: ${this.options.outputDir}`);
      console.log(`City: ${cityName}`);
      console.log(`Points generated: ${points.length}`);
      console.log(`\nNext steps:`);
      console.log(`1. Review the generated files in ${this.options.outputDir}/`);
      console.log(`2. Use the points file as input for Google Maps scraper`);

    } catch (error) {
      console.error('\nError:', error.message);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  /**
   * Load boundary from GeoJSON file
   */
  async loadBoundary(filepath) {
    const data = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(data);
  }

  /**
   * Generate boundary using Overpass API
   */
  async generateBoundary(cityName) {
    const generator = new BoundaryGenerator();
    return await generator.fetchCityBoundary(cityName, {
      bbox: this.options.bbox
    });
  }

  /**
   * Save boundary to file
   */
  async saveBoundary(boundary, filepath) {
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, JSON.stringify(boundary, null, 2));
    console.log(`Boundary saved to: ${filepath}`);
  }

  /**
   * Generate sampling points
   */
  async generatePoints(boundary) {
    const generator = new PointsGenerator(boundary, {
      cellSize: this.options.cellSize,
      minPoints: this.options.minPoints,
      lloydIterations: this.options.lloydIterations,
      bbox: this.options.bbox
    });

    const numPoints = this.options.numPoints || generator.calculateNumPoints();
    return generator.generate(numPoints);
  }

  /**
   * Export points in multiple formats
   */
  async exportPoints(points, cityName) {
    const outputDir = this.options.outputDir;
    await fs.mkdir(outputDir, { recursive: true });

    // JSON format (for use with scraper)
    const jsonPath = path.join(outputDir, `${cityName}_points.json`);
    await fs.writeFile(jsonPath, JSON.stringify(points, null, 2));
    console.log(`Points saved to: ${jsonPath} (JSON)`);

    // CSV format
    const csvPath = path.join(outputDir, `${cityName}_points.csv`);
    const csvContent = 'latitude,longitude\n' +
      points.map(p => `${p.lat},${p.lng}`).join('\n');
    await fs.writeFile(csvPath, csvContent);
    console.log(`Points saved to: ${csvPath} (CSV)`);

    // GeoJSON format (for visualization)
    const turf = require('@turf/turf');
    const features = points.map(p => turf.point([p.lng, p.lat]));
    const geojson = turf.featureCollection(features);
    const geojsonPath = path.join(outputDir, `${cityName}_points.geojson`);
    await fs.writeFile(geojsonPath, JSON.stringify(geojson, null, 2));
    console.log(`Points saved to: ${geojsonPath} (GeoJSON)`);
  }

  /**
   * Generate summary
   */
  async generateSummary(cityName, boundary, points) {
    const sanitizedName = this.sanitizeName(cityName);
    const outputDir = this.options.outputDir;

    // Calculate statistics
    const turf = require('@turf/turf');
    let polygon;

    if (boundary.features && boundary.features.length > 0) {
      polygon = boundary.features[0];
    } else if (boundary.type === 'Polygon' || boundary.type === 'MultiPolygon') {
      polygon = boundary;
    }

    const area = polygon ? turf.area(polygon) : 0;
    const bbox = polygon ? turf.bbox(polygon) : [0, 0, 0, 0];

    const summary = {
      city: cityName,
      timestamp: new Date().toISOString(),
      boundary: {
        area_km2: (area / 1000000).toFixed(2),
        bbox: bbox
      },
      points: {
        count: points.length,
        density_per_km2: (points.length / (area / 1000000)).toFixed(2)
      },
      files: {
        boundary: `${sanitizedName}_boundary.geojson`,
        points_json: `${sanitizedName}_points.json`,
        points_csv: `${sanitizedName}_points.csv`,
        points_geojson: `${sanitizedName}_points.geojson`
      }
    };

    const summaryPath = path.join(outputDir, `${sanitizedName}_summary.json`);
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`Summary saved to: ${summaryPath}`);
  }

  /**
   * Sanitize city name for file naming
   */
  sanitizeName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--city':
        options.cityName = args[++i];
        break;
      case '--boundary':
        options.boundaryFile = args[++i];
        break;
      case '--points':
        options.numPoints = parseInt(args[++i]);
        break;
      case '--cell-size':
        options.cellSize = parseInt(args[++i]);
        break;
      case '--iterations':
        options.lloydIterations = parseInt(args[++i]);
        break;
      case '--output':
        options.outputDir = args[++i];
        break;
      case '--categories':
        options.categoriesFile = args[++i];
        break;
      case '--bbox':
        // Format: minLng,minLat,maxLng,maxLat
        options.bbox = args[++i].split(',').map(parseFloat);
        break;
      case '--help':
        console.log(`
City Data Generator

Usage:
  node src/city-generator/index.js [options]

Options:
  --city <name>         City name (e.g., "Singapore", "Tokyo, Japan")
  --boundary <file>     Use existing boundary GeoJSON file
  --points <number>     Number of points to generate (auto-calculated if not specified)
  --cell-size <meters>  Cell size for calculating point density (default: 1000)
  --iterations <number> Lloyd relaxation iterations (default: 10)
  --output <dir>        Output directory (default: data)
  --categories <file>   Categories config file (default: config/categories.json)
  --bbox <coords>       Bounding box to clip boundary (format: minLng,minLat,maxLng,maxLat)
  --help                Show this help message

Examples:
  # Generate boundary and points for Singapore
  node src/city-generator/index.js --city "Singapore" --output data/singapore

  # Use existing boundary file
  node src/city-generator/index.js --boundary boundary.geojson --points 500 --output data/output

  # Custom cell size and iterations
  node src/city-generator/index.js --city "Tokyo, Japan" --cell-size 500 --iterations 15 --output data/tokyo

  # Clip to bounding box (e.g., Tokyo metropolitan area only, excluding islands)
  node src/city-generator/index.js --city "Tokyo" --bbox 139.0,35.3,140.2,36.0 --output data/tokyo
`);
        process.exit(0);
        break;
    }
  }

  if (!options.cityName && !options.boundaryFile) {
    console.error('Error: Please provide either --city or --boundary parameter');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  const generator = new CityDataGenerator(options);
  generator.run().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = CityDataGenerator;
