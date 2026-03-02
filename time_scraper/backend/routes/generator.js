const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const BoundaryGenerator = require('../../src/city-generator/boundary-generator');
const PointsGenerator = require('../../src/city-generator/points-generator');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '../..');

/**
 * POST /api/generator/generate
 * Generate city boundary + sampling points
 */
router.post('/generate', async (req, res) => {
  try {
    const { cityName, cellSize = 2000, lloydIterations = 10, bbox } = req.body;

    if (!cityName) {
      return res.status(400).json({ success: false, message: 'cityName is required' });
    }

    // Step 1: Fetch boundary from Overpass API
    const boundaryGen = new BoundaryGenerator();
    const boundary = await boundaryGen.fetchCityBoundary(cityName, { bbox });

    // Step 2: Generate sampling points
    const pointsGen = new PointsGenerator(boundary, {
      cellSize,
      lloydIterations,
      bbox
    });
    await pointsGen.init();
    const numPoints = pointsGen.calculateNumPoints();
    const points = pointsGen.generate(numPoints);

    // Step 3: Save files (same format as CLI)
    const sanitizedName = cityName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const outputDir = path.join(PROJECT_ROOT, 'data', sanitizedName);
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Boundary GeoJSON
    const boundaryPath = path.join(outputDir, `${sanitizedName}_boundary.geojson`);
    await fsPromises.writeFile(boundaryPath, JSON.stringify(boundary, null, 2));

    // Points JSON
    const jsonPath = path.join(outputDir, `${sanitizedName}_points.json`);
    await fsPromises.writeFile(jsonPath, JSON.stringify(points, null, 2));

    // Points CSV
    const csvPath = path.join(outputDir, `${sanitizedName}_points.csv`);
    const csvContent = 'latitude,longitude\n' + points.map(p => `${p.lat},${p.lng}`).join('\n');
    await fsPromises.writeFile(csvPath, csvContent);

    // Points GeoJSON
    const { getTurf } = require('../../src/city-generator/turf-loader');
    const turf = await getTurf();
    const features = points.map(p => turf.point([p.lng, p.lat]));
    const pointsGeojson = turf.featureCollection(features);
    const geojsonPath = path.join(outputDir, `${sanitizedName}_points.geojson`);
    await fsPromises.writeFile(geojsonPath, JSON.stringify(pointsGeojson, null, 2));

    // Summary
    let polygon = boundary.features?.[0];
    const area = polygon ? turf.area(polygon) : 0;
    const bboxResult = polygon ? turf.bbox(polygon) : [0, 0, 0, 0];

    const summary = {
      city: cityName,
      timestamp: new Date().toISOString(),
      params: { cellSize, lloydIterations },
      boundary: {
        area_km2: parseFloat((area / 1000000).toFixed(2)),
        bbox: bboxResult
      },
      points: {
        count: points.length,
        density_per_km2: parseFloat((points.length / (area / 1000000)).toFixed(2))
      },
      files: {
        boundary: `${sanitizedName}_boundary.geojson`,
        points_json: `${sanitizedName}_points.json`,
        points_csv: `${sanitizedName}_points.csv`,
        points_geojson: `${sanitizedName}_points.geojson`
      }
    };
    const summaryPath = path.join(outputDir, `${sanitizedName}_summary.json`);
    await fsPromises.writeFile(summaryPath, JSON.stringify(summary, null, 2));

    res.json({
      success: true,
      data: {
        boundary,
        points,
        summary,
        outputDir: `data/${sanitizedName}`,
        pointsFile: `data/${sanitizedName}/${sanitizedName}_points.csv`
      }
    });
  } catch (error) {
    console.error('[Generator] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/generator/data/:cityDir
 * Get previously generated data for a city
 */
router.get('/data/:cityDir', async (req, res) => {
  try {
    const { cityDir } = req.params;
    const dataDir = path.join(PROJECT_ROOT, 'data', cityDir);

    if (!fs.existsSync(dataDir)) {
      return res.status(404).json({ success: false, message: 'City data not found' });
    }

    // Find summary file
    const files = await fsPromises.readdir(dataDir);
    const summaryFile = files.find(f => f.endsWith('_summary.json'));
    const boundaryFile = files.find(f => f.endsWith('_boundary.geojson'));
    const pointsFile = files.find(f => f.endsWith('_points.json'));

    if (!summaryFile || !boundaryFile || !pointsFile) {
      return res.status(404).json({ success: false, message: 'Incomplete city data' });
    }

    const summary = JSON.parse(await fsPromises.readFile(path.join(dataDir, summaryFile), 'utf8'));
    const boundary = JSON.parse(await fsPromises.readFile(path.join(dataDir, boundaryFile), 'utf8'));
    const points = JSON.parse(await fsPromises.readFile(path.join(dataDir, pointsFile), 'utf8'));

    const csvFile = files.find(f => f.endsWith('_points.csv'));

    res.json({
      success: true,
      data: {
        boundary,
        points,
        summary,
        outputDir: `data/${cityDir}`,
        pointsFile: csvFile ? `data/${cityDir}/${csvFile}` : null
      }
    });
  } catch (error) {
    console.error('[Generator] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/generator/cities
 * List all generated city directories
 */
router.get('/cities', async (req, res) => {
  try {
    const dataDir = path.join(PROJECT_ROOT, 'data');
    if (!fs.existsSync(dataDir)) {
      return res.json({ success: true, cities: [] });
    }

    const entries = await fsPromises.readdir(dataDir, { withFileTypes: true });
    const cities = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(dataDir, entry.name);
      const dirFiles = await fsPromises.readdir(dirPath);
      const hasSummary = dirFiles.some(f => f.endsWith('_summary.json'));
      const hasPoints = dirFiles.some(f => f.endsWith('_points.csv'));

      if (hasSummary && hasPoints) {
        try {
          const summaryFile = dirFiles.find(f => f.endsWith('_summary.json'));
          const summary = JSON.parse(await fsPromises.readFile(path.join(dirPath, summaryFile), 'utf8'));
          cities.push({
            dir: entry.name,
            city: summary.city,
            pointCount: summary.points?.count,
            area_km2: summary.boundary?.area_km2,
            generatedAt: summary.timestamp
          });
        } catch (e) {
          // Skip directories with invalid summary
        }
      }
    }

    res.json({ success: true, cities });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
